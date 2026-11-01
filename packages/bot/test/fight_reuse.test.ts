// Fight-engine reuse contract: the planner forks a checkpoint for every candidate action, so it
// uses `hydrated: true` (skip the wire decoder, share the frozen sources) and can either create a
// fresh engine per candidate or rewind one with `reset_turn()`. These tests pin that both roads
// produce byte-identical checkpoints and events to the fully-normalizing path.
import { expect, it } from 'bun:test'
import {
  create_fight,
  player_max_hp,
  weapon_target_cells,
  type FightMobInput,
  type FightPlayerInput,
  type HydratedFightCheckpoint,
  type SpellSource,
} from '@aresrpg/fight'
import type { CharacterRow, MobGroupRow } from '@aresrpg/protocol'

import { mob_inputs, player_source_of } from '../src/actions/fight_preview.ts'
import { catalog_spell_sources } from '../src/content/fight_sources.ts'

const character = (over: Partial<CharacterRow> = {}): CharacterRow =>
  ({
    id: 'c1',
    name: 'reuse',
    classe: 'yogan',
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

const group = (mob_type: string, level_scalar: number, count: number): MobGroupRow =>
  ({ index: 0, x: 0, z: 0, members: Array.from({ length: count }, () => ({ mob_type, level_scalar })) }) as MobGroupRow

const spellbook: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(catalog_spell_sources())
    .filter(([, spell]) => spell.classe === 'yogan' && spell.unlock_level <= 50)
    .map(([name]) => [name, 5])
)

const fight_of = (row: CharacterRow, mobs: readonly FightMobInput[]): HydratedFightCheckpoint => {
  const source = player_source_of(row)
  const players: readonly FightPlayerInput[] = [
    { character: row.id, owner: '0x0', team: 0n, ready: true, hp: player_max_hp(source), source },
  ]
  const spells: Readonly<Record<string, SpellSource>> = Object.fromEntries(
    Object.keys(source.spell_levels).map((name) => [name, catalog_spell_sources()[name]!] as const)
  )
  const fight = create_fight({
    setup: { fight_id: 'reuse', world: 'reuse', board_seed: 1n, players, mobs, spells },
    mode: 'local',
    seed: 1n,
  })
  fight.apply({ type: 'start', observed_ms: 0n })
  return fight.state()
}

/** Seat the mob on a cell the player's weapon already reaches. */
const adjacent_setup = () => {
  const row = character({ spells: spellbook })
  const cp = fight_of(row, [...mob_inputs(group('ant_white', 50, 1))])
  const seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player')
  const mob_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type !== 'player')
  const cell = weapon_target_cells(cp, BigInt(seat)).targetable[0]!
  const state = {
    ...cp,
    contract: {
      ...cp.contract,
      fighters: cp.contract.fighters.map((fighter, index) => (index === mob_seat ? { ...fighter, cell } : fighter)),
    },
  } as HydratedFightCheckpoint
  return { cp: state, seat, cell }
}

it('hydrated creation forks the same checkpoint and events as full normalization', () => {
  const { cp, seat, cell } = adjacent_setup()
  const action = { type: 'weapon_strike' as const, fighter: BigInt(seat), target_cell: cell }

  const hydrated = create_fight({ state: cp, mode: 'local', seed: 1n, hydrated: true })
  expect(hydrated.state()).toEqual(cp)
  const fast = hydrated.apply(action)

  const normal = create_fight({ state: cp, mode: 'local', seed: 1n })
  const slow = normal.apply(action)

  expect(fast.error).toBeNull()
  expect(fast.state).toEqual(slow.state)
  expect(fast.events).toEqual(slow.events)
})

it('shares the immutable sources instead of cloning them on every snapshot', () => {
  const { cp, seat, cell } = adjacent_setup()
  const engine = create_fight({ state: cp, mode: 'local', seed: 1n, hydrated: true })
  expect(engine.state().sources).toBe(cp.sources)
  const applied = engine.apply({ type: 'weapon_strike', fighter: BigInt(seat), target_cell: cell })
  expect(applied.state.sources).toBe(cp.sources)
  expect(Object.isFrozen(applied.state.sources)).toBe(true)
})

it('reset_turn rewinds to the same base and replays the same checkpoint and events', () => {
  const { cp, seat, cell } = adjacent_setup()
  const action = { type: 'weapon_strike' as const, fighter: BigInt(seat), target_cell: cell }

  const fresh = create_fight({ state: cp, mode: 'local', seed: 1n, hydrated: true })
  const reference = fresh.apply(action)

  const reused = create_fight({ state: cp, mode: 'local', seed: 1n, hydrated: true })
  reused.apply(action)
  const rewound = reused.reset_turn()
  expect(rewound.error).toBeNull()
  expect(rewound.state).toEqual(cp)

  const replay = reused.apply(action)
  expect(replay.error).toBeNull()
  expect(replay.state).toEqual(reference.state)
  expect(replay.events).toEqual(reference.events)
})
