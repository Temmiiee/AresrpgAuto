// Gear-craft goals — the "what should we make" half of the loop. These pin the selection rules: only
// CRAFTABLE gear, never above the character's level, fitted to the slot, scored with the same
// rune-weight + affinity math auto-equip uses, only when it actually beats what the character could
// wear today, and never a second copy of something the party already holds un-equipped.
import { describe, expect, it } from 'bun:test'
import { item_stat_center, stat_names } from '@aresrpg/immutable'
import type { CharacterRow, ItemRow } from '@aresrpg/protocol'
import type { SeedItem } from '@aresrpg/sdk/seed'

import {
  expected_gear,
  gear_goal_outputs,
  plan_gear_goals,
  plan_slot_goal,
  type GearCandidate,
  type GearItem,
} from '../src/actions/gear.ts'
import { items_by_type } from '../src/content/catalog.ts'
import { initial_game_state } from '../src/state/store.ts'

const SHIFT = item_stat_center

const character = (over: Partial<CharacterRow> = {}): CharacterRow =>
  ({
    id: 'c1',
    name: 'omori',
    classe: 'asobi',
    sex: 'male',
    level: 50,
    experience: '0',
    color_1: 0,
    color_2: 0,
    color_3: 0,
    vitality: 0,
    wisdom: 0,
    strength: 0,
    intelligence: 0,
    chance: 0,
    agility: 0,
    available_points: 0,
    spells: {},
    available_spell_points: 0,
    jobs: {},
    kiosk: 'kiosk-1',
    equipment: [],
    ...over,
  }) as CharacterRow

/** A seed item whose per-stat authored range is given as signed offsets (all others 0). */
const seed_item = (
  item_type: string,
  category: string,
  level: number,
  min: Record<string, number> = {},
  max: Record<string, number> = {}
): SeedItem => {
  const full = (over: Record<string, number>) => Object.fromEntries(stat_names.map((s) => [s, over[s] ?? 0]))
  return {
    item_type,
    name: item_type,
    category,
    level,
    stats: { min: full(min), max: full(max) },
  } as SeedItem
}

/** A synthetic craftable candidate whose stats are given as SIGNED offsets from neutral. */
const cand = (
  output_type: string,
  category: string,
  level: number,
  over: { stats?: Record<string, number>; damages?: GearItem['damages'] } = {}
): GearCandidate =>
  Object.freeze({
    output_type,
    job: 'FORGER',
    category,
    level,
    item: {
      id: output_type,
      item_type: output_type,
      category,
      level,
      stats: over.stats
        ? Object.fromEntries(Object.entries(over.stats).map(([stat, value]) => [stat, SHIFT + value]))
        : undefined,
      damages: over.damages,
      pet_power: undefined,
    },
  })

const item = (id: string, item_type: string, category: string, over: Partial<ItemRow> = {}): ItemRow =>
  ({ id, name: id, item_type, category, level: 1, amount: 1, kiosk: 'kiosk-1', ...over }) as ItemRow

const state_with = (inventory: readonly ItemRow[], characters: readonly CharacterRow[] = [character()]) => ({
  ...initial_game_state,
  characters,
  inventory,
})

describe('expected_gear', () => {
  it('encodes the midpoint of the authored range into the centered u16 the chain rolls', () => {
    const gear = expected_gear(seed_item('blade', 'sword', 10, { strength: 10 }, { strength: 20 }))
    expect(gear.level).toBe(10)
    expect(gear.stats!.strength).toBe(SHIFT + 15)
    expect(gear.damages).toBeUndefined()
  })
})

describe('plan_slot_goal', () => {
  it('proposes a craftable piece when the character is bare, and scores it', () => {
    const goal = plan_slot_goal(character({ level: 10 }), 'hat', null, [cand('hat', 'hat', 5, { stats: { strength: 40 } })])
    expect(goal).not.toBeNull()
    expect(goal!.output_type).toBe('hat')
    expect(goal!.slot).toBe('hat')
    expect(goal!.gain).toBeCloseTo(goal!.score)
    expect(goal!.score).toBeGreaterThan(0)
  })

  it('never proposes a piece above the character level', () => {
    const goal = plan_slot_goal(character({ level: 5 }), 'weapon', null, [cand('big-axe', 'axe', 30)])
    expect(goal).toBeNull()
  })

  it('fits the candidate to the slot', () => {
    const goal = plan_slot_goal(character({ level: 50, chance: 500 }), 'hat', null, [
      cand('necklace', 'amulet', 5, { stats: { chance: 80 } }),
    ])
    expect(goal).toBeNull()
  })

  it('picks the best CRAFTABLE piece, preferring the element the character casts', () => {
    // A strength character: an earth weapon out-scores an identical air one.
    const hero = character({ strength: 500 })
    const earth = cand('earth-blade', 'sword', 20, {
      damages: [{ element: 'earth', from: 10, to: 20, damage_type: 'weapon' }],
    })
    const air = cand('air-blade', 'sword', 20, {
      damages: [{ element: 'air', from: 10, to: 20, damage_type: 'weapon' }],
    })
    expect(plan_slot_goal(hero, 'weapon', null, [air, earth])!.output_type).toBe('earth-blade')
  })

  it('never proposes a piece that is not better than what the character could wear', () => {
    const current: GearItem = cand('worn', 'hat', 20, { stats: { strength: 50 } }).item
    const weaker = cand('weaker', 'hat', 20, { stats: { strength: 10 } })
    expect(plan_slot_goal(character({ strength: 500 }), 'hat', current, [weaker])).toBeNull()
  })

  it('re-proposes an upgrade over the currently worn piece', () => {
    const current = cand('old-hat', 'hat', 20, { stats: { strength: 10 } }).item
    const better = cand('new-hat', 'hat', 20, { stats: { strength: 40 } })
    expect(plan_slot_goal(character({ strength: 500 }), 'hat', current, [better])!.output_type).toBe('new-hat')
  })
})

describe('plan_gear_goals', () => {
  it('finds real craftable upgrades at the character level and keeps them above that level out', () => {
    const hero = character({ level: 10 })
    const goals = plan_gear_goals([hero], state_with([], [hero]))
    expect(goals.length).toBeGreaterThan(0)
    for (const goal of goals) {
      expect(goal.level).toBeLessThanOrEqual(hero.level)
      const seed_item = items_by_type[goal.output_type]
      expect(seed_item).toBeDefined()
      expect(seed_item!.level).toBe(goal.level)
    }
  })

  it('drops a goal whose output the party already holds un-equipped (auto-equip will place it)', () => {
    const hero = character({ level: 10 })
    const before = plan_gear_goals([hero], state_with([], [hero]))
    const target = before[0]!
    const seed_item = items_by_type[target.output_type]!
    const held = item('held-copy', target.output_type, seed_item.category, { level: seed_item.level })
    const outputs = gear_goal_outputs([hero], state_with([held], [hero]))
    expect(outputs).not.toContain(target.output_type)
  })

  it('is empty without a roster', () => {
    expect(plan_gear_goals([], state_with([]))).toEqual([])
  })
})
