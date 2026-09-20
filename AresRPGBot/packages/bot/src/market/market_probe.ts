// Live HDV ask sampling, straight off the chain — the one number item_valuation's level-scaled
// fallback never had. Game items are ALL the same Move type (<pkg>::item::Item), but a kiosk
// listing is a generic `0x2::kiosk::ItemListed<T>` event for ANY T, so the public-core event
// filter can't match the game's type server-side (a MoveEventType filter on a generic type is
// rejected); instead we ask for the whole `0x2::kiosk` module's events and keep only those whose
// eventType's type argument IS the game's item. Each kept event already carries its decoded JSON
// (`json`: {id, kiosk, price}), so no indexer or the game server's authenticated websocket is
// needed (see market_history.ts). Prices are normalized to per-unit MIST by reading each listed
// object's own `amount` (kiosk lists a whole stack/lot object; the price is the LOT price, so a
// 10-unit lot must not quote 10x what a 1-unit lot costs).
import { KioskClient } from '@mysten/kiosk'

import type { BotSdk } from '../auth/sdk_client.ts'
import { is_transient, submit_with_retry } from '../shared/chain_retry.ts'

const KIOSK_MODULE = `0x2::kiosk`
const ITEM_TYPE_SUFFIX = '::item::Item'
const READ_BATCH_SIZE = 48
const PAGE_LIMIT = 50
const MAX_EVENTS = 4000
// Probe results are stable at the hours scale (new listings trickle in, but the market's price
// LEVEL for a type barely moves between auto-sell passes) — cache aggressive so the RPC isn't
// re-paged every pass.
const PROBE_TTL_MS = 10 * 60 * 1000

export type MarketSample = Readonly<{
  min_unit_mist: bigint
  median_unit_mist: bigint
  samples: number
}>

// The @aresrpg/sdk transport's core type narrows to what the SDK itself has used so far, but the
// runtime gRPC core DOES expose listEvents (same local-widening convention as kiosk_listings.ts).
type CoreWithListEvents = {
  listEvents: (input: {
    filter: { emitModule: string } | { eventType: string } | { sender: string }
    limit?: number
    after?: string | null
  }) => Promise<{
    events: readonly {
      eventType?: string
      json?: Readonly<Record<string, unknown>> | null
    }[]
    hasNextPage: boolean
    startCursor: string | null
    endCursor: string | null
  }>
}

type ListedJson = Readonly<{ kiosk?: string; id?: string; price?: string | number }>
type AskStub = Readonly<{ item_id: string; price: string | number }>

const probe_cache = new Map<string, { at: number; by_type: ReadonlyMap<string, MarketSample> }>()

/** Cached per-process: probes once, then serves the same market read for PROBE_TTL_MS so the
 *  auto-seller never re-pages the RPC on every pass. */
export const live_market_asks = async (
  bot: BotSdk,
  log: (msg: string) => void = () => {}
): Promise<ReadonlyMap<string, MarketSample>> => {
  const cached = probe_cache.get('asks')
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.by_type
  const samples = await probe_live_asks(bot, log)
  probe_cache.set('asks', { at: Date.now(), by_type: samples })
  return samples
}

/** Pages recent `0x2::kiosk` module events across EVERY kiosk on the network, keeps the game-item
 *  `ItemListed` events, decodes each listing's item + lot amount, and folds the asks down to
 *  per-item_type min/median. The bot's own kiosks are excluded so its own (possibly underpriced)
 *  listings never skew the market read. Throws only on a persistent, non-transient failure; 429
 *  backpressure is handled by submit_with_retry like every other read here. */
