// Prepares and (optionally) executes HDV listings for the bot's spare kiosk inventory, priced
// adaptively from the item's own past listing outcomes (market_pricing.ts) — the whole pipeline
// works identically on testnet today and on mainnet later; only sdk_client.ts's RPC/network
// picks which chain it touches. Planning is always safe (read-only); execution actually lists
// real items for real SUI, so callers decide when to cross that line.
import { KioskClient } from '@mysten/kiosk'

import { get_item_price } from './item_valuation.ts'
import { read_sellable_items } from './kiosk_inventory.ts'
import { append_listing, read_market_history, resolve_listing, type ListingRecord } from './market_history.ts'
import { suggest_listing_price_mist } from './market_pricing.ts'
import { read_kiosk_listings } from './kiosk_listings.ts'
import type { BotSdk } from '../auth/sdk_client.ts'
import { dungeon_by_slug, key_recipe } from '../shared/dungeon_content.ts'
import { resolve_quest_dungeon_slug } from '../shared/dungeon_read.ts'
import { read_mastery_row } from '../dungeon/mastery_quest.ts'

const MIST_PER_SUI = 1_000_000_000n
// Rounds UP, not to nearest (2026-09-06, project owner request) -- this is the base estimate a
// listing price starts from, so rounding down here would just get compounded by market_pricing.ts's
// own rounding on top.
const mist_of_sui = (sui: number): bigint => BigInt(Math.ceil(sui * Number(MIST_PER_SUI)))
const sui_of_mist = (mist: bigint): string => (Number(mist) / Number(MIST_PER_SUI)).toFixed(4)

export type SellDecision = Readonly<{
  item_id: string
  item_type: string
  name: string
  category: string
  kiosk_id: string
  price_mist: bigint
  price_sui: string
  estimated_price: boolean
}>

/** Read-only: what the auto-seller would list, and at what price, right now. Skips any item
 *  still tied to an open (unresolved) listing record so a re-plan never proposes the same item
 *  twice while it's already up for sale. */
export const plan_auto_sell = async (bot: BotSdk): Promise<SellDecision[]> => {
  const items = await read_sellable_items(bot)
  const history = read_market_history()
  const open_item_ids = new Set(history.filter((record) => record.outcome === null).map((record) => record.listing_id))

  return items
    .filter((item) => !open_item_ids.has(item.id))
    .map((item): SellDecision => {
      const { unit_price_sui, estimated } = get_item_price(item.item_type)
      const base_price_mist = mist_of_sui(unit_price_sui)
      const price_mist = suggest_listing_price_mist(item.item_type, base_price_mist, history)
      return {
        item_id: item.id,
        item_type: item.item_type,
        name: item.name,
        category: item.category,
        kiosk_id: item.kiosk_id,
        price_mist,
        price_sui: sui_of_mist(price_mist),
        estimated_price: estimated,
      }
    })
}

/** Actually lists the given decisions on-chain and records each as an open history entry. */
export const execute_auto_sell = async (
  bot: BotSdk,
  decisions: readonly SellDecision[]
): Promise<readonly Readonly<{ decision: SellDecision; digest: string }>[]> => {
  const results: Readonly<{ decision: SellDecision; digest: string }>[] = []
  for (const decision of decisions) {
    const { digest, listed_id } = await bot.marketplace.list({
      kind: 'item',
      id: decision.item_id,
      kiosk: decision.kiosk_id,
      price_mist: decision.price_mist,
    })
    const listed_at = new Date().toISOString()
    append_listing({
      listing_id: listed_id,
      item_type: decision.item_type,
      kiosk_id: decision.kiosk_id,
      price_mist: decision.price_mist.toString(),
      listed_at,
      resolved_at: null,
      outcome: null,
    })
    results.push({ decision, digest })
  }
  return results
}

// Categories a character actually wears/wields (seed/content/items.json's own category list,
// 2026-09-06) -- kept in sync BY HAND with control_panel_pages.ts's identical client-side copy
// (the browser can't import this server module). Auto-sell never touches these on its own; only
// a human picking them by hand in the control panel's per-item checkboxes can list one.
export const EQUIPMENT_CATEGORIES: ReadonlySet<string> = new Set([
  'cloak', 'hat', 'amulet', 'boots', 'belt', 'ring', 'sword', 'daggers', 'bow', 'spear', 'axe',
  'relic', 'pet', 'title', 'key',
])

