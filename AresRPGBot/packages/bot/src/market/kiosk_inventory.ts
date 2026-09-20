// Reads the bot's own kiosk contents straight from the chain — no dependency on the game
// server's authenticated websocket protocol (which this headless bot never connects to; see
// market_history.ts). Equipped items are structurally absent from this list: equipping SENDS
// the item out of the kiosk to the character's own address, and unequipping is what re-locks it
// there (equipment.move's own module doc) — so anything unlisted here is, by construction, spare
// inventory, never gear a character currently has on.
import { KioskClient } from '@mysten/kiosk'
import { bcs } from '@mysten/sui/bcs'
import type { SuiClientTypes } from '@mysten/sui/client'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import type { ItemSnapshot } from '@aresrpg/sdk/item-snapshot'

import type { BotSdk } from '../auth/sdk_client.ts'
import { is_transient, submit_with_retry } from '../shared/chain_retry.ts'

import { read_kiosk_listings } from './kiosk_listings.ts'

export type SellableItem = ItemSnapshot & Readonly<{ kiosk_id: string }>

const ITEM_TYPE_SUFFIX = '::item::Item'

// The kiosk's Item dynamic-field NAME is `0x2::kiosk::Item { id: ID }` — the item's object id
// rides in that name's BCS, and the item's object TYPE comes from the dynamic field's valueType.
const KIOSK_ITEM_NAME_SUFFIX = '::kiosk::Item'
const kiosk_item_name = bcs.struct('KioskItem', { id: bcs.Address })

const READ_BATCH_SIZE = 48

/** Snapshot built straight from the item object's own JSON — mirrors read_item_snapshot's
 *  availability rule (item_json) minus the per-item dynamic-field reads. Returns null when the
 *  index came back as an error, a package/structure mismatch, or no readable content. */
const snapshot_of = (
  object:
    | Error
    | Readonly<{ objectId?: string; type?: string; json?: Record<string, unknown> | null }>
    | undefined,
  item_id: string,
  type_package: string
): ItemSnapshot | null => {
  if (!object || object instanceof Error || object.objectId !== item_id || object.type !== `${type_package}::item::Item`)
    return null
  const { json } = object
  if (!json) return null
  return Object.freeze({
    id: item_id,
    name: String(json.name),
    item_type: String(json.item_type),
    category: String(json.category),
    level: Number(json.level),
  })
}

/** One ListDynamicFields + getObjects burst per ITEM was the request flood behind the public RPC's
 *  429 storms (ListDynamicFields + BatchGetObjects, observable live) — the item type/name/level a
 *  kiosk listing actually needs all live in the item's own JSON, so the whole kiosk reads in a few
 *  batched getObjects instead. A request-level failure throws (the outer submit_with_retry backs
 *  off instead of half-reading the kiosk); transient per-item errors (429 rate limit) throw to
 *  trigger submit_with_retry backoff; non-transient per-index unavailability resolves to null. */
export const read_snapshots = async (
  client: Readonly<{
    core: Readonly<{
      getObjects: (input: Readonly<{ objectIds: string[]; include: { json: true } }>) => Promise<{
        objects: readonly (
          Error | Readonly<{ objectId?: string; type?: string; json?: Record<string, unknown> | null }>
        )[]
      }>
    }>
  }>,
  type_package: string | null,
  item_ids: readonly string[]
): Promise<(ItemSnapshot | null)[]> => {
  if (!type_package) return item_ids.map(() => null)
  const snapshots: (ItemSnapshot | null)[] = []
  for (let index = 0; index < item_ids.length; index += READ_BATCH_SIZE) {
    const ids = item_ids.slice(index, index + READ_BATCH_SIZE)
    const { objects } = await client.core.getObjects({ objectIds: ids, include: { json: true } })
    ids.forEach((item_id, j) => {
      const obj = objects[j]
      if (obj instanceof Error && is_transient(obj)) {
        throw obj
      }
      snapshots.push(snapshot_of(obj, item_id, type_package))
    })
  }
  return snapshots
}

/** @aresrpg/sdk's SuiTransport (client.ts) is a deliberately narrow structural type covering only
 *  what the SDK itself has needed so far — listDynamicFields is real on both the underlying gRPC
 *  and GraphQL core clients, just not part of that narrowed surface yet. Widened locally rather
 *  than touching the shared package, matching kiosk_listings.ts's own established pattern. */
type CoreWithDynamicFields = {
  listDynamicFields: (
    options: SuiClientTypes.ListDynamicFieldsOptions
  ) => Promise<SuiClientTypes.ListDynamicFieldsResponse>
}

