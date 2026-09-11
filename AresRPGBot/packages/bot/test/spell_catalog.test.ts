import { describe, expect, test } from 'bun:test'

import { castable_spells } from '../src/ai/spell_catalog.ts'

describe('castable_spells — damage-over-time classification', () => {
  test('a real poison spell (kind 5, stat 12/hp, turns >= 1) is classified as damage, not "other"', () => {
    // Poisoned Arrow (yogan, unlock_level 1): ap_cost 4, one effect {value: 2, value_max: 3, turns: 2}.
    // Confirmed against aresrpg_math::spell_effect.move directly: kind 5 = `remove`, stat 12 = hp
    // channel, turns >= 1 = a real damage-over-time effect (this game's poison/bleed spells),
    // not a stat/AP debuff (a different `stat` value) or an instant kind.
    const spells = castable_spells('yogan', 1)
    const poisoned_arrow = spells.find((s) => s.name === 'Poisoned Arrow')
    expect(poisoned_arrow).toBeDefined()
    expect(poisoned_arrow!.role).toBe('damage')
    expect(poisoned_arrow!.element).toBe('earth')
    // damage_amount = avg(value, value_max) * turns = avg(2, 3) * 2 = 5; score = damage/ap_cost.
    expect(poisoned_arrow!.score).toBeCloseTo(5 / 4, 10)
  })

  test('every known spell still has an ap_cost of at least 1 and a non-negative score', () => {
    for (const classe of ['yogan', 'senshi', 'tomoda', 'mori']) {
      for (const spell of castable_spells(classe, 15)) {
        expect(spell.ap_cost).toBeGreaterThanOrEqual(1)
        expect(spell.score).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