/** item_types the party still needs to craft today's dungeon key and shouldn't sell out from
 *  under itself — empty once the quest is completed (or there's no resolvable quest target),
 *  since there's nothing left to save materials for (2026-09-07, project owner: don't sell what
 *  a pending dungeon quest still needs, only afterward). Read-only and cheap (one object read
 *  plus the already-cached dungeon content), safe to call before every sell pass. */
const reserved_for_todays_quest = async (bot: BotSdk): Promise<ReadonlySet<string>> => {
  const mastery = await read_mastery_row(bot, bot.mastery.id)
  if (!mastery || mastery.quest_completed) return new Set()
  const slug = resolve_quest_dungeon_slug(bot.sdk, mastery.quest_dungeon)
  const info = slug ? dungeon_by_slug(slug) : undefined
  if (!info) return new Set()
  const recipe = key_recipe(info.key)
  return new Set(recipe ? Object.keys(recipe) : [])
}

/** Lists every spare NON-equipment item (resources, consumables, runes, tools) on the HDV,
 *  right now, using the SAME bot/signer as whatever else is already running -- meant to be called
 *  from inside the fight session loop itself (2026-09-06, project owner: "on peut faire en sorte
 *  que le bot vende automatiquement ces loots au hdv"), never from a second, separately-signed-in
 *  process. Running it from a concurrent process (e.g. the control panel, alongside an active
 *  session loop) is exactly what produced a listing transaction that reported success but never
 *  actually persisted on-chain -- confirmed live 2026-09-06: 4 "listed" items sat unlisted in the
 *  kiosk minutes later, no Listing dynamic field ever existed for them. Same class of race as the
 *  kiosk::borrow_mut EItemLocked errors from running two session loops at once. */
export const auto_sell_spare_loot = async (
  bot: BotSdk,
  log: (msg: string) => void
): Promise<{ listed: number }> => {
  const reserved = await reserved_for_todays_quest(bot)
  const decisions = (await plan_auto_sell(bot)).filter(
    (d) => !EQUIPMENT_CATEGORIES.has(d.category) && !reserved.has(d.item_type)
  )
  if (reserved.size > 0) log(`auto-sell: holding back ${[...reserved].join(', ')} for today's dungeon quest`)
  if (decisions.length === 0) return { listed: 0 }
  log(`auto-sell: listing ${decisions.length} spare item(s) on the HDV…`)
  const results = await execute_auto_sell(bot, decisions)
  for (const r of results) log(`  listed ${r.decision.name} for ${r.decision.price_sui} SUI`)
  return { listed: results.length }
}

type KioskPresence = 'listed' | 'present_unlisted' | 'absent'

/** Checks every still-open listing against live kiosk state: still listed there → leave open;
 *  present but no longer listed → 'delisted' (removed without this module's own execute path,
 *  e.g. by hand in the game client); absent from the kiosk entirely → 'sold' — the only way a
 *  listed item leaves kiosk custody, since nothing in this codebase delists automatically. */
export const reconcile_market_history = async (bot: BotSdk): Promise<void> => {
  const open = read_market_history().filter((record: ListingRecord) => record.outcome === null)
  if (open.length === 0) return

  const kiosk_client = new KioskClient({
    client: bot.sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
    network: bot.sdk.network,
  })
  const presence_by_kiosk = new Map<string, ReadonlyMap<string, KioskPresence>>()
  for (const kiosk_id of new Set(open.map((record) => record.kiosk_id))) {
    // NOT item.listing -- see kiosk_listings.ts's header (confirmed live: @mysten/kiosk's own
    // listing reporting is unreliable on this kiosk, both over-reporting which items are listed
    // and misreporting their price). listings is the kiosk's own raw Listing dynamic fields.
    const [{ items }, listings] = await Promise.all([
      kiosk_client.getKiosk({ id: kiosk_id, options: { withListingPrices: true } }),
      read_kiosk_listings(bot.sdk, kiosk_id),
    ])
    presence_by_kiosk.set(
      kiosk_id,
      new Map(items.map((item) => [item.objectId, listings.has(item.objectId) ? 'listed' : 'present_unlisted']))
    )
  }

  const resolved_at = new Date().toISOString()
  for (const record of open) {
    const presence = presence_by_kiosk.get(record.kiosk_id)?.get(record.listing_id) ?? 'absent'
    if (presence === 'listed') continue
    resolve_listing(record.listing_id, presence === 'present_unlisted' ? 'delisted' : 'sold', resolved_at)
  }
}
