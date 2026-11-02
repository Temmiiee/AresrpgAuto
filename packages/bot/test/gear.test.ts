// Gear-craft goals — the "what should we make" half of the loop. These pin the selection rules: only
// CRAFTABLE gear, never above the character's level, fitted to the slot, scored with the same
// rune-weight + affinity math auto-equip uses, only when it actually beats what the character could
// wear today. Held copies are allocated exactly once: a usable roll suppresses one craft, while a
// weak roll or a second character needing the same output keeps the goal alive.
import { describe, expect, it } from 'bun:test'
import { craft_required_level, item_stat_center, job_xp_for_level, stat_names } from '@aresrpg/immutable'
import type { CharacterRow, ItemRow } from '@aresrpg/protocol'
import type { SeedItem } from '@aresrpg/sdk/seed'

import {
  expected_gear,
  gear_candidates,
  gear_goal_outputs,
  plan_gear_goals,
  plan_slot_goal,
  type GearCandidate,
  type GearItem,
} from '../src/actions/gear.ts'
import { plan_recipe } from '../src/actions/craft.ts'
import { equip_plan, plan_loadout } from '../src/actions/equip.ts'
import {
  gatherable_of,
  items_by_type,
  loot_sources_by_item,
  recipe_detail,
  recipes_by_output,
} from '../src/content/catalog.ts'
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

  it('keeps a goal when the held copy is a bad roll that auto-equip would reject', () => {
    const old = cand('old-hat', 'hat', 5, { stats: { strength: 20 } }).item
    const target = cand('target-hat', 'hat', 5, { stats: { strength: 40 } })
    const hero = character({
      level: 10,
      strength: 500,
      equipment: [{ ...old, id: 'worn-hat', slot: 'hat' }] as CharacterRow['equipment'],
    })
    const bad_roll = item('bad-roll', target.output_type, 'hat', {
      level: 5,
      stats: { ...Object.fromEntries(stat_names.map((stat) => [stat, SHIFT])), strength: SHIFT + 5 } as ItemRow['stats'],
    })

    const goals = plan_gear_goals([hero], state_with([bad_roll], [hero]), [target])
    expect(goals.map((goal) => goal.output_type)).toContain(target.output_type)
  })

  it('uses one held copy for only one character and keeps crafting for the other', () => {
    const target = cand('shared-hat', 'hat', 5, { stats: { strength: 40 } })
    const first = character({ id: 'c1', name: 'first', level: 10, strength: 500 })
    const second = character({ id: 'c2', name: 'second', level: 10, strength: 500 })
    const held = item('only-copy', target.output_type, 'hat', {
      level: 5,
      stats: target.item.stats as ItemRow['stats'],
    })

    const goals = plan_gear_goals([first, second], state_with([held], [first, second]), [target])
    expect(goals).toHaveLength(1)
    expect(goals[0]!.character_id).toBe(second.id)
    expect(goals[0]!.output_type).toBe(target.output_type)
  })

  it('is empty without a roster', () => {
    expect(plan_gear_goals([], state_with([]))).toEqual([])
  })
})

describe('equipment chain', () => {
  it('closes every real gear recipe on gatherable, lootable, or recursively craftable inputs', () => {
    const orphaned = new Set<string>()
    const cycles = new Set<string>()
    const visit = (item_type: string, path: ReadonlySet<string>): void => {
      if (gatherable_of(item_type) || (loot_sources_by_item.get(item_type)?.length ?? 0) > 0) return
      const recipe = recipes_by_output[item_type]
      if (!recipe) {
        orphaned.add(item_type)
        return
      }
      if (path.has(item_type)) {
        cycles.add(item_type)
        return
      }
      const next = new Set([...path, item_type])
      for (const input of Object.keys(recipe.inputs)) visit(input, next)
    }

    for (const candidate of gear_candidates) {
      const recipe = recipes_by_output[candidate.output_type]
      expect(recipe).toBeDefined()
      expect(candidate.job.length).toBeGreaterThan(0)
      expect(craft_required_level(Object.keys(recipe!.inputs).length)).toBeLessThanOrEqual(100)
      visit(candidate.output_type, new Set())
    }
    expect([...orphaned]).toEqual([])
    expect([...cycles]).toEqual([])
  })

  it('runs a real target through goal, craft plan, minted projection, and equip plan', () => {
    const hero = character({ id: 'crafter', level: 50, strength: 500 })
    const empty = state_with([], [hero])
    const goal = plan_gear_goals([hero], empty)[0]
    expect(goal).toBeDefined()

    const recipe = recipe_detail(recipes_by_output[goal!.output_type]!)
    const crafter = character({
      ...hero,
      jobs: { [recipe.job]: String(job_xp_for_level(100) ?? 0) },
    })
    const ingredients = recipe.ingredients.map((ingredient, index) =>
      item(`ingredient-${index}`, ingredient.item_type, items_by_type[ingredient.item_type]?.category ?? 'resource', {
        amount: ingredient.quantity,
      })
    )
    const craft = plan_recipe(crafter, recipe, ingredients, new Set(), true)
    expect(craft?.output_type).toBe(goal!.output_type)
    expect(craft?.attempts).toBe(1)
    expect(craft?.existing).toBeNull()

    const seed = items_by_type[goal!.output_type]!
    const rolled = expected_gear(seed)
    const minted = item('minted-upgrade', rolled.item_type, rolled.category, {
      level: rolled.level,
      stats: rolled.stats as ItemRow['stats'],
      damages: rolled.damages as ItemRow['damages'],
    })
    const landed = state_with([minted], [crafter])
    const loadout = plan_loadout(crafter, landed)
    const equip = equip_plan(crafter, loadout)
    expect(equip.to_equip.some((change) => change.item_id === minted.id && change.slot === goal!.slot)).toBe(true)
  })
})
