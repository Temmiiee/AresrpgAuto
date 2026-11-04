// turn planner tests — the damage ranking that decides which ATTACK a turn buys. A turn's cost is
// fixed by the chain (every turn is paced at its own floor whatever it contains), so the only lever
// on how long a fight lasts is how much enemy HP the turn removes. These tests pin that: a fighter
// whose damage spell is in range must CAST it, not punch with its bare fists (4 base damage, reach
// 1), and the same fighter must win a group it loses bare-handed.
import {
  CONTRACT_CONSTANTS,
  create_fight,
  fight_approach_path,
  player_max_hp,
  weapon_target_cells,
  type FightMobInput,
  type FightPlayerInput,
  type HydratedFightCheckpoint,
  type SpellSource,
  type SpellTurnProjection,
} from '@aresrpg/fight'
import { AREA_SHAPES } from '@aresrpg/fight/move_contract'
import type { CharacterRow, MobGroupRow } from '@aresrpg/protocol'

import { mob_inputs, player_source_of, score_mobs } from '../src/actions/fight_preview.ts'
import { catalog_spell_sources } from '../src/content/fight_sources.ts'
import { compare_movement_scores, damage_target_cells, plan_turn, plan_turn_party } from '../src/actions/turn_plan.ts'

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

const spellbook_for = (classe: string): Readonly<Record<string, number>> => Object.fromEntries(
  Object.entries(catalog_spell_sources())
    .filter(([, spell]) => spell.classe === classe && spell.unlock_level <= 50)
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

const turn_of = (cp: HydratedFightCheckpoint, seat: number): HydratedFightCheckpoint =>
  ({
    ...cp,
    contract: {
      ...cp.contract,
      turn_ptr: BigInt(cp.contract.queue.indexOf(BigInt(seat))),
      fighters: cp.contract.fighters.map((fighter, index) => index === seat ? { ...fighter, ap: 6n, mp: 3n } : fighter),
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
  }, 15000)
})

describe('party movement anti-stalemate policy', () => {
  it('closes distance despite non-lethal chip damage when neither position enables an attack', () => {
    // tuple: actor dies, party deaths, no attack, -attack damage, distance, incoming party damage
    const camping = [0, 0, 1, 0, 13, 0]
    const advancing = [0, 0, 1, 0, 10, 20]
    expect(compare_movement_scores(advancing, camping)).toBeLessThan(0)
  })

  it('still refuses a lethal advance', () => {
    const camping = [0, 0, 1, 0, 13, 0]
    const lethal = [1, 1, 1, 0, 10, 200]
    expect(compare_movement_scores(lethal, camping)).toBeGreaterThan(0)
  })

  it('finds a legal full-board detour whose first step temporarily increases Manhattan distance', () => {
    const cp = fight_of([character()], [...mob_inputs(one_mob)])
    const seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player')
    const mob_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type !== 'player')
    const start = 52n // (2,2)
    const target = 54n // (4,2)
    const blocking_cell = 53n // the direct eastward step
    const closed = Array.from({ length: Number(CONTRACT_CONSTANTS.mask_words) }, () => 0n)
    closed[Number(blocking_cell / 64n)]! |= 1n << (blocking_cell % 64n)
    const maze = {
      ...cp,
      contract: {
        ...cp.contract,
        closed,
        fighters: cp.contract.fighters.map((fighter, index) =>
          index === seat
            ? { ...fighter, cell: start, mp: 3n }
            : index === mob_seat
              ? { ...fighter, cell: target }
              : fighter
        ),
      },
    } as HydratedFightCheckpoint

    const path = fight_approach_path(maze, BigInt(seat), target)
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(0)
    const distance = (cell: bigint): number => {
      const width = BigInt(CONTRACT_CONSTANTS.grid_w)
      const dx = cell % width - target % width
      const dy = cell / width - target / width
      return Number((dx < 0n ? -dx : dx) + (dy < 0n ? -dy : dy))
    }
    expect(distance(path![0]!)).toBeGreaterThan(distance(start))
  })
})

