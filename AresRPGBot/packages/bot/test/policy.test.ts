import { describe, expect, test } from 'bun:test'

import { clamp_policy, DEFAULT_POLICY, element_advantage, finish_bonus, heal_score, priority_weight } from '../src/ai/policy.ts'

describe('priority_weight', () => {
  test('rank 0 is always full weight regardless of decay', () => {
    expect(priority_weight(0, 0.5)).toBe(1)
    expect(priority_weight(0, 2)).toBe(1)
  })

  test('falls off with rank, faster for a higher decay', () => {
    const low_decay = priority_weight(3, 0.5)
    const high_decay = priority_weight(3, 2)
    expect(low_decay).toBeGreaterThan(high_decay)
    expect(low_decay).toBeLessThan(1)
  })

  test('decay 0 ignores rank entirely', () => {
    expect(priority_weight(0, 0)).toBe(1)
    expect(priority_weight(5, 0)).toBe(1)
  })
})

describe('finish_bonus', () => {
  test('scales linearly with 1 - hp_fraction, times finish_weight', () => {
    expect(finish_bonus(50, 100, 10)).toBeCloseTo(5, 10) // 10 * (1 - 0.5)
    expect(finish_bonus(0, 100, 10)).toBeCloseTo(10, 10) // 10 * (1 - 0)
    expect(finish_bonus(100, 100, 10)).toBeCloseTo(0, 10) // 10 * (1 - 1)
  })

  test('zero finish_weight always gives zero, regardless of hp', () => {
    expect(finish_bonus(1, 100, 0)).toBe(0)
  })

  test('a max_hp of 0 is floored at 1 to avoid a division by zero', () => {
    expect(finish_bonus(0, 0, 10)).toBeCloseTo(10, 10)
  })
})

describe('heal_score', () => {
  test('scales the WHOLE score with heal_deficit, not just the heal_weight term', () => {
    // A barely-scratched ally (tiny deficit) should score far below a near-dead one, even
    // though both have the exact same base spell score and heal_weight — this is the fix for
    // the live/simulator drift (see policy.ts's own header comment on heal_score).
    const barely_hurt = heal_score(1, 10, 5, 0.01)
    const near_dead = heal_score(1, 10, 5, 0.99)
    expect(barely_hurt).toBeCloseTo((1 * 10 + 5) * 0.01, 10)
    expect(near_dead).toBeCloseTo((1 * 10 + 5) * 0.99, 10)
    expect(near_dead).toBeGreaterThan(barely_hurt * 10)
  })

  test('zero deficit (nobody hurt) always scores zero', () => {
    expect(heal_score(1, 10, 5, 0)).toBe(0)
  })
})

describe('element_advantage', () => {
  test('null resistance (unknown target) is neutral', () => {
    expect(element_advantage(null)).toBe(0)
  })

  test('centered resistance (32768, the ITEM_STAT_CENTER) is neutral', () => {
    expect(element_advantage(32_768)).toBe(0)
  })

  test('below-center resistance is a weakness (positive advantage)', () => {
    expect(element_advantage(32_768 - 50 * 25)).toBeCloseTo(25, 10)
  })

  test('above-center resistance is resisted (negative advantage)', () => {
    expect(element_advantage(32_768 + 50 * 10)).toBeCloseTo(-10, 10)
  })
})

describe('clamp_policy', () => {
  test('leaves an already-valid policy untouched', () => {
    expect(clamp_policy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY)
  })

  test('floors every weight that must stay non-negative', () => {
    const clamped = clamp_policy({
      base_weight: -1,
      priority_decay: -1,
      finish_weight: -1,
      heal_weight: -1,
      strike_bias: -1,
      element_weight: -1,
    })
    expect(clamped.base_weight).toBe(0)
    expect(clamped.priority_decay).toBe(0)
    expect(clamped.finish_weight).toBe(0)
    expect(clamped.heal_weight).toBe(0)
    expect(clamped.element_weight).toBe(0)
  })

  test('strike_bias is allowed to be negative (a malus, not just a bonus)', () => {
    expect(clamp_policy({ ...DEFAULT_POLICY, strike_bias: -2 }).strike_bias).toBe(-2)
  })

  test('priority_decay is capped at 3', () => {
    expect(clamp_policy({ ...DEFAULT_POLICY, priority_decay: 10 }).priority_decay).toBe(3)
  })
})
