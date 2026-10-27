// Fight selection: which live mob group is worth engaging. The bot spends real SUI per turn, so it
// screens groups with the SAME deterministic @aresrpg/fight twin the chain mirrors — free, local,
// no witness — and keeps only the ones the bot's own planner reliably wins in few turns. Among
// those it ranks by reward per turn. The twin is the single owner of combat math: this module adds
// no damage model of its own, it just replays the live door's OWN planner through it (plan_turn for
// a lone seat, plan_turn_party once allies are seated) and records every run's CAUSE — a timeout is
// "too slow to finish", never a silent loss — so the win rate says how sure, not just how often.
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
import { plan_turn, plan_turn_party, sim_commands } from './turn_plan.ts'

/** The pool sequential seeding draws from: the first SEED_BATCHES head (five runs) is the classic
 *  read; a verdict one win from the threshold re-samples to ten, then fifteen — the same boards
 *  extended, never re-rolled, so one lucky crit can never certify a fight. */
const PREVIEW_SEED_POOL: readonly bigint[] = Object.freeze(
  Array.from({ length: 15 }, (_, index) => BigInt(index + 1))
)
/** Cumulative run counts at which a borderline verdict may buy the next batch of seeds. */
const SEED_BATCHES: readonly number[] = Object.freeze([5, 10])
/** Sequential seeding never simulates past this many runs. */
const MAX_PREVIEW_SEEDS = 15
/** A group is only engaged when the twin wins at least this share of seeds — "sure to win". */
export const MIN_WIN_RATE = 0.8
/** Wins MAX_PREVIEW_SEEDS runs need to clear MIN_WIN_RATE — the horizon both early-locks use. */
const MAX_BATCH_WINS = Math.ceil(MIN_WIN_RATE * MAX_PREVIEW_SEEDS)
/** The roam's actor-turn budget: a solo fight got this many turns, i.e. 30/(1+mobs) ROUNDS. Kept
 *  as the roam's ceiling shape (see roam_rounds) so no preview tightens into a new timeout. */
const MAX_TURNS = 30
/** Rounds every roam preview gets at LEAST. The old actor formula shrank rounds as mobs were
 *  added — a six-mob group got 30/7 ≈ 4.3 rounds while roam wins average ~3.9 rounds — so slow
 *  wins read as losses and group previews collapsed toward 0%. */
const MIN_FIGHT_ROUNDS = 8
/** Dungeon rooms are judged over enough rounds to wipe the whole room: a slow-but-certain clear
 *  is a WIN (progression), not a timeout — turns/xp_per_turn still price its gas. */
export const DUNGEON_ROUNDS = 14
/** Screen at most this many nearest groups (each costs 5–15 sequential-seed local fights). */
const MAX_CANDIDATES = 6
/** The engine's turn floor: advancing a virtual clock past it keeps end_turn legal. */
const TURN_MIN_MS = 3_100n

export type GroupCandidate = Readonly<{ zone: ZoneRow; group: MobGroupRow }>

export type { MobGroupRow }
export { mob_inputs }

export type FightScore = Readonly<{
  /** share of preview runs the twin won */
  win_rate: number
  /** our own committed turns (the per-turn gas unit) averaged over the counted runs */
  turns: number
  xp_per_turn: number
  /** expected drop QUANTITY per turn — a tiebreak, not a value (see viable_ranking) */
  loot_per_turn: number
  /** runs actually simulated — sequential seeding stops early once the read is decided */
  seeds: number
  wins: number
  /** runs that hit the round budget while still standing — slow, NOT lost */
  timeouts: number
  /** runs the twin lost (the whole team dead) */
  wipes: number
}>

export type ScoredGroup = Readonly<{ candidate: GroupCandidate; score: FightScore }>

const ZERO_SCORE: FightScore = Object.freeze({
  win_rate: 0,
  turns: MAX_TURNS,
  xp_per_turn: 0,
  loot_per_turn: 0,
  seeds: 0,
  wins: 0,
  timeouts: 0,
  wipes: 0,
})

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

type RunCause = 'win' | 'wipe' | 'timeout'

type SimRun = Readonly<{ won: boolean; turns: number; xp: number; cause: RunCause }>

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

/** Replay one whole fight locally: our planner acts on our turns (the PARTY planner whenever
 *  other players are seated — exactly what combat.ts's live door drives), the engine resolves the
 *  mobs' turns inside `simulate_turn`. Returns the run's CAUSE alongside its result: a fight that
 *  exhausts the round budget is a timeout (too slow to call), never folded into "we lost". */