const probe_live_asks = async (
  bot: BotSdk,
  log: (msg: string) => void
): Promise<ReadonlyMap<string, MarketSample>> => {
  return submit_with_retry(async () => {
    const { sdk, address } = bot
    const type_package = sdk.game_type_package
    if (!type_package) return new Map()
    const game_item_suffix = `<${type_package}${ITEM_TYPE_SUFFIX}>`

    const kiosk_client = new KioskClient({
      client: sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
      network: sdk.network,
    })
    const { kioskIds } = await kiosk_client.getOwnedKiosks({ address })
    const own_kiosks = new Set(kioskIds)

    const core = sdk.sui_client.core as unknown as CoreWithListEvents
    const asks: AskStub[] = []
    let after: string | null | undefined
    do {
      const page = await core.listEvents({ filter: { emitModule: KIOSK_MODULE }, limit: PAGE_LIMIT, after: after ?? undefined })
      for (const event of page.events) {
        if (asks.length >= MAX_EVENTS) break
        if (typeof event.eventType !== 'string' || !event.eventType.includes(game_item_suffix)) continue
        const json = event.json as ListedJson | undefined
        if (!json || typeof json.kiosk !== 'string' || typeof json.id !== 'string') continue
        if (own_kiosks.has(json.kiosk)) continue
        asks.push({ item_id: json.id, price: json.price ?? 0 })
      }
      after = page.hasNextPage ? page.endCursor : null
    } while (after && asks.length < MAX_EVENTS)

    if (asks.length === 0) return new Map()

    const item_ids = [...new Set(asks.map((a) => a.item_id))]
    const snapshots = await read_snapshots_with_amounts(sdk.sui_client as never, type_package, item_ids)

    const by_id = new Map<string, { item_type: string; amount: number }>()
    item_ids.forEach((item_id, i) => {
      const snapshot = snapshots[i]
      if (snapshot) by_id.set(item_id, snapshot)
    })

    const per_type = new Map<string, bigint[]>()
    for (const event of asks) {
      const info = by_id.get(event.item_id)
      if (!info) continue
      const price = typeof event.price === 'string' ? BigInt(event.price) : BigInt(event.price ?? 0)
      if (price <= 0n) continue
      const amount = Math.max(1, info.amount)
      const unit = price / BigInt(amount)
      const bucket = per_type.get(info.item_type) ?? []
      bucket.push(unit)
      per_type.set(info.item_type, bucket)
    }

    const by_type = new Map<string, MarketSample>()
    for (const [item_type, units] of per_type) {
      if (units.length === 0) continue
      const sorted = [...units].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      by_type.set(
        item_type,
        Object.freeze({
          min_unit_mist: sorted[0]!,
          median_unit_mist: sorted[Math.floor(sorted.length / 2)]!,
          samples: sorted.length,
        })
      )
    }
    return by_type
  }, log)
}

type AmountSnapshot = Readonly<{ item_type: string; amount: number }>

const amount_snapshot_of = (
  object:
    | Error
    | Readonly<{ objectId?: string; type?: string; json?: Record<string, unknown> | null }>
    | undefined,
  item_id: string,
  type_package: string
): AmountSnapshot | null => {
  if (!object || object instanceof Error || object.objectId !== item_id || object.type !== `${type_package}${ITEM_TYPE_SUFFIX}`)
    return null
  const { json } = object
  if (!json || typeof json.item_type !== 'string') return null
  return Object.freeze({
    item_type: String(json.item_type),
    amount: Number(json.amount ?? 1),
  })
}

const read_snapshots_with_amounts = async (
  client: Readonly<{
    core: Readonly<{
      getObjects: (input: Readonly<{ objectIds: string[]; include: { json: true } }>) => Promise<{
        objects: readonly (
          Error | Readonly<{ objectId?: string; type?: string; json?: Record<string, unknown> | null }>
        )[]
      }>
    }>
  }>,
  type_package: string,
  item_ids: readonly string[]
): Promise<(AmountSnapshot | null)[]> => {
  const snapshots: (AmountSnapshot | null)[] = []
  for (let index = 0; index < item_ids.length; index += READ_BATCH_SIZE) {
    const ids = item_ids.slice(index, index + READ_BATCH_SIZE)
    const { objects } = await client.core.getObjects({ objectIds: ids, include: { json: true } })
    ids.forEach((item_id, j) => {
      const obj = objects[j]
      if (obj instanceof Error && is_transient(obj)) throw obj
      snapshots.push(amount_snapshot_of(obj, item_id, type_package))
    })
  }
  return snapshots
}