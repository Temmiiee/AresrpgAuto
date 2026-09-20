// bun run src/cli/cli_hdv_ten_x.ts [--live]
//
// Project-owner request (2026-09-16): delist every ACTIVE HDV listing priced below 1 SUI and
// re-list it at 10x the price it had when delisted. Items already at 1 SUI or more are left
// strictly untouched (not delisted, not repriced).
//
// Default (no flags): read-only — discover active listings, delist-plan the sub-1-SUI ones, and
// print what would delist + relist and at which new price. Pass --live to actually delist and
// re-list (real SUI gas).
//
// Mirrors cli_market_relist.ts's plumbing (kiosk listings straight off the kiosk's own Listing
// dynamic fields, list via execute_auto_sell) so the two CLIs always agree on the ground truth.
import { KioskClient } from '@mysten/kiosk'

import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import type { BotSdk } from '../auth/sdk_client.ts'
import { read_kiosk_listings } from '../market/kiosk_listings.ts'
import { execute_auto_sell, type SellDecision } from '../market/auto_sell.ts'
import { is_transient, submit_with_retry } from '../shared/chain_retry.ts'

const MIST_PER_SUI = 1_000_000_000n
const ONE_SUI_MIST = MIST_PER_SUI
const PPT_X = 10n
const mist_sui = (mist: bigint): string => (Number(mist) / Number(MIST_PER_SUI)).toFixed(4)

type OpenListing = Readonly<{
  item_id: string
  kiosk: string
  current_mist: bigint
  name: string
  item_type: string
  category: string
}>

type Snapshot = Readonly<{ name: string; item_type: string; category: string }>

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

const main = async () => {
  const live = new Set(process.argv.slice(2)).has('--live')
  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  console.log(`address ${bot.address} — network ${bot.sdk.network}`)

  const open = await submit_with_retry(() => read_open_listings(bot), console.log)
  if (open.length === 0) {
    console.log('no active listings in your kiosks.')
    return
  }

  const targeted = open.filter((l) => l.current_mist < ONE_SUI_MIST)
  console.log(
    `\n${open.length} active listing(s) — ${targeted.length} priced under 1 SUI (${open.length - targeted.length} untouched).`
  )
  if (targeted.length === 0) {
    console.log('nothing to delist/re-list.')
    return
  }

  console.log('listing'.padEnd(34) + ' '.padEnd(28) + 'current'.padEnd(12) + '10x'.padEnd(12))
  for (const l of targeted) {
    const name = l.name.length > 30 ? `${l.name.slice(0, 29)}…` : l.name
    console.log(
      `${name.padEnd(34)}${(l.item_type ?? '').padEnd(28)}${mist_sui(l.current_mist).padEnd(12)}` +
        `${mist_sui(l.current_mist * PPT_X).padEnd(12)}`
    )
  }

  if (!live) {
    console.log('\ndry run — pass --live to delist + re-list at 10x the current price.')
    return
  }

  console.log('\ndelisting + re-listing…')
  const decisions: SellDecision[] = []
  for (const l of targeted) {
    try {
      const { digest } = await bot.marketplace.delist({ kind: 'item', id: l.item_id, kiosk: l.kiosk })
      console.log(`  delisted ${l.name} (was ${mist_sui(l.current_mist)} SUI) — ${digest}`)
      decisions.push({
        item_id: l.item_id,
        item_type: l.item_type,
        name: l.name,
        category: l.category,
        kiosk_id: l.kiosk,
        price_mist: l.current_mist * PPT_X,
        price_sui: mist_sui(l.current_mist * PPT_X),
        estimated_price: false,
      })
    } catch (error) {
      console.log(`  delist ${l.name} failed (${error instanceof Error ? error.message : error}) — skipped`)
    }
  }
  if (decisions.length === 0) return

  const results = await execute_auto_sell(bot, decisions)
  console.log(`\nlisted ${results.length} item(s) at 10x their previous price:`)
  for (const { decision } of results) console.log(`  ${decision.name} — ${decision.price_sui} SUI`)
}

await main()