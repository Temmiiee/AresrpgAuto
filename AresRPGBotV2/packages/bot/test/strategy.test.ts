// strategy tests — the periodic "brain". These pin the pure selection rules: the scalar→level map, the
// gear goal routes + loot sources, the engage hint, and the farm scan's contract (a coarse RANKING of
// difficulty bands, never weaker than the engage's own win floor). The sim-backed paths use a tiny
// distance grid so the suite stays quick.
import { describe, expect, it } from 'bun:test'
import type { CharacterRow } from '@aresrpg/protocol'

import { MIN_WIN_RATE } from '../src/actions/fight_preview.ts'
import {
  compute_strategy,
  describe_strategy,
  plan_farm,
  plan_gear_targets,
  scaled_level,
} from '../src/actions/strategy.ts'
import { items_by_type, mobs_by_type, recipes_by_output } from '../src/content/catalog.ts'
import { initial_game_state, type GameState } from '../src/state/store.ts'

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

/** A character the twin can actually win with: one big weapon and enough folded stats to swing it. */
const hero = (level: number): CharacterRow =>
  character({
    level,
    equipment: [
      {
        id: 'w',
        slot: 'weapon',
        category: 'axe',
        item_type: 'lid_splitter',
        level: 3,
        damages: [{ element: 'earth', from: 200, to: 400, damage_type: 'weapon' }],
      },
    ] as CharacterRow['equipment'],
    folded_stats: { strength: 50_000, agility: 50_000, vitality: 50_000 },
  })

const state_with = (characters: readonly CharacterRow[]): GameState => ({
  ...initial_game_state,
  characters,
  inventory: [],
})

describe('scaled_level', () => {
  it('maps the scalar band ends onto the mob level band', () => {
    // ant_red is authored 12..28; scalar 0 is its floor, scalar 100 its ceiling.
    expect(scaled_level('ant_red', 0)).toBe(12)
    expect(scaled_level('ant_red', 100)).toBe(28)
    expect(scaled_level('not_a_mob', 50)).toBeNull()
  })
})

describe('plan_gear_targets', () => {
  it('annotates each goal with its route and defined loot sources', () => {
    const targets = plan_gear_targets([character({ level: 10 })], state_with([character({ level: 10 })]))
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      expect(items_by_type[target.item_type]).toBeDefined()
      expect(target.route).toBe(recipes_by_output[target.item_type] ? 'craft' : 'drop')
      for (const mob_type of target.source_mobs) expect(mobs_by_type[mob_type]).toBeDefined()
    }
  })
})

describe('compute_strategy', () => {
  it('derives the wanted mobs from the gear routes and reports on console', () => {
    const rows = [character({ level: 10 })]
    const strategy = compute_strategy(rows, state_with(rows), { now_ms: 123, distances: [] })
    expect(strategy.computed_ms).toBe(123)
    const wanted = new Set(strategy.gear.flatMap((target) => target.source_mobs))
    expect([...strategy.wanted_mobs].sort()).toEqual([...wanted].sort())
    expect(describe_strategy(strategy).length).toBeGreaterThan(0)
  })
})

describe('plan_farm', () => {
  it('is null when the party cannot win anything', () => {
    // A bare character has no weapon and no spells, so the twin never wins — no farm to name.
    expect(plan_farm([character({ level: 10 })], { distances: [5_000] })).toBeNull()
  })

  it('is null for a world with no mobs', () => {
    const empty = { world: 'empty', entry_level: 1, mobs: [], resources: [], cities: [] }
    expect(plan_farm([hero(5)], { world: empty })).toBeNull()
  })

  it('returns a winnable band with well-formed, ranked evidence', () => {
    const plan = plan_farm([hero(5)], { distances: [5_000, 10_000] })
    expect(plan).not.toBeNull()
    expect([5_000, 10_000]).toContain(plan!.distance)
    expect(plan!.samples.length).toBeGreaterThan(0)
    for (const sample of plan!.samples) {
      expect(sample.win_rate).toBeGreaterThanOrEqual(MIN_WIN_RATE)
      expect(sample.xp_per_turn).toBeGreaterThan(0)
      expect(sample.group_size).toBeGreaterThanOrEqual(1)
    }
    for (let index = 1; index < plan!.samples.length; index++)
      expect(plan!.samples[index - 1]!.xp_per_turn).toBeGreaterThanOrEqual(plan!.samples[index]!.xp_per_turn)
  })
})
