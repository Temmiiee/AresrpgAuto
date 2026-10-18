// Fight selection: which live mob group is worth engaging. The bot spends real SUI per turn, so it
// screens groups with the SAME deterministic @aresrpg/fight twin the chain mirrors — free, local,
// no witness — and keeps only the ones the bot's own planner reliably wins in few turns. Among
// those it ranks by reward per turn. The twin is the single owner of combat math: this module adds
// no damage model of its own, it just replays plan_turn through it.
import {
  create_character_source,
  create_fight,
  player_max_hp,
  xp_award_of,
  type FightMobInput,
  type FightPlayerInput,
  type HydratedFightCheckpoint,
  type MobLoot,
  type PlayerSource,
  type SpellSource,
  type WeaponSource,
} from '@aresrpg/fight'
import type { CharacterRow, MobGroupRow, ZoneRow } from '@aresrpg/protocol'

import { catalog_spell_sources, mob_template_of } from '../content/fight_sources.ts'
import { log_warn } from '../shared/logger.ts'
import { plan_turn, sim_commands } from './turn_plan.ts'

/** Distinct local seeds per candidate: one board/turn stream each, so a single lucky crit cannot
 *  certify a fight. */
const PREVIEW_SEEDS: readonly bigint[] = Object.freeze([1n, 2n, 3n, 4n, 5n])
/** A group is only engaged when the twin wins at least this share of seeds — "sure to win". */
export const MIN_WIN_RATE = 0.8
/** A fight our planner cannot end within this many actor-turns costs more gas than it is worth;
 *  exceeding it counts as a loss. This is a ROUND budget: `run_once` scales it by the actor count
 *  so a four-player party gets the same number of rounds as a solo character, rather than being
 *  cut off early by four extra players inflating the turn counter. */
const MAX_TURNS = 30
/** Screen at most this many nearest groups (each costs PREVIEW_SEEDS local fights). */
const MAX_CANDIDATES = 6
/** The engine's turn floor: advancing a virtual clock past it keeps end_turn legal. */
const TURN_MIN_MS = 3_100n

export type GroupCandidate = Readonly<{ zone: ZoneRow; group: MobGroupRow }>

export type { MobGroupRow }
export { mob_inputs }

export type FightScore = Readonly<{
  /** share of preview seeds the twin won */
  win_rate: number
  /** our own committed turns (the per-turn gas unit) averaged over the counted runs */
  turns: number
  xp_per_turn: number
  /** expected drop QUANTITY per turn — a tiebreak, not a value (see viable_ranking) */
  loot_per_turn: number
}>

export type ScoredGroup = Readonly<{ candidate: GroupCandidate; score: FightScore }>

const ZERO_SCORE: FightScore = Object.freeze({ win_rate: 0, turns: MAX_TURNS, xp_per_turn: 0, loot_per_turn: 0 })

const bigint_record = (row: Readonly<Record<string, number>> | undefined): Readonly<Record<string, bigint>> =>
  Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, BigInt(value)]))

/** The equipped weapon's damage lines as @aresrpg/fight wants them, or null when unarmed. */
const weapon_source_of = (character: CharacterRow): WeaponSource | null => {
  const worn = character.equipment.find((item) => item.slot === 'weapon')
  if (!worn?.damages || worn.damages.length === 0) return null
  return {
    category: worn.category,
    damages: worn.damages.map((line) => ({ element: line.element, from: BigInt(line.from), to: BigInt(line.to) })),
  }
}

/** The character's fight replay source, built from the chain's OWN projected facts: the equipment
 *  fold it already computed (`folded_stats`) and the equipped weapon's damage lines. */
export const player_source_of = (character: CharacterRow): PlayerSource =>
  create_character_source({
    name: character.name,
    classe: character.classe,
    sex: character.sex,
    color_1: character.color_1,
    color_2: character.color_2,
    color_3: character.color_3,
    level: BigInt(character.level),
    experience: BigInt(character.experience),
    vitality: BigInt(character.vitality),
    wisdom: BigInt(character.wisdom),
    strength: BigInt(character.strength),
    intelligence: BigInt(character.intelligence),
    chance: BigInt(character.chance),
    agility: BigInt(character.agility),
    spell_levels: bigint_record(character.spells),
    folded_stats: bigint_record(character.folded_stats),
    weapon: weapon_source_of(character),
  })

/** The group's members as local mob inputs. `level_scalar` is the zero..hundred the zone seed drew
 *  (NOT a level): create_mob_snapshot maps it onto the template's level band, exactly as the chain
 *  does. Members whose type is absent from the seed are dropped (the chain refuses them too). */
const mob_inputs = (group: MobGroupRow): readonly FightMobInput[] =>
  group.members.flatMap((member) => {
    const template = mob_template_of(member.mob_type)
    return template ? [{ team: 1n, template, scalar: BigInt(member.level_scalar) }] : []
  })

const drop_mean = (drop: MobLoot): number =>
  (Number(drop.chance_bp) / 10_000) * ((Number(drop.min_qty) + Number(drop.max_qty)) / 2)