describe('shared tactical action scoring', () => {
  it('lets Tomoda attack when no ally can benefit from a heal', () => {
    const healer = character({ id: 'tomoda', classe: 'tomoda', spells: { 'Animal Healing': 5, Whip: 5 } })
    const ally = character({ id: 'yajin', classe: 'yajin' })
    const cp = fight_of([healer, ally], [...mob_inputs(one_mob)])
    const seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player' && fighter.kind.character === 'tomoda')
    const ally_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player' && fighter.kind.character === 'yajin')
    const mob_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type !== 'player')
    const adjacent = turn_of(within_reach(cp, seat, mob_seat, weapon_target_cells(cp, BigInt(seat)).targetable[0]!), seat)
    const actions = plan_turn_party(adjacent, seat, [ally_seat])
    expect(actions[0]?.type).toBe('cast')
    expect(actions[0]?.type === 'cast' && actions[0].spell).toBe('Whip')
  })

  it('heals an ally with critical missing HP before spending the turn on damage', () => {
    const healer = character({ id: 'tomoda-heal', classe: 'tomoda', spells: { 'Animal Healing': 5, Whip: 5 } })
    const ally = character({ id: 'yajin-wounded', classe: 'yajin' })
    const cp = fight_of([healer, ally], [...mob_inputs(one_mob)])
    const seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player' && fighter.kind.character === 'tomoda-heal')
    const ally_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player' && fighter.kind.character === 'yajin-wounded')
    const mob_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type !== 'player')
    const fighters = cp.contract.fighters.map((fighter, index) => index === ally_seat ? { ...fighter, hp: 1n } : fighter)
    const wounded = { ...cp, contract: { ...cp.contract, fighters } } as HydratedFightCheckpoint
    const adjacent = turn_of(within_reach(wounded, seat, mob_seat, weapon_target_cells(wounded, BigInt(seat)).targetable[0]!), seat)
    const actions = plan_turn_party(adjacent, seat, [ally_seat])
    expect(actions[0]?.type).toBe('cast')
    expect(actions[0]?.type === 'cast' && actions[0].spell).toBe('Animal Healing')
  })

  it('uses the same party-aware decision in solo and party entry points', () => {
    const tomoda = character({ id: 'tomoda', classe: 'tomoda', spells: spellbook_for('tomoda') })
    const yajin = character({ id: 'yajin', classe: 'yajin', spells: spellbook_for('yajin') })
    const cp = fight_of([tomoda, yajin], [...mob_inputs(one_mob)])
    const seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player' && fighter.kind.character === 'tomoda')
    const ally_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player' && fighter.kind.character === 'yajin')
    const mob_seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type !== 'player')
    const target = weapon_target_cells(cp, BigInt(seat)).targetable[0]!
    const adjacent = turn_of(within_reach(cp, seat, mob_seat, target), seat)
    expect(plan_turn(adjacent, seat)).toEqual(plan_turn_party(adjacent, seat, [ally_seat]))
  })
})

const spell_projection = (area_shape: bigint): SpellTurnProjection =>
  ({ effects: [{ area_shape }] }) as unknown as SpellTurnProjection

describe('damage target cells', () => {
  const enemy_cells = new Set([12n, 13n])

  it('requires an occupied target cell for point damage', () => {
    expect(
      damage_target_cells([10n, 12n, 14n], spell_projection(AREA_SHAPES.point), enemy_cells, () => [])
    ).toEqual([12n])
  })

  it('allows an empty legal centre when its area reaches an enemy', () => {
    expect(
      damage_target_cells(
        [10n, 11n, 14n],
        spell_projection(999n),
        enemy_cells,
        (cell) => cell === 10n ? [10n, 12n] : cell === 11n ? [11n, 13n] : [14n]
      )
    ).toEqual([10n, 11n])
  })

  it('rejects area centres that do not hit an enemy', () => {
    expect(damage_target_cells([10n, 14n], spell_projection(999n), enemy_cells, () => [99n])).toEqual([])
  })

  it('returns no candidates when the projection is unavailable', () => {
    expect(damage_target_cells([12n], null, enemy_cells, () => [12n])).toEqual([])
  })
})
