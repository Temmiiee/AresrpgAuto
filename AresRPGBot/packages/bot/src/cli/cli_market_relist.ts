// bun run src/cli/cli_market_relist.ts [--live]
//
// Reprices the bot's ACTIVE HDV listings against what the market is actually asking right now.
// The auto-seller's old price source was its own estimate (item_valuation's level-scaled fallback)
// and its own past listing outcomes — both dead wrong when other players list a type at 100x that
// estimate (live 2026-09-16: a Scrap Hoe asked 4.4 SUI on the HDV while this bot had auto-listed
// its own at 0.02). Default (no flags): read-only — discover open listings, probe live competitor
// asks (market_probe.ts), and print what should be delisted+relisted at which corrected price.
// Pass --live to actually delist the underpriced ones and re-list them at the market reference.
// Only listings that are meaningfully BELOW the market are touched (market_pricing.ts's
// MARKET_ADOPT_RATIO); a listing already at/above the market's cheapest ask stays put.
import { KioskClient } from '@mysten/kiosk'

import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import type { BotSdk } from '../auth/sdk_client.ts'
import { read_kiosk_listings } from '../market/kiosk_listings.ts'
import { live_market_asks } from '../market/market_probe.ts'
import { suggest_market_lot_price_mist } from '../market/market_pricing.ts'
import { execute_auto_sell, reconcile_market_history, type SellDecision } from '../market/auto_sell.ts'
import { is_transient, submit_with_retry } from '../shared/chain_retry.ts'

const MIST_PER_SUI = 1_000_000_000n
const mist_sui = (mist: bigint): string => (Number(mist) / Number(MIST_PER_SUI)).toFixed(4)

type OpenListing = Readonly<{
  item_id: string
  kiosk: string
  current_mist: bigint
  name: string
  item_type: string
  category: string
  amount: number
}>

type Snapshot = Readonly<{ name: string; item_type: string; category: string; amount: number }>

const snapshot_of = (obj: unknown, item_id: string): Snapshot | null => {
  const o = obj as
    | Error
    | Readonly<{ objectId?: string; json?: Record<string, unknown> | null }>
    | undefined
  if (!o || o instanceof Error || o.objectId !== item_id) return null
  const json = o.json
  if (!json || typeof json.item_type !== 'string') return null
  return Object.freeze({
    name: String(json.name ?? json.item_type),
    item_type: String(json.item_type),
    category: String(json.category ?? ''),
    amount: Math.max(1, Number(json.amount ?? 1)),
  })
}

const read_open_listings = async (bot: BotSdk): Promise<OpenListing[]> => {
  const { sdk, address } = bot
  const kiosk_client = new KioskClient({
    client: sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
    network: sdk.network,
  })
  const { kioskIds } = await kiosk_client.getOwnedKiosks({ address })
  const pairs: { item_id: string; kiosk: string; current_mist: bigint }[] = []
  for (const kiosk of kioskIds) {
    const listings = await read_kiosk_listings(sdk, kiosk)
    for (const [item_id, price] of listings) pairs.push({ item_id, kiosk, current_mist: price })
  }
  if (pairs.length === 0) return []

  const open: OpenListing[] = []
  for (let index = 0; index < pairs.length; index += 48) {
    const chunk = pairs.slice(index, index + 48)
    const { objects } = await sdk.sui_client.core.getObjects({
      objectIds: chunk.map((p) => p.item_id),
      include: { json: true },
    })
    chunk.forEach((pair, j) => {
      const obj = objects[j]
      if (obj instanceof Error && is_transient(obj)) throw obj
      const snapshot = snapshot_of(obj, pair.item_id)
      if (snapshot) open.push({ ...pair, ...snapshot })
    })
  }
  return open
}

type Action =
  | { kind: 'relist'; listing: OpenListing; suggested_mist: bigint }
  | { kind: 'keep'; listing: OpenListing }
  | { kind: 'no_market'; listing: OpenListing }

