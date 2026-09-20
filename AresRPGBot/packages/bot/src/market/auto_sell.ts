// Prepares and (optionally) executes HDV listings for the bot's spare kiosk inventory, priced
// adaptively from the item's own past listing outcomes (market_pricing.ts) — the whole pipeline
// works identically on testnet today and on mainnet later; only sdk_client.ts's RPC/network
// picks which chain it touches. Planning is always safe (read-only); execution actually lists
// real items for real SUI, so callers decide when to cross that line.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { KioskClient } from '@mysten/kiosk'

import { get_item_price } from './item_valuation.ts'
import { read_sellable_items } from './kiosk_inventory.ts'
import { append_listing, read_market_history, resolve_listing, type ListingRecord } from './market_history.ts'
import { suggest_listing_price_mist, suggest_market_lot_price_mist } from './market_pricing.ts'
import { live_market_asks } from './market_probe.ts'
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

/** Item `amount` per item id — the lot size a kiosk listing prices against. Needed so the live-HDV
 *  reference (a per-UNIT ask) scales to the bot's own stacks (a whole-stack lot). One batched
 *  getObjects; transient per-index errors are dropped (0), non-transient throw like kiosk reads. */
const read_stack_amounts = async (bot: BotSdk, item_ids: readonly string[]): Promise<ReadonlyMap<string, number>> => {
  const amounts = new Map<string, number>()
  for (let index = 0; index < item_ids.length; index += 48) {
    const ids = item_ids.slice(index, index + 48)
    const { objects } = await bot.sdk.sui_client.core.getObjects({ objectIds: ids, include: { json: true } })
    ids.forEach((item_id, j) => {
      const obj = objects[j]
      if (obj instanceof Error) return
      const json = (obj as { json?: { amount?: string | number } } | undefined)?.json
      const amount = Number(json?.amount ?? 1)
      amounts.set(item_id, Number.isFinite(amount) && amount > 0 ? amount : 1)
    })
  }
  return amounts
}

// Every item_type any craft recipe in seed/content/recipes.json consumes as an input. Gathering
// materials AND mob drops both feed the métier craft passes (farm_engine turns them into job xp),
// so the auto-seller must never list one — including chain products that are themselves inputs of
// a further recipe (flours, hides, scales…). Outputs with no downstream consumer stay sellable.
const RECIPES_PATH = fileURLToPath(new URL('../../../../seed/content/recipes.json', import.meta.url))
const CRAFT_INGREDIENTS: ReadonlySet<string> = new Set(
  (JSON.parse(readFileSync(RECIPES_PATH, 'utf8')) as { inputs: Record<string, number> }[]).flatMap((r) =>
    Object.keys(r.inputs)
  )
)

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

/** Read-only: what the auto-seller WOULD list if run right now, and at what price, over the
 *  account's WHOLE unlisted spare inventory — raw: no keep-policy applied (equipment, quest
 *  materials and craft ingredients are still shown here). plan_spare_loot() applies that policy
 *  on top; the control panel review + per-item checkboxes consume THIS raw view by design. Skips
 *  any item still tied to an open (unresolved) listing record so a re-plan never proposes the same
 *  item twice while it's already up for sale. Prices are quoted from the LIVE HDV when the market
 *  has an ask for the type (market_probe.ts), falling back to the estimate pipeline otherwise. */
export const plan_auto_sell = async (bot: BotSdk): Promise<SellDecision[]> => {
  const items = await read_sellable_items(bot)
  const history = read_market_history()
  const open_item_ids = new Set(history.filter((record) => record.outcome === null).map((record) => record.listing_id))

  const market = await live_market_asks(bot)
  const amounts = await read_stack_amounts(bot, items.map((item) => item.id))

  return items
    .filter((item) => !open_item_ids.has(item.id))
    .map((item): SellDecision => {
      const { unit_price_sui, estimated } = get_item_price(item.item_type)
      const base_price_mist = mist_of_sui(unit_price_sui)
      const price_mist = suggest_listing_price_mist(item.item_type, base_price_mist, history)
      const market_sample = market.get(item.item_type)
      const market_price_mist =
        market_sample && price_mist > 0n
          ? suggest_market_lot_price_mist(price_mist, market_sample.min_unit_mist, amounts.get(item.id) ?? 1)
          : price_mist
      return {
        item_id: item.id,
        item_type: item.item_type,
        name: item.name,
        category: item.category,
        kiosk_id: item.kiosk_id,
        price_mist: market_price_mist,
        price_sui: sui_of_mist(market_price_mist),
        estimated_price: estimated,
      }
    })
}

/** Actually lists the given decisions on-chain and records each as an open history entry.
 *  Listings are batched with marketplace.list_many (one PTB per chunk — the 200-check spare-loot
 *  pass goes from ~200 signed txs to ~10), chunked by kiosk with a per-item fallback: a batch is
 *  all-or-nothing, so one already-listed item must not take down the other 19 by reverting. */
