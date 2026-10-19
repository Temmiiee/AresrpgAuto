// turn planner tests — the damage ranking that decides which ATTACK a turn buys. A turn's cost is
// fixed by the chain (every turn is paced at its own floor whatever it contains), so the only lever
// on how long a fight lasts is how much enemy HP the turn removes. These tests pin that: a fighter
// whose damage spell is in range must CAST it, not punch with its bare fists (4 base damage, reach
// 1), and the same fighter must win a group it loses bare-handed.
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

import { mob_inputs, player_source_of, score_mobs } from '../src/actions/fight_preview.ts'
import { catalog_spell_sources } from '../src/content/fight_sources.ts'
import { plan_turn, plan_turn_party } from '../src/actions/turn_plan.ts'

const character = (over: Partial<CharacterRow> = {}): CharacterRow =>
  ({
    id: 'c1',
    name: 'planner',
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

/** The character the twin will drive: a level-50 yogan with NO weapon (bare fists, exactly the
 *  party's live situation) and every spell the seed catalog lets its class cast at that level. */
const spellbook: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(catalog_spell_sources())
    .filter(([, spell]) => spell.classe === 'yogan' && spell.unlock_level <= 50)
    .map(([name]) => [name, 5])
)

const fight_of = (rows: readonly CharacterRow[], mobs: readonly FightMobInput[]): HydratedFightCheckpoint => {
  const sourced = rows.map((row) => ({ row, source: player_source_of(row) }))
  const players: readonly FightPlayerInput[] = sourced.map(({ row, source }) => ({
    character: row.id,
    owner: '0x0',
    team: 0n,
    ready: true,
    hp: player_max_hp(source),
    source,
  }))
  const catalog = catalog_spell_sources()
  const spells: Readonly<Record<string, SpellSource>> = Object.fromEntries(
    sourced.flatMap(({ source }) => Object.keys(source.spell_levels).map((name) => [name, catalog[name]!] as const))
  )
  const fight = create_fight({
    setup: { fight_id: 'planner', world: 'planner', board_seed: 1n, players, mobs, spells },
    mode: 'local',
    seed: 1n,
  })
  fight.apply({ type: 'start', observed_ms: 0n })
  return fight.state()
}

/** Seat the mob on a cell the player's weapon ALREADY reaches, so the strike is legal and the only
 *  question left is which hit the planner wants. */
const within_reach = (
  cp: HydratedFightCheckpoint,
  seat: number,
  mob_seat: number,
  cell: bigint
): HydratedFightCheckpoint =>
  ({
    ...cp,
    contract: {
      ...cp.contract,
      fighters: cp.contract.fighters.map((fighter, index) => (index === mob_seat ? { ...fighter, cell } : fighter)),
    },
  }) as HydratedFightCheckpoint

const one_mob = group('ant_white', 50, 1)

const adjacent_setup = (row: CharacterRow) => {
  const cp = fight_of([row], [...mob_inputs(one_mob)])
  const seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player')
  const mob_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type !== 'player')
  const reachable = weapon_target_cells(cp, BigInt(seat)).targetable
  expect(reachable.length).toBeGreaterThan(0)
  return { cp: within_reach(cp, seat, mob_seat, reachable[0]!), seat }
}

describe('turn planner damage ranking', () => {
  it('casts a damage spell instead of punching when both are in reach', () => {
    const { cp, seat } = adjacent_setup(character({ spells: spellbook }))
    const actions = plan_turn_party(cp, seat, [])
    expect(actions.length).toBeGreaterThan(0)
    expect(actions[0]!.type).toBe('cast')
    expect(actions.some((action) => action.type === 'strike')).toBe(false)
  })

  it('still punches when the fighter has no spell invested', () => {
    const { cp, seat } = adjacent_setup(character())
    const actions = plan_turn_party(cp, seat, [])
    expect(actions[0]!.type).toBe('strike')
  })

  it('decides identically on the solo planner', () => {
    const { cp, seat } = adjacent_setup(character({ spells: spellbook }))
    expect(plan_turn(cp, seat)[0]!.type).toBe('cast')
    const bare = adjacent_setup(character())
    expect(plan_turn(bare.cp, bare.seat)[0]!.type).toBe('strike')
  })

  it('turns a bare-handed loss into a win on the very same group', () => {
    const bare = score_mobs(character(), mob_inputs(one_mob))
    const armed = score_mobs(character({ spells: spellbook }), mob_inputs(one_mob))
    expect(bare.win_rate).toBe(0)
    expect(armed.win_rate).toBe(1)
    expect(armed.turns).toBeLessThan(bare.turns)
  })
})