const decide = (listing: OpenListing, market_min_unit: bigint): Action => {
  const suggested = suggest_market_lot_price_mist(listing.current_mist, market_min_unit, listing.amount)
  return suggested > listing.current_mist
    ? { kind: 'relist', listing, suggested_mist: suggested }
    : { kind: 'keep', listing }
}

const main = async () => {
  const live = new Set(process.argv.slice(2)).has('--live')
  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  console.log(`address ${bot.address} — network ${bot.sdk.network}`)

  console.log('\nreconciling past listings…')
  await reconcile_market_history(bot)

  const open = await submit_with_retry(() => read_open_listings(bot), console.log)
  if (open.length === 0) {
    console.log('no active listings in your kiosks.')
    return
  }
  console.log(`probing current HDV asks for ${new Set(open.map((l) => l.item_type)).size} item type(s)…\n`)
  const market = await live_market_asks(bot)

  const actions: Action[] = []
  for (const listing of open) {
    const sample = market.get(listing.item_type)
    if (!sample) {
      actions.push({ kind: 'no_market', listing })
      continue
    }
    actions.push(decide(listing, sample.min_unit_mist))
  }

  const relist = actions.filter((a): a is { kind: 'relist'; listing: OpenListing; suggested_mist: bigint } => a.kind === 'relist')
  const keep = actions.filter((a): a is { kind: 'keep'; listing: OpenListing } => a.kind === 'keep').length
  const no_market = actions.filter((a): a is { kind: 'no_market'; listing: OpenListing } => a.kind === 'no_market').length

  console.log('listing'.padEnd(34) + ' '.padEnd(26) + 'current'.padEnd(12) + 'market min'.padEnd(12) + 'suggested'.padEnd(12) + 'action')
  for (const action of actions) {
    const l = action.listing
    const name = l.name.length > 30 ? `${l.name.slice(0, 29)}…` : l.name
    const market_min = market.get(l.item_type)?.min_unit_mist
    const mk = market_min !== undefined ? mist_sui(market_min) : '—'
    if (action.kind === 'relist') {
      console.log(
        `${name.padEnd(34)}${l.item_type.padEnd(26)}${mist_sui(l.current_mist).padEnd(12)}${mk.padEnd(12)}` +
          `${mist_sui(action.suggested_mist).padEnd(12)}relist`
      )
    } else if (action.kind === 'keep') {
      console.log(`${name.padEnd(34)}${l.item_type.padEnd(26)}${mist_sui(l.current_mist).padEnd(12)}${mk.padEnd(12)}`.padEnd(12) + 'keep')
    } else {
      console.log(`${name.padEnd(34)}${l.item_type.padEnd(26)}${mist_sui(l.current_mist).padEnd(12)}${mk.padEnd(12)}`.padEnd(12) + 'no market data')
    }
  }
  console.log(`\n${relist.length} should be delisted + relisted, ${keep} stay, ${no_market} have no market reference.`)

  if (!live || relist.length === 0) {
    if (!live) console.log('\ndry run — pass --live to delist + relist at the corrected prices.')
    return
  }

  console.log('\ndelisting + relisting…')
  for (const { listing, suggested_mist } of relist) {
    try {
      const { digest } = await bot.marketplace.delist({
        kind: 'item',
        id: listing.item_id,
        kiosk: listing.kiosk,
      })
      console.log(`  delisted ${listing.name} (was ${mist_sui(listing.current_mist)} SUI) — ${digest}`)
    } catch (error) {
      console.log(`  delist ${listing.name} failed (${error instanceof Error ? error.message : error}) — skipped`)
    }
  }

  const decisions: SellDecision[] = relist.map(({ listing, suggested_mist }) => ({
    item_id: listing.item_id,
    item_type: listing.item_type,
    name: listing.name,
    category: listing.category,
    kiosk_id: listing.kiosk,
    price_mist: suggested_mist,
    price_sui: mist_sui(suggested_mist),
    estimated_price: false,
  }))
  const results = await execute_auto_sell(bot, decisions)
  console.log(`\nlisted ${results.length} item(s) at the market reference:`)
  for (const { decision } of results) console.log(`  ${decision.name} — ${decision.price_sui} SUI`)
}

await main()