import { describe, expect, test } from 'bun:test'

import { calculate_farming_profit, get_item_price, value_drops } from '../src/market/item_valuation.ts'

describe('get_item_price', () => {
  test('a custom override (item_prices.json) wins over everything else and is never "estimated"', () => {
    // 'gold' is one of the 7 real overrides committed in item_prices.json (0.05 SUI).
    const { unit_price_sui, estimated } = get_item_price('gold')
    expect(unit_price_sui).toBe(0.05)
    expect(estimated).toBe(false)
  })

  test('a known drop-price default is used when there is no custom override', () => {
    // 'potion_hp' is in DEFAULT_ESTIMATED_PRICES_SUI but not in item_prices.json.
    const { unit_price_sui, estimated } = get_item_price('potion_hp')
    expect(unit_price_sui).toBe(0.015)
    expect(estimated).toBe(true)
  })

  test('an item with no override, no known default, and no seed-content level falls back to the flat floor', () => {
    const { unit_price_sui, estimated } = get_item_price('__test_item_valuation_never_seen__')
    expect(unit_price_sui).toBe(0.005) // DEFAULT_FALLBACK_PRICE_SUI * 1^0.6
    expect(estimated).toBe(true)
  })
})

describe('value_drops', () => {
  test('sums per-item and total value, skipping zero/negative quantities', () => {
    const report = value_drops({
      gold: 3,
      __test_item_valuation_never_seen__: 2,
      __test_item_valuation_zero_qty__: 0,
    })
    expect(report.items.gold?.qty).toBe(3)
    expect(report.items.gold?.total_sui).toBeCloseTo(0.15, 6)
    expect(report.items.__test_item_valuation_never_seen__?.total_sui).toBeCloseTo(0.01, 6)
    expect(report.items.__test_item_valuation_zero_qty__).toBeUndefined()
    expect(report.total_sui).toBeCloseTo(0.16, 6)
  })

  test('an empty drop set values at exactly zero', () => {
    expect(value_drops({})).toEqual({ total_sui: 0, items: {} })
  })
})

describe('calculate_farming_profit', () => {
  test('a fight that dropped more value than its gas cost is profitable', () => {
    const result = calculate_farming_profit(0.1, 0.08)
    expect(result.net_profit_sui).toBeCloseTo(0.02, 6)
    expect(result.is_profitable).toBe(true)
    expect(result.roi_percent).toBeCloseTo(25, 1)
  })

  test('a fight that cost more gas than its drops are worth is a loss', () => {
    const result = calculate_farming_profit(0.02, 0.08)
    expect(result.net_profit_sui).toBeCloseTo(-0.06, 6)
    expect(result.is_profitable).toBe(false)
  })

  test('a net profit of exactly zero is NOT profitable (strictly greater than zero required)', () => {
    expect(calculate_farming_profit(0.08, 0.08).is_profitable).toBe(false)
  })

  test('zero gas spent avoids a division by zero and reports 0% ROI', () => {
    expect(calculate_farming_profit(0.1, 0).roi_percent).toBe(0)
  })
})
