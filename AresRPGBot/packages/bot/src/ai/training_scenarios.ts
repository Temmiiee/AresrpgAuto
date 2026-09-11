// Generates varied training/eval scenarios instead of one fixed party against two fixed
// matchups — different party levels, different mob families/counts/levels, and (implicitly,
// since simulate_fight's seed also drives board_seed) different maps. A policy that only ever
// saw one easy matchup can't have learned anything general; this is what makes the evolutionary
// search in cli_train.ts actually have something to select for.
import { PRIMARY_STAT_BY_CLASS, split_stat_spending } from './stat_allocation.ts'
import { all_mob_rows } from './sim_content.ts'
import { simulate_many, type SimMobGroupMember, type SimPartyMember } from './simulate.ts'
import { DEFAULT_POLICY } from './policy.ts'

// A small mulberry32 PRNG so scenario generation is reproducible across runs (same seed number
// -> same training set), independent from the fight engine's own internal seeding.
export const make_rng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
const int_between = (rng: () => number, low: number, high: number): number => low + Math.floor(rng() * (high - low + 1))
const pick_distinct = <T>(rng: () => number, items: readonly T[], count: number): T[] => {
  const pool = [...items]
  const picked: T[] = []
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const idx = Math.floor(rng() * pool.length)
    picked.push(pool[idx]!)
    pool.splice(idx, 1)
  }
  return picked
}

// The starter-zone families — everything a party in roughly the 1-30 level band would actually
// encounter. Excludes the much-higher-level protector_* mining line (now split into 3 separate
// families -- protector_bricheton/gaia/miner, level 1-110 each -- still excluded for the same
// reason) so random rolls don't generate absurd mismatches no early party would ever face.
// boar/bramble/lorito/nook/tinker added 2026-09-04 after a game content update introduced them,
// all confirmed level 1-25 -- same tier as the families already here.
const STARTER_FAMILIES = ['ant', 'aragne', 'boar', 'bramble', 'crab', 'crowani', 'fuwa', 'lorito', 'misui', 'moka', 'nook', 'tinker']
const ALL_MOB_ROWS = all_mob_rows()
const STARTER_MOBS = ALL_MOB_ROWS.filter((m) => STARTER_FAMILIES.includes(m.family))

// All 12 real classes (2026-09-04, widened from a hardcoded 4 that happened to match this bot's
// own party_config.ts) -- widening this only became safe once stat_allocation.ts's
// PRIMARY_STAT_BY_CLASS covered all 12 too; before that fix, the other 8 would have simulated
// with every point dumped into vitality and zero caster_damage_multiplier bonus regardless of
// their spells' real quality, which would have handicapped them unfairly in any comparison.
export const CLASSES = ['asobi', 'ikari', 'iyashi', 'mori', 'rojin', 'senshi', 'shugo', 'shusen', 'tokei', 'tomoda', 'yajin', 'yogan'] as const
const NAMES = ['p1', 'p2', 'p3', 'p4']

// 25% duplicate-class parties (2026-09-04, ported from the sibling AresRPG-RL repo's
// rl/scenarios.py, which hit and fixed this same gap first): a real player's party can be
// uneven (2x the same class, etc), not just 4 distinct classes -- confirmed as a real,
// likely contributor to a held-out validation failure (2026-09-03/04: +14.24 training-set
// improvement, -7.69 held-out) back when CLASSES was just the fixed 4-class roster and "4
// distinct classes" meant literally always the same lineup. With 12 classes now, "distinct"
// alone already gives real variety (495 possible 4-class combos) -- duplicates on top of that
// still matter for covering uneven real comps, just less critically than before.
const DUPLICATE_CLASS_PROB = 0.25

/** Builds a party from an EXPLICIT list of classes (order = slot) at a given level, stats spent
 *  the same way the live bot actually spends them (split_stat_spending from level 1) — the
 *  shared stat-building step behind both random_party below and cli_compositions.ts's sweep,
 *  which needs specific compositions, not random ones. */
