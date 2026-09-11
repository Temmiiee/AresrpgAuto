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
export const FAST_SELL_MS = 6 * 60 * 60 * 1000 // sold within 6h of listing counts as "fast"

// A clean, human price sells better than an odd fraction, and rounding UP (never down) means the
// bot never quotes itself below its own floor/estimate to get there (2026-09-06, project owner:
// "l'item qui vaut 0.0169 on le vend a 0.02 a l'HDV" -- 0.01 SUI is the chosen step).
const CENT_MIST = 10_000_000n // 0.01 SUI, in MIST (1 SUI = 1e9 MIST)
const round_up_to_cent = (mist: bigint): bigint => ((mist + CENT_MIST - 1n) / CENT_MIST) * CENT_MIST

const raw_suggest_listing_price_mist = (
  item_type: string,
  base_price_mist: bigint,
  history: readonly ListingRecord[]
): bigint => {
  const floor = pct(base_price_mist, MIN_PRICE_FLOOR)
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
