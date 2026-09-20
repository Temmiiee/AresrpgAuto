import { describe, expect, test } from 'bun:test'
import { create_character_source, create_fight, mob_scalar_for_level, player_max_hp } from '@aresrpg/fight'
import type { FightBoard, WeaponSource } from '@aresrpg/fight'

import { decide_turn } from '../src/ai/sim_decide.ts'
import { DEFAULT_POLICY } from '../src/ai/policy.ts'
import { all_spell_sources, find_mob_template } from '../src/ai/sim_content.ts'

const GRID_W = 20
const manhattan = (a: bigint, b: bigint): number =>
  Math.abs(Number(a % BigInt(GRID_W)) - Number(b % BigInt(GRID_W))) +
  Math.abs(Math.floor(Number(a) / GRID_W) - Math.floor(Number(b) / GRID_W))

// Real engine physics (move_contract.gen.ts WEAPON_PHYSICS): bow reaches 2-6, 4 AP.
const BOW: WeaponSource = { category: 'bow', damages: [{ element: 'air', from: 1n, to: 5n }] }

// A strike-only policy: spells score ~0 (base_weight 0) so a reachable strike always wins —
// isolates the strike geometry these tests are actually about, no spell-choice noise.
const STRIKE_ONLY = { ...DEFAULT_POLICY, base_weight: 0, strike_bias: 30 }

// Player pinned at cell 0, mob at cell 3 → manhattan distance 3: inside a bow's 2-6 reach, out
// of melee reach. create.ts's start_cell honors explicit input cells exactly.
// Explicit board so nothing about this test depends on the per-seed shape — wide-open 20x19
// (grid shape = cells 0..379; 5 full 64-bit words + 4 bits of the 6th).
const OPEN_BOARD: FightBoard = {
  width: 20n,
  height: 19n,
  shape_mask: [
    0xffffffffffffffffn,
    0xffffffffffffffffn,
    0xffffffffffffffffn,
    0xffffffffffffffffn,
    0xffffffffffffffffn,
    15n,
  ],
  obstacles: [],
  holes: [],
  start_cells_a: [0n],
  start_cells_b: [3n],
}

const build_on = (board: FightBoard, weapon: WeaponSource | null) => {
  const source = create_character_source({
    name: 'arrow',
    classe: 'yogan',
    level: 30n,
    vitality: 20n,
    wisdom: 10n,
    strength: 10n,
    intelligence: 10n,
    chance: 10n,
    agility: 10n,
    weapon,
  })
  const template = find_mob_template('protector_amber')
  const fight = create_fight({
    setup: {
      fight_id: 'weapon-test',
      world: 'sim',
      board,
      players: [
        { character: '0xarrow', owner: '0xowner', team: 0n, cell: 0n, ready: true, hp: player_max_hp(source), source },
      ],
      mobs: [{ team: 1n, cell: 3n, scalar: mob_scalar_for_level(template, 1n), template }],
      spells: all_spell_sources(),
    },
    mode: 'local',
    seed: 7n,
  })
  fight.apply({ type: 'start', observed_ms: 0n })
  return { state: fight.state(), max_hp: player_max_hp(source) }
}

describe("weapon-aware strike planning (sim_decide derives range from the actor's weapon)", () => {
  test('a bow lets the planner strike the mob from 2-6 cells away with a standing shot', () => {
    const { state, max_hp } = build_on(OPEN_BOARD, BOW)
    const player = state.contract.fighters[0]!
    const mob = state.contract.fighters[1]!

    expect(manhattan(player.cell, mob.cell)).toBe(3) // sanity: the pinned distance

    const plan = decide_turn(state, 0n, new Map([['0xarrow', max_hp]]), STRIKE_ONLY)

    const strike = plan.find((a) => a.type === 'weapon_strike')
    expect(strike).toBeDefined()
    expect(strike!.target_cell).toBe(mob.cell)
    // Standing shot: already within bow range (2-6), so no approach move is needed.
    expect(plan.some((a) => a.type === 'move_to')).toBe(false)
  })

  test('an unarmed fighter never strikes from farther than 1 cell (melee fallback unchanged)', () => {
    const { state, max_hp } = build_on(OPEN_BOARD, null)
    const player = state.contract.fighters[0]!

    const plan = decide_turn(state, 0n, new Map([['0xarrow', max_hp]]), STRIKE_ONLY)

    // Melee strikers may MOVE adjacent first — the strike itself must always land from 1 cell
    // away (measured from the fighter's position after any move in the plan).
    let strikes_from = player.cell
    for (const action of plan) {
      if (action.type === 'move_to') strikes_from = action.path[action.path.length - 1]!
      if (action.type === 'weapon_strike') {
        expect(manhattan(strikes_from, action.target_cell)).toBe(1)
      }
    }
  })
})