export const build_party = (classes: readonly string[], level: number): SimPartyMember[] => {
  const total_points = Math.max(0, (level - 1) * 5)
  return classes.map((classe, i) => {
    const primary_field = PRIMARY_STAT_BY_CLASS[classe]
    const spending = split_stat_spending(classe, total_points, 0)
    const primary_value = (primary_field && spending[primary_field]) ?? 0
    return {
      name: NAMES[i]!,
      classe,
      level,
      vitality: spending.vitality ?? 0,
      wisdom: 0,
      strength: primary_field === 'strength' ? primary_value : 0,
      intelligence: primary_field === 'intelligence' ? primary_value : 0,
      chance: primary_field === 'chance' ? primary_value : 0,
      agility: primary_field === 'agility' ? primary_value : 0,
    }
  })
}

/** A random 4-character party at a random level in [min_level, max_level]. Class assignment is 4
 *  distinct classes sampled from all 12 (no repeats) 75% of the time, and 4 independent random
 *  draws (duplicates allowed) the other 25% -- see DUPLICATE_CLASS_PROB above. */
export const random_party = (rng: () => number, min_level = 3, max_level = 15): SimPartyMember[] => {
  const level = int_between(rng, min_level, max_level)
  const party_classes =
    rng() < DUPLICATE_CLASS_PROB ? Array.from({ length: 4 }, () => pick(rng, CLASSES)) : pick_distinct(rng, CLASSES, 4)
  return build_party(party_classes, level)
}

// mob_scalar_for_level CLAMPS a requested level into [level_min, level_max] — so a mob whose
// band doesn't overlap the party's level at all (e.g. ant_red is 12-28; nothing you request for
// a level-5 party against it ever plays as less than an effective level 12) can't be calibrated
// into a fair fight by nudging the requested level; the level always clamps back to the band
// edge. Only offering mobs whose band actually overlaps a window around the party's level keeps
// calibration's level-nudging meaningful instead of pushing against a wall.
const overlaps_party_level = (mob: { level_min: number; level_max: number }, party_level: number): boolean =>
  mob.level_min <= party_level + 6 && mob.level_max >= party_level - 6

/** A random 1-4 mob group, levels spread NARROWLY around the party's own level — this is the
 *  raw draw before calibration below nudges it toward genuinely contested; too wide a spread
 *  here (esp. compounded across a 3-4 mob group) mostly produces free wins or hopeless losses,
 *  neither of which gives an evolutionary search anything to select for. */
export const random_mob_group = (rng: () => number, party_level: number): readonly SimMobGroupMember[] => {
  const count = int_between(rng, 1, 4)
  const relevant = STARTER_MOBS.filter((m) => overlaps_party_level(m, party_level))
  const pool = relevant.length > 0 ? relevant : STARTER_MOBS // degrade gracefully at extreme levels nothing overlaps
  const same_family = rng() < 0.6 // mixed-composition groups happen too, just less often
  const anchor_family = pick(rng, pool).family
  const family_pool = same_family ? pool.filter((m) => m.family === anchor_family) : pool
  // Bigger groups get a lower level ceiling — 4 mobs each +2 levels is a much harder fight than
  // 1 mob +2 levels, and the naive version of this generator kept producing near-hopeless
  // 3-4 mob groups for exactly that reason.
  const spread_ceiling = count <= 1 ? 3 : count === 2 ? 2 : 1
  const level_spread = () => Math.max(1, party_level + int_between(rng, -2, spread_ceiling))
  return Array.from({ length: count }, () => ({ mob_type: pick(rng, family_pool).mob_type, level: level_spread() }))
}

export type Scenario = { label: string; party: readonly SimPartyMember[]; group: readonly SimMobGroupMember[] }

const MOB_BAND_BY_TYPE = new Map(
  ALL_MOB_ROWS.map((m) => [m.mob_type, { level_min: m.level_min, level_max: m.level_max }])
)