const expected_loot_units = (mobs: readonly FightMobInput[]): number =>
  mobs.reduce((total, mob) => total + mob.template.loot.reduce((sum, drop) => sum + drop_mean(drop), 0), 0)

type SimRun = Readonly<{ won: boolean; turns: number; xp: number }>

/** Only the character's OWN spells are ever cast by the planner, so the preview hands the twin
 *  just those — not the whole seed catalog. The engine deep-clones sources on every snapshot, and
 *  a full catalog makes that clone dominate the pass. */
const preview_spells = (source: PlayerSource): Readonly<Record<string, SpellSource>> => {
  const catalog = catalog_spell_sources()
  return Object.fromEntries(
    Object.keys(source.spell_levels)
      .map((name) => [name, catalog[name]] as const)
      .filter((entry): entry is readonly [string, SpellSource] => entry[1] !== undefined)
  )
}

/** Replay one whole fight locally: our planner acts on our turns, the engine resolves the mobs'
 *  turns inside `simulate_turn`. Returns whether we won, how many of OUR turns it took, and the
 *  exact XP the chain would award (xp_award_of is the chain's own settlement formula). */
const run_once = (
  players: readonly FightPlayerInput[],
  mobs: readonly FightMobInput[],
  character_id: string,
  spells: Readonly<Record<string, SpellSource>>,
  seed: bigint
): SimRun => {
  const fight = create_fight({
    setup: {
      fight_id: 'preview',
      world: 'preview',
      board_seed: seed,
      players: [...players],
      mobs: [...mobs],
      spells: { ...spells },
    },
    mode: 'local',
    seed,
  })
  fight.apply({ type: 'start', observed_ms: 0n })
  let cp: HydratedFightCheckpoint = fight.state()
  let virtual_ms = 0n
  let turns = 0
  // `turns` counts EVERY actor (our players and the mobs), so the raw cap would cut a party off
  // early: four players add four actors per round and the same MAX_TURNS then buys far fewer
  // rounds than a solo character gets. Scale the budget by the actor count so every party size is
  // judged over the same number of ROUNDS — solo is unchanged (actor_count === 1 + mobs).
  const actor_count = players.length + mobs.length
  const turn_budget = Math.round((MAX_TURNS * actor_count) / (1 + mobs.length))
  while (!cp.contract.ended && turns < turn_budget) {
    const actor = cp.contract.queue[Number(cp.contract.turn_ptr)]
    if (actor === undefined) break
    const fighter = cp.contract.fighters[Number(actor)]
    if (fighter && fighter.kind.type === 'player') {
      for (const command of sim_commands(plan_turn(cp, Number(actor)), actor)) fight.apply(command)
    }
    virtual_ms += TURN_MIN_MS
    cp = fight.simulate_turn({ observed_ms: virtual_ms }).state
    turns += 1
  }
  const seat = cp.contract.fighters.findIndex(
    (fighter) => fighter.kind.type === 'player' && fighter.kind.character === character_id
  )
  const xp = cp.contract.ended && seat >= 0 ? Number(xp_award_of(cp, BigInt(seat))) : 0
  return { won: cp.contract.ended && cp.contract.winner === 0n, turns, xp }
}

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

/** The player's fight input. HP starts from the character's persisted HP, clamped to the max and to
 *  at least 1: a preview that assumed full HP while the character is hurt would certify a fight the
 *  chain starts at a disadvantage. Regen only ever raises HP, so the stored value is the safe floor. */
const player_input = (character: CharacterRow, source: PlayerSource): FightPlayerInput => {
  const max = player_max_hp(source)
  const stored = character.hp === undefined ? max : BigInt(character.hp)
  const hp = stored < 1n ? 1n : stored > max ? max : stored
  return { character: character.id, owner: '0x0', team: 0n, ready: true, hp, source }
}

/** Score a set of mob inputs by replaying the fight across `seeds` with the SAME deterministic twin
 *  the chain mirrors. A group that cannot be simulated scores non-viable rather than throwing the
 *  whole pass away. `allies` (a group fight's partners) join the replay so the win rate reflects the
 *  whole party, not just the leader. The periodic strategy brain synthesizes seed mobs and calls this
 *  directly, so ONE twin owns both the live group choice and the whole-content analysis. */
export const score_mobs = (
  character: CharacterRow,
  mobs: readonly FightMobInput[],
  allies: readonly CharacterRow[] = [],
  seeds: readonly bigint[] = PREVIEW_SEEDS
): FightScore => {
  if (mobs.length === 0) return ZERO_SCORE
  const members: readonly CharacterRow[] = [character, ...allies]
  const sourced = members.map((member) => Object.freeze({ member, source: player_source_of(member) }))
  const players: readonly FightPlayerInput[] = sourced.map(({ member, source }) => player_input(member, source))
  // The planner only casts a seat's OWN spells, so the twin's catalog needs every ally's spellbook.
  const spells: Readonly<Record<string, SpellSource>> = Object.fromEntries(
    sourced.flatMap(({ source }) => Object.entries(preview_spells(source)))
  )
  let runs: readonly SimRun[]
  try {
    runs = seeds.map((seed) => run_once(players, mobs, character.id, spells, seed))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log_warn('preview', `could not simulate a group: ${detail}`)
    return ZERO_SCORE
  }
  const wins = runs.filter((run) => run.won)
  const counted = wins.length > 0 ? wins : runs
  const turns = average(counted.map((run) => run.turns))
  const xp = average(wins.map((run) => run.xp))
  const loot = expected_loot_units(mobs)
  return Object.freeze({
    win_rate: runs.length > 0 ? wins.length / runs.length : 0,
    turns,
    xp_per_turn: turns > 0 ? xp / turns : 0,
    loot_per_turn: turns > 0 ? loot / turns : 0,
  })
}

