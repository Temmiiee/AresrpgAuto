import { describe, expect, test } from 'bun:test'

import { caster_damage_multiplier, PRIMARY_STAT_BY_CLASS, split_stat_spending } from '../src/ai/stat_allocation.ts'

const STATS = { strength: 20, intelligence: 10, chance: 5, agility: 15 }

describe('caster_damage_multiplier', () => {
  test('a null element (e.g. a support spell) never amplifies', () => {
    expect(caster_damage_multiplier(null, STATS)).toBe(1)
  })

  test('each element amplifies by exactly its own primary stat (fight_math::amplify_damage)', () => {
    expect(caster_damage_multiplier('earth', STATS)).toBeCloseTo((100 + STATS.strength) / 100, 10)
    expect(caster_damage_multiplier('fire', STATS)).toBeCloseTo((100 + STATS.intelligence) / 100, 10)
    expect(caster_damage_multiplier('water', STATS)).toBeCloseTo((100 + STATS.chance) / 100, 10)
    expect(caster_damage_multiplier('air', STATS)).toBeCloseTo((100 + STATS.agility) / 100, 10)
  })

  test('an unrecognized element string never amplifies (same as null)', () => {
    expect(caster_damage_multiplier('not_a_real_element', STATS)).toBe(1)
  })

  test('zero investment in the relevant stat gives exactly 1.0x, however good the spell looks on paper', () => {
    expect(caster_damage_multiplier('air', { ...STATS, agility: 0 })).toBe(1)
  })
})

describe('split_stat_spending', () => {
  test('zero or negative available points spends nothing', () => {
    expect(split_stat_spending('senshi', 0, 10)).toEqual({})
    expect(split_stat_spending('senshi', -5, 10)).toEqual({})
  })

  test('a class with no known primary stat puts everything into vitality', () => {
    expect(split_stat_spending('not_a_real_class', 12, 0)).toEqual({ vitality: 12 })
  })

  test('primary_share 0 puts every point into vitality even for a class with a real primary', () => {
    expect(split_stat_spending('senshi', 10, 0, 0)).toEqual({ vitality: 10 })
  })

  test('every point is accounted for between the primary stat and vitality, for every real class', () => {
    for (const classe of Object.keys(PRIMARY_STAT_BY_CLASS)) {
      const spending = split_stat_spending(classe, 20, 5)
      const primary = PRIMARY_STAT_BY_CLASS[classe]!
      const total = (spending[primary] ?? 0) + (spending.vitality ?? 0)
      expect(total).toBe(20)
      // Never spends on a stat OTHER than this class's own primary or vitality.
      for (const key of Object.keys(spending)) expect([primary, 'vitality']).toContain(key)
    }
  })
})