const run_once = (
  players: readonly FightPlayerInput[],
  mobs: readonly FightMobInput[],
  character_id: string,
  spells: Readonly<Record<string, SpellSource>>,
  seed: bigint,
  rounds: number
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
  // Seat order is stable (fighters are seeded in setup order), so the party seats are every OTHER
  // player seat — the same team-0-excluding-self scan combat.ts's door makes live.
  const player_seats = cp.contract.fighters.flatMap((fighter, index) =>
    fighter.kind.type === 'player' ? [index] : []
  )
  // A ROUND budget, not a raw actor cap: `turns` counts EVERY actor (our players and the mobs), so
  // the caller's `rounds` is scaled by the actor count here and every party size is judged over
  // the same number of rounds.
  const turn_budget = Math.round(rounds * (players.length + mobs.length))
  while (!cp.contract.ended && turns < turn_budget) {
    const actor = cp.contract.queue[Number(cp.contract.turn_ptr)]
    if (actor === undefined) break
    const fighter = cp.contract.fighters[Number(actor)]
    if (fighter && fighter.kind.type === 'player') {
      const party_seats = player_seats.filter((other) => other !== Number(actor))
      const plan =
        party_seats.length > 0 ? plan_turn_party(cp, Number(actor), party_seats) : plan_turn(cp, Number(actor))
      for (const command of sim_commands(plan, actor)) fight.apply(command)
    }
    virtual_ms += TURN_MIN_MS
    cp = fight.simulate_turn({ observed_ms: virtual_ms }).state
    turns += 1
  }
  const seat = cp.contract.fighters.findIndex(
    (fighter) => fighter.kind.type === 'player' && fighter.kind.character === character_id
  )
  const xp = cp.contract.ended && seat >= 0 ? Number(xp_award_of(cp, BigInt(seat))) : 0
  const cause: RunCause = !cp.contract.ended ? 'timeout' : cp.contract.winner === 0n ? 'win' : 'wipe'
  return { won: cause === 'win', turns, xp, cause }
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

export type ScoreOptions = Readonly<{
  /** Pin the exact seed list (the strategy brain's cheap fixed pass). Omit for sequential
   *  seeding: five runs first, a borderline read extended to ten, then fifteen. */
  seeds?: readonly bigint[]
  /** Simulated rounds; default is the roam's gas guard. Dungeon rooms pass a generous budget so a
   *  slow-but-certain clear reads as a win instead of a timeout. */
  rounds?: number
}>

/** Sequential seeding's stop rule: keep simulating after `ran` runs produced `wins` wins? A read
 *  stops three ways, all inside MAX_PREVIEW_SEEDS: (1) a horizon lock — no finish can flip the
 *  verdict, so both 12-of-15 locks fire early; (2) a batch boundary with a clean read (5/5 or
 *  ≤2/5 at five runs, 9+/10 or ≤6/10 at ten) is decided; (3) a borderline read — within one win of
 *  the threshold — buys the next batch of seeds instead of guessing off five boards. Pinned seed
 *  lists never consult this. Exported so the rule is testable without hunting a borderline fight. */
export const keep_sampling = (ran: number, wins: number): boolean => {
  if (ran >= MAX_PREVIEW_SEEDS) return false
  if (wins >= MAX_BATCH_WINS) return false // locked PASS: every remaining seed losing still clears MIN_WIN_RATE
  if (wins + (MAX_PREVIEW_SEEDS - ran) < MAX_BATCH_WINS) return false // locked FAIL: even a perfect finish cannot
  if (SEED_BATCHES.includes(ran)) {
    const needed = Math.ceil(MIN_WIN_RATE * ran)
    return wins >= needed - 1 && wins <= needed // one win from the threshold = borderline; else decided
  }
  return true
}

/** The roam's round budget: never TIGHTER than the old 30-actor-turn formula (30/(1+mobs) rounds)
 *  and never below MIN_FIGHT_ROUNDS, so adding mobs can no longer shrink a fight's rounds. */
const roam_rounds = (mob_count: number): number =>
  Math.max(MIN_FIGHT_ROUNDS, Math.ceil(MAX_TURNS / (1 + mob_count)))

/** `wins=4/5, timeouts=1, wipes=0` — the evidence behind a win rate: how the runs failed (a slow
 *  planner reads as a timeout, a lost fight as a wipe) instead of one number hiding both. */
export const describe_score = (score: FightScore): string =>
  `wins=${score.wins}/${score.seeds}, timeouts=${score.timeouts}, wipes=${score.wipes}`

/** Score a set of mob inputs by replaying the fight with the SAME deterministic twin the chain
 *  mirrors. A group that cannot be simulated scores non-viable rather than throwing the whole pass
 *  away. `allies` (a group fight's partners) join the replay so the win rate reflects the whole
 *  party, not just the leader — planned with the SAME party planner the live door drives. Sequential
 *  seeding (options.seeds omitted) runs five seeds first and extends only a borderline read to ten,
 *  then fifteen; a pinned seed list runs exactly as given, which keeps the periodic strategy
 *  brain's cheap pass cheap. The brain calls this directly, so ONE twin owns both the live group
 *  choice and the whole-content analysis. */
export const score_mobs = (
  character: CharacterRow,
  mobs: readonly FightMobInput[],
  allies: readonly CharacterRow[] = [],
  options: ScoreOptions = {}
): FightScore => {
  if (mobs.length === 0) return ZERO_SCORE
  const members: readonly CharacterRow[] = [character, ...allies]
  const sourced = members.map((member) => Object.freeze({ member, source: player_source_of(member) }))
  const players: readonly FightPlayerInput[] = sourced.map(({ member, source }) => player_input(member, source))
  // The planner only casts a seat's OWN spells, so the twin's catalog needs every ally's spellbook.
  const spells: Readonly<Record<string, SpellSource>> = Object.fromEntries(
    sourced.flatMap(({ source }) => Object.entries(preview_spells(source)))
  )
  const rounds = options.rounds ?? roam_rounds(mobs.length)
  const pinned = options.seeds
  const runs: SimRun[] = []
  let sampled_wins = 0
  try {
    for (const seed of pinned ?? PREVIEW_SEED_POOL) {
      const run = run_once(players, mobs, character.id, spells, seed, rounds)
      runs.push(run)
      if (run.won) sampled_wins += 1
      if (pinned === undefined && !keep_sampling(runs.length, sampled_wins)) break
    }
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
    seeds: runs.length,
    wins: wins.length,
    timeouts: runs.filter((run) => run.cause === 'timeout').length,
    wipes: runs.filter((run) => run.cause === 'wipe').length,
  })
}

/** Score one live group: its members as mob inputs, then the same twin replay. */
export const score_group = (
  character: CharacterRow,
  group: MobGroupRow,
  allies: readonly CharacterRow[] = [],
  options: ScoreOptions = {}
): FightScore => score_mobs(character, mob_inputs(group), allies, options)

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