// PROBE_RUNS=4/ATTEMPTS=5 (measured 2026-09-03, cross-referencing the sibling AresRPG-RL
// repo's own calibration-reliability finding): a 4-run probe is too small a sample to
// reliably classify a scenario -- a genuinely 5%-true-win-rate scenario still has a ~17%
// chance of showing 1/4=25% and getting accepted as "contested" on pure sampling noise.
// Confirmed happening: cli_validate_policy.ts, run against a real trained policy, found
// several of its 12 "calibrated" scenarios at a literal 100% or 13% win rate under a
// proper 8-run evaluation -- both default and learned policies alike, meaning those
// scenarios could never have shown either policy's improvement regardless of how good it
// was. Widened both knobs; ~1.3s/fight measured locally, so the worst case (probe runs x
// attempts) costs a bounded, one-time-per-scenario-set amount more, not per generation.
const CALIBRATION_PROBE_RUNS = 8
const CALIBRATION_ATTEMPTS = 8
const CONTESTED_MIN_WIN_RATE = 0.15
const CONTESTED_MAX_WIN_RATE = 0.9

/** Nudges a candidate group's mob levels up/down until DEFAULT_POLICY's win rate against it
 *  lands in a genuinely contested band, instead of accepting whatever the raw random draw
 *  produced. A scenario that's a free win or a hopeless loss under every policy contributes
 *  nothing to the search — verified this was happening (2026-09-01: 5 of 8 raw-random scenarios
 *  were 0% or 100% regardless of policy, and training flat-lined for 5 straight generations
 *  because of it). Costs real simulation time up front but only once per scenario set. */
export const calibrate_group = (
  rng: () => number,
  party: readonly SimPartyMember[],
  initial_group: readonly SimMobGroupMember[]
): readonly SimMobGroupMember[] => {
  let group = initial_group
  for (let attempt = 0; attempt < CALIBRATION_ATTEMPTS; attempt += 1) {
    const probe = simulate_many(party, group, CALIBRATION_PROBE_RUNS, 500n, DEFAULT_POLICY)
    if (probe.win_rate >= CONTESTED_MIN_WIN_RATE && probe.win_rate <= CONTESTED_MAX_WIN_RATE) return group

    // Too hard with every mob already at its band FLOOR: the group's SIZE is the real problem
    // (e.g. 4x a mob at its own minimum level is still a hard fight), not the level — level
    // nudging is exhausted. Drop the last mob instead of wasting remaining attempts on a wall.
    const at_floor = group.every((m) => m.level <= (MOB_BAND_BY_TYPE.get(m.mob_type)?.level_min ?? 1))
    if (probe.win_rate < CONTESTED_MIN_WIN_RATE && at_floor && group.length > 1) {
      group = group.slice(0, -1)
      continue
    }

    const direction = probe.win_rate > CONTESTED_MAX_WIN_RATE ? 1 : -1 // too easy -> harder; too hard -> easier
    group = group.map((m) => {
      const band = MOB_BAND_BY_TYPE.get(m.mob_type)
      const raw = m.level + direction * int_between(rng, 1, 2)
      // Clamp to the mob's OWN band — nudging past it is wasted (mob_scalar_for_level clamps
      // right back), and would silently stall the search on a mob that just can't get any
      // harder/easier than its band extremes allow against this party.
      return { ...m, level: band ? Math.max(band.level_min, Math.min(band.level_max, raw)) : Math.max(1, raw) }
    })
  }
  return group // best-effort after the attempt budget — still used, just not guaranteed contested
}

/** `count` reproducible random scenarios — the training/eval set cli_train.ts and cli_tune.ts
 *  actually search against, instead of one hand-picked party vs two hand-picked matchups. Each
 *  one is difficulty-calibrated (see calibrate_group) so the set is mostly genuine contests
 *  rather than mostly free wins or hopeless losses. */
export const random_scenarios = (seed: number, count: number, min_level = 3, max_level = 15): readonly Scenario[] => {
  const rng = make_rng(seed)
  return Array.from({ length: count }, (_, i) => {
    const party = random_party(rng, min_level, max_level)
    const group = calibrate_group(rng, party, random_mob_group(rng, party[0]!.level))
    return {
      label: `#${i} party_lv${party[0]!.level} vs ${group.map((g) => `${g.mob_type}(${g.level})`).join('+')}`,
      party,
      group,
    }
  })
}