/** Pages a kiosk's dynamic fields and returns the Items inside it as bare (object id, object
 *  type) pairs. Deliberately does NOT use @mysten/kiosk's `getKiosk`: that path reduces every
 *  dynamic field through `parseStructTag(name.type)` and dies in a TypeError on this kiosk's
 *  fields whose `name.type` is missing (live crash 2026-09-15, "type.split is not a function").
 *  Malformed or unexpected fields are skipped here, not fatal — the same stance
 *  read_kiosk_listings takes. Reads the item's object id out of the field-name BCS
 *  (`0x2::kiosk::Item { id: ID }`, an address) and its object TYPE off the field's valueType. */
const read_kiosk_items = async (
  sdk: BotSdk['sdk'],
  kiosk_id: string
): Promise<Readonly<{ id: string; type: string }>[]> => {
  const core = sdk.sui_client.core as unknown as CoreWithDynamicFields
  const dynamicFields: SuiClientTypes.ListDynamicFieldsResponse['dynamicFields'] = []
  let cursor: string | null | undefined
  do {
    const page = await core.listDynamicFields({ parentId: kiosk_id, cursor: cursor ?? undefined })
    dynamicFields.push(...page.dynamicFields)
    cursor = page.hasNextPage ? page.cursor : null
  } while (cursor)

  const items: { id: string; type: string }[] = []
  for (const field of dynamicFields) {
    const name_type = field.name?.type
    if (typeof name_type !== 'string' || !name_type.endsWith(KIOSK_ITEM_NAME_SUFFIX)) continue
    if (!field.name?.bcs) continue
    try {
      const { id } = kiosk_item_name.parse(field.name.bcs)
      items.push({ id: normalizeSuiAddress(id), type: field.valueType })
    } catch {
      // A stray field that LOOKS like a kiosk Item but doesn't parse — skip, never crash.
    }
  }
  return items
}

/** Retry on the read layer: a public-RPC 429 (RESOURCE_EXHAUSTED) is pure backpressure, nothing
 *  changed on-chain, so the whole (idempotent) kiosk read can simply be re-run with the same
 *  backoff submit_with_retry gives transaction submissions — a transient here otherwise surfaces
 *  as an unhandled reject that kills the whole CLI (hit live on the job-farm startup). */
export const read_sellable_items = async (
  bot: BotSdk,
  log: (msg: string) => void = () => {}
): Promise<SellableItem[]> =>
  submit_with_retry(async () => {
    const { sdk, address } = bot
    const kiosk_client = new KioskClient({
      client: sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
      network: sdk.network,
    })
    const { kioskIds } = await kiosk_client.getOwnedKiosks({ address })
    const game_package = sdk.game_type_package
    // Package type identity uses the ORIGINAL package id (client.ts's own note on this) -- an item
    // whose type doesn't start with it is a leftover from a previous deployment (confirmed live
    // 2026-09-06: 16 of 42 kiosk objects predate the last testnet redeploy, same orphaning that hit
    // characters back in party_config.ts). static-typing the type check here avoids the wasted read
    // AND the failure entirely, rather than letting one dead item sink the whole batch below.
    const is_current_package_item = (item: Readonly<{ type: string }>): boolean =>
      item.type.endsWith(ITEM_TYPE_SUFFIX) && (!game_package || item.type.startsWith(game_package))

    // Collect the candidate ids across every owned kiosk FIRST, then ONE batched item read for the
    // whole lot: candidates survive the listing/package filters, unlistable items are dropped in
    // the pair-join below. NOT @mysten/kiosk's getKiosk — that path hunts through every dynamic
    // field with parseStructTag and dies on this kiosk's fields that carry no `name.type` (live
    // crash 2026-09-15: "type.split is not a function"; see read_kiosk_items).
    const candidates = (
      await Promise.all(
        kioskIds.map(async (kiosk_id) => {
          const [items, listings] = await Promise.all([
            read_kiosk_items(sdk, kiosk_id),
            read_kiosk_listings(sdk, kiosk_id),
          ])
          // NOT item.listing -- @mysten/kiosk's getKiosk({ withListingPrices: true }) is unreliable on
          // this kiosk (see kiosk_listings.ts's header). listings (the kiosk's own raw Listing dynamic
          // fields) is ground truth for "is this item actually listed right now."
          return items
            .filter((item) => is_current_package_item(item) && !listings.has(normalizeSuiAddress(item.id)))
            .map((item): { kiosk_id: string; item_id: string } => ({ kiosk_id, item_id: normalizeSuiAddress(item.id) }))
        })
      )
    ).flat()

    if (candidates.length === 0) return []
    const snapshots = await read_snapshots(sdk.sui_client as never, game_package, candidates.map((c) => c.item_id))
    const sellable: SellableItem[] = []
    candidates.forEach((candidate, i) => {
      const snapshot = snapshots[i]
      if (snapshot) sellable.push({ ...snapshot, kiosk_id: candidate.kiosk_id })
    })
    return sellable
  }, log)
