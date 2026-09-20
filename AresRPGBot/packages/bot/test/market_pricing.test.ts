import { describe, expect, test } from 'bun:test'

import type { ListingRecord } from '../src/market/market_history.ts'
import {
  FAST_SELL_MS,
  FAST_SELL_RAISE,
  FIRST_LISTING_UNDERCUT,
  MIN_PRICE_FLOOR,
  STALE_CUT,
  suggest_listing_price_mist,
} from '../src/market/market_pricing.ts'

// Never recorded by anything (item_rarity.ts's real, file-backed registry) — guarantees
// rarity_tier(item_type) is null regardless of what this machine's local registry happens to
// hold, so these tests never depend on (or mutate) real recorded rarity data.
const UNKNOWN_ITEM = '__test_market_pricing_never_seen__'
const BASE_MIST = 1_000_000_000n // 1 SUI

const record = (overrides: Partial<ListingRecord>): ListingRecord => ({
  listing_id: 'listing-1',
  item_type: UNKNOWN_ITEM,
  kiosk_id: 'kiosk-1',
  price_mist: BASE_MIST.toString(),
  listed_at: '2026-01-01T00:00:00.000Z',
  resolved_at: null,
  outcome: null,
  ...overrides,
})

const round_up_to_cent = (mist: bigint): bigint => {
  const CENT = 10_000_000n
  return ((mist + CENT - 1n) / CENT) * CENT
}

describe('suggest_listing_price_mist — first listing (no history)', () => {
  test('undercuts the base estimate for an item of unknown/common rarity', () => {
    const suggested = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, [])
    const expected = round_up_to_cent((BASE_MIST * BigInt(Math.round((1 - FIRST_LISTING_UNDERCUT) * 1000))) / 1000n)
    expect(suggested).toBe(expected)
    expect(suggested).toBeLessThan(BASE_MIST)
  })

  test('is always rounded up to the nearest 0.01 SUI', () => {
    const suggested = suggest_listing_price_mist(UNKNOWN_ITEM, 999_999_999n, [])
    expect(suggested % 10_000_000n).toBe(0n)
  })

  test('ignores history for a different item_type entirely', () => {
    const history = [record({ item_type: 'some_other_item', outcome: 'sold', resolved_at: '2026-01-01T00:01:00.000Z' })]
    const with_unrelated_history = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, history)
    const with_no_history = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, [])
    expect(with_unrelated_history).toBe(with_no_history)
  })
})

describe('suggest_listing_price_mist — walking from a resolved listing', () => {
  test('raises the price after a fast sale', () => {
    const history = [
      record({
        outcome: 'sold',
        listed_at: '2026-01-01T00:00:00.000Z',
        resolved_at: new Date(new Date('2026-01-01T00:00:00.000Z').getTime() + FAST_SELL_MS / 2).toISOString(),
      }),
    ]
    const suggested = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, history)
    const expected = round_up_to_cent((BASE_MIST * BigInt(Math.round((1 + FAST_SELL_RAISE) * 1000))) / 1000n)
    expect(suggested).toBe(expected)
  })

  test('keeps the exact last price after a slow sale (no raise)', () => {
    const history = [
      record({
        outcome: 'sold',
        listed_at: '2026-01-01T00:00:00.000Z',
        resolved_at: new Date(new Date('2026-01-01T00:00:00.000Z').getTime() + FAST_SELL_MS * 2).toISOString(),
      }),
    ]
    const suggested = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, history)
    expect(suggested).toBe(round_up_to_cent(BASE_MIST))
  })

  test('cuts the price after an unsold/delisted listing', () => {
    const history = [record({ outcome: 'unsold' })]
    const suggested = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, history)
    const expected = round_up_to_cent((BASE_MIST * BigInt(Math.round((1 - STALE_CUT) * 1000))) / 1000n)
    expect(suggested).toBe(expected)
  })

  test('only ever looks at the LAST resolved record for that item_type', () => {
    const history = [
      record({ outcome: 'unsold', price_mist: '2000000000' }),
      record({
        outcome: 'sold',
        price_mist: BASE_MIST.toString(),
        listed_at: '2026-01-01T00:00:00.000Z',
        resolved_at: '2026-01-01T00:00:01.000Z', // 1s later — well under FAST_SELL_MS, so "fast"
      }),
    ]
    const suggested = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, history)
    // Reacts to the LAST array entry (the fast sale), not the first (the unsold cut).
    const expected = round_up_to_cent((BASE_MIST * BigInt(Math.round((1 + FAST_SELL_RAISE) * 1000))) / 1000n)
    expect(suggested).toBe(expected)
  })

  test('never cuts the price below MIN_PRICE_FLOOR of the base estimate, even after repeated cuts', () => {
    let history: ListingRecord[] = []
    let price = BASE_MIST
    for (let i = 0; i < 50; i += 1) {
      price = suggest_listing_price_mist(UNKNOWN_ITEM, BASE_MIST, history)
      history = [record({ outcome: 'unsold', price_mist: price.toString() })]
    }
    const floor = round_up_to_cent((BASE_MIST * BigInt(Math.round(MIN_PRICE_FLOOR * 1000))) / 1000n)
    expect(price).toBeGreaterThanOrEqual(floor)
  })

  test('never cuts a loot bag below the absolute 0.3 SUI floor', () => {
    const bag = 'bag_quartz'
    let history: ListingRecord[] = []
    let price = 1_000_000_000n
    for (let i = 0; i < 50; i += 1) {
      price = suggest_listing_price_mist(bag, 1_000_000_000n, history)
      history = [record({ item_type: bag, outcome: 'unsold', price_mist: price.toString() })]
    }
    expect(price).toBeGreaterThanOrEqual(300_000_000n)
  })
})
