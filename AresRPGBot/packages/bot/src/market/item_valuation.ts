import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from '../state/local_store.ts'

const prices_store = create_local_json_store<Record<string, number>>(
  fileURLToPath(new URL('../../item_prices.json', import.meta.url)),
  {}
)

// The authored level table — real, per-item data (values from 1 to 145+ across the seed content)
// instead of guessing or requiring every caller to thread a level through by hand. Before this,
// `value_drops` (fight loot) never had a level to pass at all, so every unknown-item drop
// silently priced as if it were level 1 regardless of what actually dropped — a level-9
// resource and a level-1 one landed on the exact same number.
const ITEMS_PATH = fileURLToPath(new URL('../../../../seed/content/items.json', import.meta.url))
const ITEM_LEVEL_BY_TYPE: ReadonlyMap<string, number> = new Map(
  (JSON.parse(readFileSync(ITEMS_PATH, 'utf8')) as { item_type: string; level: number }[]).map((i) => [
    i.item_type,
    i.level,
  ])
)

// Default fallback prices in SUI for known items when market price is not listed
const DEFAULT_ESTIMATED_PRICES_SUI: Record<string, number> = {
  water: 0.005,
  fire: 0.008,
  earth: 0.008,
  wind: 0.008,
  wood: 0.01,
  iron: 0.02,
  gold: 0.05,
  potion_hp: 0.015,
  scroll_xp: 0.05,
}

const DEFAULT_FALLBACK_PRICE_SUI = 0.005

export type ItemValuation = {
  qty: number
  unit_price_sui: number
  total_sui: number
  estimated: boolean
}

export type ValuationReport = {
  total_sui: number
  items: Record<string, ItemValuation>
}

/** Reads custom price overrides from `item_prices.json` if available */
export const load_custom_prices = prices_store.read

// No entry in item_prices.json or the drop-price table above (true for every equipment item_type
// today, and for most raw materials — item_prices.json only carries 7 of them) falls all the way
// back to this flat floor. A level-1 trash drop and a level-145 one (the seed content's real
// range) shouldn't list identically, so the fallback scales with the item's own authored level —
// a POWER curve (level^EXPONENT), not flat-linear: a flat +5%/level was measured to undervalue
// mid/high-level drops badly (a level-9 material landed at just 1.4x the level-1 floor; a
// level-145 one at only ~8x, clearly implausible for gear this deep into the level range). This
// is still an unverified guess, not a calibrated curve — the bot has no live market read at all
// (see auto_sell.ts's header for why), so there is no ground truth to fit against. What this
// number actually FEEDS: whether a fight logs as "profitable" against its gas cost, and the
// auto-seller's very first listing price for an item type with no sale history yet — never an
// actual floor/ceiling on a real transaction. auto_sell.ts's own pricing corrects toward reality
// over time from real listing outcomes once there's history to learn from; this fallback only
// ever gets that first guess in the right ballpark.
const FALLBACK_LEVEL_SCALING_EXPONENT = 0.6

/**
 * Returns estimated or actual marketplace price for an item type in SUI. The item's own
 * authored level (seed/content/items.json) drives the flat unknown-item fallback's scaling —
 * always looked up here, so a caller can never forget to pass it, unlike a `level?` parameter.
 * A custom or known-drop price is used as-is, un-scaled.
 */
export const get_item_price = (item_type: string): { unit_price_sui: number; estimated: boolean } => {
  const custom = load_custom_prices()
  if (typeof custom[item_type] === 'number') {
    return { unit_price_sui: custom[item_type], estimated: false }
  }
  const known = DEFAULT_ESTIMATED_PRICES_SUI[item_type.toLowerCase()]
  if (typeof known === 'number') {
    return { unit_price_sui: known, estimated: true }
  }
  const level = ITEM_LEVEL_BY_TYPE.get(item_type) ?? 1
  const scale = Math.max(1, level) ** FALLBACK_LEVEL_SCALING_EXPONENT
  return { unit_price_sui: Number((DEFAULT_FALLBACK_PRICE_SUI * scale).toFixed(6)), estimated: true }
}

/**
 * Evaluates the total estimated value of drops in SUI.
 */
export const value_drops = (drops: Record<string, number>): ValuationReport => {
  let total_sui = 0
  const items: Record<string, ItemValuation> = {}

  for (const [item_type, qty] of Object.entries(drops)) {
    if (qty <= 0) continue
    const { unit_price_sui, estimated } = get_item_price(item_type)
    const item_total = Number((unit_price_sui * qty).toFixed(6))
    total_sui += item_total
    items[item_type] = {
      qty,
      unit_price_sui,
      total_sui: item_total,
      estimated,
    }
  }

  return {
    total_sui: Number(total_sui.toFixed(6)),
    items,
  }
}

/**
 * Calculates farming profitability for a fight.
 */
export const calculate_farming_profit = (
  drops_value_sui: number,
  gas_spent_sui: number
): { net_profit_sui: number; is_profitable: boolean; roi_percent: number } => {
  const net_profit_sui = Number((drops_value_sui - gas_spent_sui).toFixed(6))
  const is_profitable = net_profit_sui > 0
  const roi_percent = gas_spent_sui > 0 ? Number(((net_profit_sui / gas_spent_sui) * 100).toFixed(1)) : 0
  return { net_profit_sui, is_profitable, roi_percent }
}
