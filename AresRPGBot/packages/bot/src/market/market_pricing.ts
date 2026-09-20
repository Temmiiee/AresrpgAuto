// Adaptive listing price, pure over a base fair-value estimate and this item type's own past
// listing outcomes (see market_history.ts for why "own outcomes" is the signal instead of a live
// order book). The strategy on a type's first-ever listing depends on whether it's a common item
// or a confirmed-rare one (item_rarity.ts): a common item's first listing undercuts, since an
// early/thin market has no visible price to anchor buyers and the goal is liquidity; a rare one
// instead gets a PREMIUM (2026-09-05, project owner: this bot will out-farm the very earliest
// mainnet players, so its rare early drops will often have NO comparable listing anywhere, not
// just none of its own -- genuine first-mover pricing power, the opposite situation from "buyers
// can't find this listing among many identical ones"). Once there's at least one resolved listing
// for a type, both cases fall back to the same walk-up-on-fast-sale / walk-down-on-stale logic —
// sequential price discovery is the right tool once real outcomes exist to learn from, regardless
// of how the first guess was made.
import type { ListingRecord } from './market_history.ts'
import { rarity_tier, type RarityTier } from './item_rarity.ts'

const PCT_SCALE = 1000n
// BigInt division truncates toward zero -- rounding every listing price DOWN a little every time
// (2026-09-06, project owner request: round up instead, never leave a fraction of a MIST on the
// table). Ceiling division for positive operands: (a + b - 1) / b.
const pct = (mist: bigint, factor: number): bigint => {
  const numerator = mist * BigInt(Math.round(factor * Number(PCT_SCALE)))
  return (numerator + PCT_SCALE - 1n) / PCT_SCALE
}

export const FIRST_LISTING_UNDERCUT = 0.15 // no comparable sale yet, common item — price under our own estimate to actually get seen
// First-listing PREMIUM by confirmed rarity tier (item_rarity.ts) — applied instead of the
// undercut above. Deliberately steep for 'epic': a genuinely rare early drop is worth testing a
// high anchor price for, since an unsold listing costs nothing but time (no listing-fee burn
// found in marketplace.move) and can always be walked back down via STALE_CUT same as any other
// item once it's known to be too high. 'common'/unknown items are NOT included here on purpose —
// they keep using FIRST_LISTING_UNDERCUT below.
const FIRST_LISTING_PREMIUM: Readonly<Partial<Record<RarityTier, number>>> = {
  uncommon: 0.15,
  rare: 0.5,
  epic: 1.5,
}
export const FAST_SELL_RAISE = 0.1 // sold quickly last time — the market will likely bear more
export const STALE_CUT = 0.12 // sat unsold past the timeout — priced above what the market will bear
export const MIN_PRICE_FLOOR = 0.4 // never chase the price down past this fraction of the base estimate
export const LOOT_BAG_MIN_LISTING_SUI = 0.3 // a bag represents a bulk resource reward, never list below this
export const FAST_SELL_MS = 6 * 60 * 60 * 1000 // sold within 6h of listing counts as "fast"

// A clean, human price sells better than an odd fraction, and rounding UP (never down) means the
// bot never quotes itself below its own floor/estimate to get there (2026-09-06, project owner:
// "l'item qui vaut 0.0169 on le vend a 0.02 a l'HDV" -- 0.01 SUI is the chosen step).
const CENT_MIST = 10_000_000n // 0.01 SUI, in MIST (1 SUI = 1e9 MIST)
export const round_up_to_cent = (mist: bigint): bigint => ((mist + CENT_MIST - 1n) / CENT_MIST) * CENT_MIST

// Live-HDV reference pricing (market_probe.ts): when OTHER kiosks currently ask far more for a
// type than this bot's estimate-based price, the estimate (item_valuation's level-scaled fallback)
// was measuring nothing real — quote the market instead: the cheapest competing per-unit ask,
// undercut slightly so our listing sells first, scaled back up to this stack's amount. Only adopts
// the market when it's meaningfully ABOVE the incumbent (MARKET_ADOPT_TERMS: >1.5x) — a stack
// already at or above the market isn't re-priced at all (no sense undercutting ourselves into the
// dirt, and jumping above the market's cheapest ask only stalls a sale). There is no real listing-
// fee burn on delist/relist, so correcting an underpriced listing costs only gas (confirmed in
// marketplace.move).
export const MARKET_UNDERCUT = 0.95
// Adopt the market's ask level when the incumbent quote is MORE than 50% below the market's
// cheapest per-unit ask (market_min * 2 > incumbent * 3); any smaller gap keeps the incumbent.
// A 2x-underpriced listing (e.g. 0.02 listed when the market asks 0.04) IS caught — the level-
// scaled fallback had already priced those, so an exactly-2x gap is still a pricing bug, not a
// deliberate discount.
const MARKET_ADOPT_TERMS = { incumbent: 2n, market: 3n }

export const suggest_market_lot_price_mist = (
  current_price_mist: bigint,
  market_min_unit_mist: bigint,
  amount: number
): bigint => {
  const units = BigInt(Math.max(1, Math.floor(amount)))
  const incumbent_unit = current_price_mist / units
  if (market_min_unit_mist * MARKET_ADOPT_TERMS.incumbent <= incumbent_unit * MARKET_ADOPT_TERMS.market)
    return current_price_mist
  const undercut = (market_min_unit_mist * BigInt(Math.round(MARKET_UNDERCUT * 1000))) / 1000n
  return round_up_to_cent(undercut * units)
}

const raw_suggest_listing_price_mist = (
  item_type: string,
  base_price_mist: bigint,
  history: readonly ListingRecord[]
): bigint => {
  const estimate_floor = pct(base_price_mist, MIN_PRICE_FLOOR)
  const bag_floor = item_type.startsWith('bag_')
    ? BigInt(Math.ceil(LOOT_BAG_MIN_LISTING_SUI * Number(1_000_000_000n)))
    : 0n
  const floor = estimate_floor > bag_floor ? estimate_floor : bag_floor
  const clamped = (candidate: bigint): bigint => (candidate > floor ? candidate : floor)

  const resolved_for_type = history.filter((record) => record.item_type === item_type && record.outcome !== null)
  const last = resolved_for_type.at(-1)
  if (!last) {
    const premium = FIRST_LISTING_PREMIUM[rarity_tier(item_type) ?? 'common']
    return clamped(pct(base_price_mist, premium !== undefined ? 1 + premium : 1 - FIRST_LISTING_UNDERCUT))
  }

  const last_price_mist = BigInt(last.price_mist)
  if (last.outcome === 'sold' && last.resolved_at) {
    const sell_duration_ms = new Date(last.resolved_at).getTime() - new Date(last.listed_at).getTime()
    return sell_duration_ms <= FAST_SELL_MS ? clamped(pct(last_price_mist, 1 + FAST_SELL_RAISE)) : last_price_mist
  }
  // 'unsold' or 'delisted' with no sale: the price was too high — cut it
  return clamped(pct(last_price_mist, 1 - STALE_CUT))
}

export const suggest_listing_price_mist = (
  item_type: string,
  base_price_mist: bigint,
  history: readonly ListingRecord[]
): bigint => round_up_to_cent(raw_suggest_listing_price_mist(item_type, base_price_mist, history))