export const execute_auto_sell = async (
  bot: BotSdk,
  decisions: readonly SellDecision[]
): Promise<readonly Readonly<{ decision: SellDecision; digest: string }>[]> => {
  const results: Readonly<{ decision: SellDecision; digest: string }>[] = []
  const record_listed = async (decision: SellDecision, digest: string, listed_id: string): Promise<void> => {
    append_listing({
      listing_id: listed_id,
      item_type: decision.item_type,
      kiosk_id: decision.kiosk_id,
      price_mist: decision.price_mist.toString(),
      listed_at: new Date().toISOString(),
      resolved_at: null,
      outcome: null,
    })
    results.push({ decision, digest })
  }

  const by_kiosk = new Map<string, SellDecision[]>()
  for (const decision of decisions) {
    const group = by_kiosk.get(decision.kiosk_id) ?? []
    group.push(decision)
    by_kiosk.set(decision.kiosk_id, group)
  }
  for (const group of by_kiosk.values()) {
    for (let i = 0; i < group.length; i += LIST_BATCH_SIZE) {
      const chunk = group.slice(i, i + LIST_BATCH_SIZE)
      try {
        const batch = await bot.marketplace.list_many(
          chunk.map((d) => ({ kind: 'item' as const, id: d.item_id, kiosk: d.kiosk_id, price_mist: d.price_mist }))
        )
        await Promise.all(batch.map((r, j) => record_listed(chunk[j]!, r.digest, r.listed_id)))
      } catch (error) {
        // Batch rejected (one bad item reverts the whole PTB) — fall back to the resilient
        // per-item path for exactly this chunk; the rest of the pass still runs batched.
        for (const decision of chunk) {
          try {
            const { digest, listed_id } = await bot.marketplace.list({
              kind: 'item',
              id: decision.item_id,
              kiosk: decision.kiosk_id,
              price_mist: decision.price_mist,
            })
            await record_listed(decision, digest, listed_id)
          } catch {
            // Leave the item unlisted (and unrecorded) so the next pass re-proposes it.
          }
        }
      }
    }
  }
  return results
}

// Listing chunks roll up ~20 kiosk::list commands per transaction — small enough to keep the PTB
// far from Sui's command limit and the failure blast radius per batch modest.
const LIST_BATCH_SIZE = 20

// Categories a character actually wears/wields (seed/content/items.json's own category list,
// 2026-09-06) -- kept in sync BY HAND with control_panel_pages.ts's identical client-side copy
// (the browser can't import this server module). Auto-sell never touches these on its own; only
// a human picking them by hand in the control panel's per-item checkboxes can list one. Tool
// categories are here too: a spare gathering tool is a roster asset (2 miners / 1 farmer /
// 1 herbalist), not sellable loot.
export const EQUIPMENT_CATEGORIES: ReadonlySet<string> = new Set([
  'cloak', 'hat', 'amulet', 'boots', 'belt', 'ring', 'sword', 'daggers', 'bow', 'spear', 'axe',
  'tool_miner', 'tool_farmer', 'tool_herbalist',
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

export type SpareLootPlan = Readonly<{
  sellable: SellDecision[]
  held_materials: SellDecision[]
  quest_reserved: ReadonlySet<string>
}>

/** The automatic sell policy over plan_auto_sell()'s raw candidates: keeps equipment, today's
 *  dungeon-key materials and every craft-recipe ingredient in the kiosk, and returns what's left
 *  to list. Shared by auto_sell_spare_loot and the auto-sell CLI so both always agree on what
 *  "auto-sell" may touch — the control panel's per-item checkboxes are the only path that can
 *  deliberately list a kept material (human override, otherwise the item the policy protects). */
export const plan_spare_loot = async (bot: BotSdk): Promise<SpareLootPlan> => {
  const quest_reserved = await reserved_for_todays_quest(bot)
  const planned = await plan_auto_sell(bot)
  const held_materials = planned.filter((d) => CRAFT_INGREDIENTS.has(d.item_type))
  const sellable = planned.filter(
    (d) => !EQUIPMENT_CATEGORIES.has(d.category) && !quest_reserved.has(d.item_type) && !CRAFT_INGREDIENTS.has(d.item_type)
  )
  return { sellable, held_materials, quest_reserved }
}

/** Lists every spare sellable item (non-equipment, non-quest, non-craft-material) on the HDV,
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
  // The auto-seller's price memory (market_history.local.json) only advances when open listings
  // are resolved against live kiosk state — otherwise every pass re-prices from stale "still open"
  // records and plan_spare_loot never re-proposes a sold-out item. The static sale loop ran this
  // every pass, the authoritative auto-sell CLI reconciles first, and the roam's auto-sell call
  // must too (it's the same decision inputs). Read-only: it only writes the local outcome memory.
  await reconcile_market_history(bot)
  const { sellable, held_materials, quest_reserved } = await plan_spare_loot(bot)
  if (quest_reserved.size > 0) log(`auto-sell: holding back ${[...quest_reserved].join(', ')} for today's dungeon quest`)
  if (held_materials.length > 0) {
    const names = held_materials
      .slice(0, 8)
      .map((d) => d.name)
      .join(', ')
    log(
      `auto-sell: keeping ${held_materials.length} craft material(s) off the HDV (used by craft recipes) — ` +
        `${names}${held_materials.length > 8 ? ` and ${held_materials.length - 8} more` : ''}`
    )
  }
  if (sellable.length === 0) return { listed: 0 }
  log(`auto-sell: listing ${sellable.length} spare item(s) on the HDV…`)
  const results = await execute_auto_sell(bot, sellable)
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
