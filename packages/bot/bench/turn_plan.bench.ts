
import { performance } from 'node:perf_hooks'
import {
  create_fight,
  player_max_hp,
  type FightMobInput,
  type FightPlayerInput,
  type HydratedFightCheckpoint,
  type SpellSource,
} from '@aresrpg/fight'
import type { CharacterRow, MobGroupRow } from '@aresrpg/protocol'

import { mob_inputs, player_source_of } from '../src/actions/fight_preview.ts'
import { plan_turn, plan_turn_party } from '../src/actions/turn_plan.ts'
import { catalog_spell_sources } from '../src/content/fight_sources.ts'

const character = (id: string): CharacterRow =>
  ({
    id,
    name: `bench-${id}`,
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
    spells: Object.fromEntries(
      Object.entries(catalog_spell_sources())
        .filter(([, spell]) => spell.classe === 'yogan' && spell.unlock_level <= 50)
        .map(([name]) => [name, 5])
    ),
    available_spell_points: 0,
    jobs: {},
    kiosk: 'kiosk-1',
    equipment: [],
  }) as CharacterRow

const group = (count: number): MobGroupRow =>
  ({
    index: 0,
    x: 0,
    z: 0,
    members: Array.from({ length: count }, () => ({
      mob_type: 'ant_white',
      level_scalar: 50,
    })),
  }) as MobGroupRow

const fight_of = (
  rows: readonly CharacterRow[],
  mob_count: number
): HydratedFightCheckpoint => {
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
    sourced.flatMap(({ source }) =>
      Object.keys(source.spell_levels).map((name) => [name, catalog[name]!] as const)
    )
  )

  const fight = create_fight({
    setup: {
      fight_id: 'planner-benchmark',
      world: 'planner-benchmark',
      board_seed: 1n,
      players,
      mobs: [...mob_inputs(group(mob_count))] as FightMobInput[],
      spells,
    },
    mode: 'local',
    seed: 1n,
  })

  fight.apply({ type: 'start', observed_ms: 0n })
  return fight.state()
}

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
}

const benchmark = (
  label: string,
  cp: HydratedFightCheckpoint,
  seat: number,
  allies: readonly number[],
  party: boolean
): void => {
  const run = () =>
    party
      ? plan_turn_party(cp, seat, allies)
      : plan_turn(cp, seat)

  // Warm-up: évite de mesurer principalement le démarrage du moteur JS.
  for (let i = 0; i < 5; i++) run()

  const durations: number[] = []
  let total_actions = 0

  for (let i = 0; i < 30; i++) {
    const start = performance.now()
    const actions = run()
    durations.push(performance.now() - start)
    total_actions += actions.length
  }

  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length

  console.log(`\n${label}`)
  console.log(`  Actions moyennes : ${(total_actions / durations.length).toFixed(2)}`)
  console.log(`  Moyenne          : ${mean.toFixed(3)} ms`)
  console.log(`  Médiane          : ${percentile(durations, 0.5).toFixed(3)} ms`)
  console.log(`  P95              : ${percentile(durations, 0.95).toFixed(3)} ms`)
}

const solo_cases = [1, 3, 6]

for (const mob_count of solo_cases) {
  const cp = fight_of([character('solo')], mob_count)
  const seat = cp.contract.fighters.findIndex((fighter) => fighter.kind.type === 'player')

  benchmark(`SOLO — 1 joueur / ${mob_count} ennemis`, cp, seat, [], false)
}

{
  const cp = fight_of([character('party-1'), character('party-2')], 3)
  const seats = cp.contract.fighters
    .map((fighter, index) => fighter.kind.type === 'player' ? index : -1)
    .filter((index) => index >= 0)

  benchmark(
    'PARTY — 2 joueurs / 3 ennemis',
    cp,
    seats[0]!,
    seats.slice(1),
    true
  )
}