/** Score one live group: its members as mob inputs, then the same twin replay. */
export const score_group = (
  character: CharacterRow,
  group: MobGroupRow,
  allies: readonly CharacterRow[] = []
): FightScore => score_mobs(character, mob_inputs(group), allies)

const distance_to = (pose: Readonly<{ x: number; z: number }>, point: Readonly<{ x: number; z: number }>): number =>
  Math.hypot(pose.x - point.x, pose.z - point.z)

/** Score up to MAX_CANDIDATES nearest groups, nearest first. Simulating is free but not instant,
 *  and a far group costs travel gas anyway, so the near ones are screened first. */
export const screen_groups = (
  pose: Readonly<{ x: number; z: number }>,
  candidates: readonly GroupCandidate[],
  character: CharacterRow,
  allies: readonly CharacterRow[] = []
): readonly ScoredGroup[] =>
  nearest_candidates(pose, candidates).map((candidate) =>
    Object.freeze({ candidate, score: score_group(character, candidate.group, allies) })
  )

/** The nearest candidates the preview screens — the ONE definition of "what engage considers", so
 *  the roam's hold/move verdict and the engage's fight choice never disagree about the same spot. */
export const nearest_candidates = (
  pose: Readonly<{ x: number; z: number }>,
  candidates: readonly GroupCandidate[],
  limit: number = MAX_CANDIDATES
): readonly GroupCandidate[] =>
  [...candidates].sort((left, right) => distance_to(pose, left.group) - distance_to(pose, right.group)).slice(0, limit)

/** A shared empty set so the common "no strategy preference" call allocates nothing. */
const EMPTY_WANTED: ReadonlySet<string> = Object.freeze(new Set<string>())

/** How many members of a group are mobs whose loot the periodic strategy currently wants. Helps a
 *  group that can drop a wanted upgrade win a tie against an equally-valued group that cannot. */
const wanted_hits = (
  group: Readonly<{ members: readonly Readonly<{ mob_type: string }>[] }>,
  wanted: ReadonlySet<string>
): number => {
  if (wanted.size === 0) return 0
  let hits = 0
  for (const member of group.members) if (wanted.has(member.mob_type)) hits += 1
  return hits
}

/** The sure-win groups, best reward per turn first. Loot only breaks ties: there is no live price
 *  feed, and turning expected drop quantity into an additive "value" is exactly how a trivial
 *  high-drop fight outranks a hard, high-XP one (the Old bot's 1-xp lesson). Ties then fall to
 *  fewer turns, then to the closer group.
 *
 *  When `party_size > 1` (group fight), we bias toward LARGER mob groups because:
 *  - 4 players kill more mobs per round → fight ends in similar turns but yields more total drops
 *  - Monster drops are the bottleneck for crafting (HANDYMAN tools, etc.)
 *  The bias is a soft multiplier on loot_per_turn so XP still matters but drops count more.
 *
 *  `wanted_mobs` (the periodic strategy's gear-drop set) is a FURTHER tiebreak below value: among
 *  equally valuable groups, prefer one carrying a mob whose loot the party wants. Empty changes
 *  nothing. */
export const viable_ranking = (
  pose: Readonly<{ x: number; z: number }>,
  scored: readonly ScoredGroup[],
  party_size: number = 1,
  wanted_mobs: ReadonlySet<string> = EMPTY_WANTED
): readonly ScoredGroup[] => {
  const loot_weight = party_size > 1 ? party_size * 0.5 : 0 // 1.0 for duo, 1.5 for trio, 2.0 for 4
  return scored
    .filter(({ score }) => score.win_rate >= MIN_WIN_RATE)
    .sort(
      (left, right) => {
        const left_mobs = left.candidate.group.members.length
        const right_mobs = right.candidate.group.members.length
        const left_val = left.score.xp_per_turn + left.score.loot_per_turn * loot_weight
        const right_val = right.score.xp_per_turn + right.score.loot_per_turn * loot_weight
        return (
          right_val - left_val ||
          // Among equal value, prefer a group carrying a mob whose loot the strategy wants
          wanted_hits(right.candidate.group, wanted_mobs) - wanted_hits(left.candidate.group, wanted_mobs) ||
          // Among equal value, prefer MORE mobs (more drops per fight)
          right_mobs - left_mobs ||
          left.score.turns - right.score.turns ||
          distance_to(pose, left.candidate.group) - distance_to(pose, right.candidate.group)
        )
      }
    )
}
