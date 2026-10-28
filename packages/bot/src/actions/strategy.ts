// strategy – the periodic "brain". Once every BOT_STRATEGY_INTERVAL_MS the play loop re-derives, from
// the FULL seed content and the live party, the two facts the local loop cannot see from where it
// happens to stand:
//
//   1. WHERE to farm. The engage only screens the handful of groups in the live window, and the roam
//      picks a distance from a median-family heuristic. This module scores, for each zone-difficulty
//      band, the in-level families with the best authored XP using the SAME deterministic twin the
//      chain mirrors (`fight_preview.score_mobs`), then aggregates the ones the party can reliably beat
//      into the block distance whose likely group pays the most XP per committed turn for THIS party.
//      A cheap prefilter picks only a couple of families per band, so the pass stays short enough to
//      run on the shared play loop (the live engage still hard-certifies with all five seeds).
//   2. WHAT to wear, and how to get it. For every character it names the best wearable per slot at its
//      level (computed by `gear.ts`) and the acquisition route: `craft` when the seed has a recipe for
//      it, `drop` otherwise, with the mob types whose loot carries it.
//
// Pure, read-only and best-effort: a scan that finds nothing winnable yields no plan (the roam keeps
// its own heuristic) rather than a wrong one. No I/O, no timers, no chain.
import { create_mob_snapshot, type FightMobInput } from '@aresrpg/fight'
import {
  craft_required_level,
  craft_xp_at_level,
  job_kind_of,
  job_level_from_xp,
  job_slugs,
} from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'

import {
  job_recipes,
  items_by_type,
  gatherable_of,
  loot_demand,
  loot_sources_by_item,
  mobs_by_type,
  recipe_detail,
  recipes_by_output,
  type SeedWorld,
} from '../content/catalog.ts'
import { mob_template_of } from '../content/fight_sources.ts'
import { unavailable_item_ids } from '../state/selectors.ts'
import {
  fight_world_for_level,
  mob_group_size_bounds,
  mob_level_scalar_bounds,
} from '../content/zone_map.ts'
import type { GameState } from '../state/store.ts'

import { MIN_WIN_RATE, score_mobs, type FightScore } from './fight_preview.ts'
import { gear_drop_candidates, plan_gear_goals } from './gear.ts'
import { CRAFT_BLACKLIST } from './craft.ts'
import { dungeon_key_targets, held_key_amount, MIN_GROUP_KEYS } from './dungeon.ts'

/** How a wanted item is obtained: `craft` when the seed authors a recipe, `drop` when only loot. */
export type GearRoute = 'craft' | 'drop'

export type GearTarget = Readonly<{
  character_id: string
  character_name: string
  slot: string
  item_type: string
  category: string
  level: number
  /** expected rune-weight score of the target (the auto-equip unit) */
  score: number
  /** how far it beats what the character could wear today */
  gain: number
  route: GearRoute
  /** the crafting trade that stamps it, or null for a loot-only target */
  job: string | null
  /** the job level the recipe requires (0 when there is no recipe, i.e. a drop) */
  needed_level: number
  /** the character's current level in {@link job} */
  job_level: number
  /** true when {@link job} is already high enough to craft the piece today */
  ready: boolean
  /** the mob types whose loot carries this item (the source of a `drop` route, a bonus of a craft) */
  source_mobs: readonly string[]
}>

/** A trade the party must still LEVEL before a wanted piece becomes craftable — the gear goal's
 *  answer to "what should we grind". `needed_level` is the recipe's ingredient-count gate. */
export type GearTraining = Readonly<{
  job: string
  level: number
  needed_level: number
}>

/** One (mob family, difficulty band) probed with the party twin. */
export type FarmSample = Readonly<{
  world: string
  mob_type: string
  role: string
  /** the block distance from the world centre this band sits at */
  distance: number
  level_scalar: number
  mob_level: number
  group_size: number
  win_rate: number
  xp_per_turn: number
  loot_per_turn: number
}>

export type FarmPlan = Readonly<{
  world: string
  /** the block distance from the world centre the party should farm at */
  distance: number
  level_scalar: number
  mob_level: number
  /** expected XP per committed turn at the chosen distance, weighted by family spawn rate */
  xp_per_turn: number
  /** the ranked evidence behind the choice (best XP/turn first) */
  samples: readonly FarmSample[]
}>

export type Strategy = Readonly<{
  computed_ms: number
  farm: FarmPlan | null
  gear: readonly GearTarget[]
  /** trades to level so the wanted gear becomes craftable, in goal-gain order */
  training: readonly GearTraining[]
  /** One currently missing mob drop and its best available source/farming band. */
  loot_focus: LootFocus | null
  /** The current loot focus's source mob; winnable encounters carrying it outrank XP-only fights. */
  wanted_mobs: ReadonlySet<string>
}>

export type LootFocus = Readonly<{
  item_type: string
  mob_type: string
  have: number
  need: number
  distance: number
}>

/** Local seeds per sample, PINNED (score_mobs's options.seeds runs them exactly, no sequential
 *  extension). This is a coarse RANKING, not the engage's hard certification (which sequential-
 *  seeds a borderline read to fifteen): two distinct boards are enough to drop a family that only
 *  wins by luck, at a third of the cost. Two seeds make `win_rate` 0, 0.5 or 1, so the >=
 *  MIN_WIN_RATE gate only passes a candidate that won BOTH boards. */
const STRATEGY_SEEDS: readonly bigint[] = Object.freeze([1n, 2n])

/** The zone-difficulty bands sampled, as block distances from the world centre. The scalar ramp is
 *  flat past 20,000, so four bands span the whole farmable ring; the live roam refines from whatever
 *  target this names in 2,500-block steps. */
const SAMPLE_DISTANCES: readonly number[] = Object.freeze([5_000, 10_000, 15_000, 20_000])

/** Fights simulated per band. A cheap authored-XP prefilter picks this many in-level families first,
 *  so the pass is bounded by bands × candidates × seeds — never by the size of the mob roster. */
const CANDIDATES_PER_DISTANCE = 2

/** A scaled mob further above the party than this is not worth simulating (it cannot be beaten). */
const LEVEL_CEIL_GAP = 20

/** Cap the reported evidence so a digest line stays readable. */
const MAX_SAMPLES = 12

/** The scaled level a mob type reaches at a zone-level scalar, or null when the seed lacks it. */
export const scaled_level = (mob_type: string, scalar: number): number | null => {
  const template = mob_template_of(mob_type)
  return template ? Number(create_mob_snapshot(template, BigInt(scalar)).level) : null
}

/** The best obtainable wearable per (character, slot) and HOW to get it, biggest gain first.
 *
 *  `craft` targets come from the craftable-goal scan (`gear.ts`) and carry the trade + job level the
 *  craft planner will honour, so the brain can say "train JEWELER 1→10". `drop` targets are the pieces
 *  the seed offers ONLY as loot (no recipe); they are named with the families that drop them. A
 *  loot-only piece is reported only when it beats the best craftable one for the same slot — otherwise
 *  the party would be told to farm a piece it can simply (and better) make. */
export const plan_gear_targets = (
  characters: readonly CharacterRow[],
  state: GameState
): readonly GearTarget[] => {
  const by_id = new Map(characters.map((character) => [character.id, character]))
  const level_of = (character_id: string, job: string): number =>
    job_level_from_xp(Number(by_id.get(character_id)?.jobs?.[job] ?? '0'))

  const craft_targets = plan_gear_goals(characters, state).map((goal) => {
    const recipe = recipes_by_output[goal.output_type]
    const detail = recipe ? recipe_detail(recipe) : null
    const job = detail?.job ?? goal.job
    const needed_level = detail ? craft_required_level(detail.ingredients.length) : 0
    const job_level = level_of(goal.character_id, job)
    return Object.freeze({
      character_id: goal.character_id,
      character_name: goal.character_name,
      slot: goal.slot,
      item_type: goal.output_type,
      category: items_by_type[goal.output_type]?.category ?? '',
      level: goal.level,
      score: goal.score,
      gain: goal.gain,
      route: 'craft' as const,
      job: job as string | null,
      needed_level,
      job_level,
      ready: job_level >= needed_level,
      source_mobs: loot_sources_by_item.get(goal.output_type) ?? [],
    })
  })

  const craft_gain = new Map<string, number>()
  for (const target of craft_targets) craft_gain.set(`${target.character_id}\u0000${target.slot}`, target.gain)
  const drop_targets = plan_gear_goals(characters, state, gear_drop_candidates)
    .filter(
      (goal) =>
        goal.gain > (craft_gain.get(`${goal.character_id}\u0000${goal.slot}`) ?? Number.NEGATIVE_INFINITY)
    )
    .map((goal) =>
      Object.freeze({
        character_id: goal.character_id,
        character_name: goal.character_name,
        slot: goal.slot,
        item_type: goal.output_type,
        category: items_by_type[goal.output_type]?.category ?? '',
        level: goal.level,
        score: goal.score,
        gain: goal.gain,
        route: 'drop' as const,
        job: null,
        needed_level: 0,
        job_level: 0,
        ready: true,
        source_mobs: loot_sources_by_item.get(goal.output_type) ?? [],
      })
    )

  return Object.freeze([...craft_targets, ...drop_targets].sort((left, right) => right.gain - left.gain))
}

/** The trades the party must still level before its wanted gear is craftable, in goal-gain order.
 *  `gear` is expected biggest-gain-first, so a job's FIRST appearance is its highest-value goal. */
export const plan_training = (gear: readonly GearTarget[]): readonly GearTraining[] => {
  const by_job = new Map<string, GearTraining>()
  for (const target of gear) {
    if (target.route !== 'craft' || target.ready || !target.job) continue
    const job = target.job
    const prev = by_job.get(job)
    if (!prev || target.needed_level > prev.needed_level)
      by_job.set(
        job,
        Object.freeze({ job, level: target.job_level, needed_level: target.needed_level })
      )
  }
  return Object.freeze([...by_job.values()])
}

export type FarmOptions = Readonly<{
  /** the world to scan; defaults to the fight world for the party's level */
  world?: SeedWorld
  /** the level the scan is tuned to; defaults to the leader's */
  party_level?: number
  /** the block distances to sample; defaults to the full ring */
  distances?: readonly number[]
  /** Session-local key parking state; parked keys should not drive loot farming. */
  dungeon_blacklist?: ReadonlyMap<string, number>
  /** Shared sample time for deterministic key-target selection. */
  now_ms?: number
}>

/** Scan every mob family in the fight world across the difficulty bands and pick the distance whose
 *  EXPECTED group pays the most XP per committed turn for the party (weighted by family spawn rate).
 *  Returns null when no family at any band is both winnable and worth XP. */
export const plan_farm = (
  characters: readonly CharacterRow[],
  options: FarmOptions = {}
): FarmPlan | null => {
  const leader = characters[0]
  if (!leader) return null
  const party_level = options.party_level ?? leader.level
  const world = options.world ?? fight_world_for_level(party_level)
  if (!world || world.mobs.length === 0) return null
  const allies = characters.slice(1)
  const distances = options.distances ?? SAMPLE_DISTANCES

  const weight_of = (mob_type: string): number =>
    Math.max(1, world.mobs.find((entry) => entry.mob_type === mob_type)?.weight_bp ?? 1)

  const samples: FarmSample[] = []
  for (const distance of distances) {
    const [low, high] = mob_level_scalar_bounds(distance)
    const scalar = Math.trunc((low + high) / 2)
    const [size_low, size_high] = mob_group_size_bounds(distance)
    const group_size = Math.max(1, Math.round((size_low + size_high) / 2))
    // Cheap prefilter over the roster: only families the chain still pays XP for are considered (the
    // same `highest*5 >= level*2` floor `assess_window` uses), and only the couple with the best
    // authored XP per mob (fading as the family's scaled level parts from the party's) are actually
    // simulated. Authored XP is a constant, so this costs nothing per band.
    const candidates = world.mobs
      .flatMap((entry) => {
        const template = mob_template_of(entry.mob_type)
        if (!template) return []
        const mob_level = Number(create_mob_snapshot(template, BigInt(scalar)).level)
        if (mob_level * 5 < party_level * 2) return []
        if (mob_level > party_level + LEVEL_CEIL_GAP) return []
        return [
          {
            entry,
            template,
            mob_level,
            expected: Number(template.xp) / (1 + Math.abs(mob_level - party_level)),
          },
        ]
      })
      .sort((left, right) => right.expected - left.expected)
      .slice(0, CANDIDATES_PER_DISTANCE)
    for (const { entry, template, mob_level } of candidates) {
      const mob_inputs: readonly FightMobInput[] = Array.from({ length: group_size }, () =>
        Object.freeze({ team: 1n, template, scalar: BigInt(scalar) })
      )
      const score = score_mobs(leader, mob_inputs, allies, { seeds: STRATEGY_SEEDS })
      samples.push(
        Object.freeze({
          world: world.world,
          mob_type: entry.mob_type,
          role: mobs_by_type[entry.mob_type]?.role ?? 'normal',
          distance,
          level_scalar: scalar,
          mob_level,
          group_size,
          win_rate: score.win_rate,
          xp_per_turn: score.xp_per_turn,
          loot_per_turn: score.loot_per_turn,
        })
      )
    }
  }

  const viable = samples.filter((sample) => sample.win_rate >= MIN_WIN_RATE && sample.xp_per_turn > 0)
  if (viable.length === 0) return null
  viable.sort((left, right) => right.xp_per_turn - left.xp_per_turn)

  // Expected value per distance: weight each family's sample by its spawn rate, so a distance is
  // judged on the group it is LIKELY to spawn, not one lucky family. Ties break to the nearer band.
  const by_distance = new Map<number, Readonly<{ weight: number; value: number }>>()
  for (const sample of viable) {
    const bucket = by_distance.get(sample.distance) ?? { weight: 0, value: 0 }
    const weight = weight_of(sample.mob_type)
    by_distance.set(
      sample.distance,
      Object.freeze({ weight: bucket.weight + weight, value: bucket.value + weight * sample.xp_per_turn })
    )
  }
  let best_distance = viable[0]!.distance
  let best_value = Number.NEGATIVE_INFINITY
  for (const [distance, bucket] of by_distance) {
    const value = bucket.value / bucket.weight
    if (value > best_value || (value === best_value && distance < best_distance)) {
      best_value = value
      best_distance = distance
    }
  }
  const best = viable.find((sample) => sample.distance === best_distance)!
  return Object.freeze({
    world: world.world,
    distance: best_distance,
    level_scalar: best.level_scalar,
    mob_level: best.mob_level,
    xp_per_turn: best_value,
    samples: Object.freeze(viable.slice(0, MAX_SAMPLES)),
  })
}

const held_amount = (state: GameState, item_type: string): number => {
  const unavailable = unavailable_item_ids(state)
  return state.inventory.reduce(
    (total, item) => total + (item.item_type === item_type && !unavailable.has(item.id) ? item.amount : 0),
    0
  )
}

const xp_training_outputs = (characters: readonly CharacterRow[]): readonly string[] => {
  const outputs = new Set<string>()
  for (const character of characters) {
    for (const job of job_slugs.filter((slug) => job_kind_of(slug) !== 'gathering')) {
      const level = job_level_from_xp(Number(character.jobs?.[job] ?? '0'))
      const candidates = job_recipes(job)
        .filter((detail) => !CRAFT_BLACKLIST.has(detail.output_type))
        .filter((detail) => level >= craft_required_level(detail.ingredients.length))
        .map((detail) => ({ detail, xp: craft_xp_at_level(detail.ingredients.length, level) }))
        .filter(({ xp }) => xp > 0)
        .sort((left, right) => right.xp - left.xp)
      const best = candidates[0]
      if (best) outputs.add(best.detail.output_type)
    }
  }
  return Object.freeze([...outputs])
}

/** Select one missing mob-drop material from live craft goals, then choose its best source mob and a
 *  winnable farming band. Gatherable ingredients stay with the gather planner; only loot-only leaves
 *  direct combat toward mobs. Key demand accounts for the number of keys still needed by the party. */
export const plan_loot_focus = (
  characters: readonly CharacterRow[],
  state: GameState,
  gear: readonly GearTarget[],
  options: FarmOptions = {}
): LootFocus | null => {
  const leader = characters[0]
  if (!leader) return null
  const world = options.world ?? fight_world_for_level(options.party_level ?? leader.level)
  if (!world) return null
  const now = options.now_ms ?? Date.now()
  const unavailable = unavailable_item_ids(state)
  const key_targets = dungeon_key_targets(
    state.inventory,
    unavailable,
    options.dungeon_blacklist ?? new Map(),
    now
  )
  const needs = new Map<string, number>()
  const add_output = (output_type: string, crafts = 1): void => {
    for (const [item_type, quantity] of loot_demand(output_type)) {
      if (gatherable_of(item_type)) continue
      needs.set(item_type, (needs.get(item_type) ?? 0) + quantity * crafts)
    }
  }

  for (const key of key_targets) {
    const held = held_key_amount(state.inventory, unavailable, key)
    add_output(key, Math.max(0, MIN_GROUP_KEYS - held))
  }
  for (const target of gear) {
    if (target.route === 'drop') {
      needs.set(target.item_type, (needs.get(target.item_type) ?? 0) + 1)
    } else {
      add_output(target.item_type)
    }
  }
  for (const output_type of xp_training_outputs(characters)) add_output(output_type)

  const world_mobs = new Map(world.mobs.map((entry) => [entry.mob_type, entry]))
  const distances = options.distances ?? SAMPLE_DISTANCES
  for (const [item_type, need] of needs) {
    const have = state.inventory.reduce(
      (total, item) => total + (item.item_type === item_type && !unavailable.has(item.id) ? item.amount : 0),
      0
    )
    if (have >= need) continue
    const sources = (loot_sources_by_item.get(item_type) ?? [])
      .flatMap((mob_type) => {
        const spawn = world_mobs.get(mob_type)
        const template = mob_template_of(mob_type)
        const drop = mobs_by_type[mob_type]?.loot.find((row) => row.item_type === item_type)
        if (!spawn || !template || !drop) return []
        const expected_drop = (drop.chance_bp / 10_000) * ((drop.min_qty + drop.max_qty) / 2)
        return [{ mob_type, spawn_weight: spawn.weight_bp, expected_drop, template }]
      })
      .sort(
        (left, right) =>
          right.spawn_weight * right.expected_drop - left.spawn_weight * left.expected_drop
      )
    const source = sources[0]
    if (!source) continue

    let best: Readonly<{ distance: number; score: FightScore }> | null = null
    for (const distance of distances) {
      const [scalar_low, scalar_high] = mob_level_scalar_bounds(distance)
      const scalar = Math.trunc((scalar_low + scalar_high) / 2)
      const [size_low, size_high] = mob_group_size_bounds(distance)
      const group_size = Math.max(1, Math.round((size_low + size_high) / 2))
      const input = Object.freeze({ team: 1n, template: source.template, scalar: BigInt(scalar) })
      const score = score_mobs(leader, Array.from({ length: group_size }, () => input), characters.slice(1), {
        seeds: STRATEGY_SEEDS,
      })
      if (score.win_rate < MIN_WIN_RATE) continue
      if (
        !best ||
        score.xp_per_turn > best.score.xp_per_turn ||
        (score.xp_per_turn === best.score.xp_per_turn && distance < best.distance)
      )
        best = Object.freeze({ distance, score })
    }
    if (best)
      return Object.freeze({
        item_type,
        mob_type: source.mob_type,
        have,
        need,
        distance: best.distance,
      })
  }
  return null
}

/** The whole periodic analysis: farm XP, level jobs, improve gear, and focus the next missing
 *  monster-drop ingredient on a winnable source family. */
export const compute_strategy = (
  characters: readonly CharacterRow[],
  state: GameState,
  options: FarmOptions & Readonly<{ now_ms?: number }> = {}
): Strategy => {
  const gear = plan_gear_targets(characters, state)
  const loot_focus = plan_loot_focus(characters, state, gear, options)
  const wanted_mobs = new Set(loot_focus ? [loot_focus.mob_type] : [])
  return Object.freeze({
    computed_ms: options.now_ms ?? Date.now(),
    farm: plan_farm(characters, options),
    gear,
    training: plan_training(gear),
    loot_focus,
    wanted_mobs,
  })
}

export const describe_strategy = (strategy: Strategy): readonly string[] => {
  const lines: string[] = []
  if (strategy.farm) {
    const farm = strategy.farm
    lines.push(
      `farm ${farm.world} @${farm.distance} (scalar ${farm.level_scalar}, mob lvl ~${farm.mob_level}): ` +
        `${Math.round(farm.xp_per_turn)} xp/turn expected`
    )
    const top = farm.samples.slice(0, 5).map(
      (sample) =>
        `${sample.mob_type}×${sample.group_size} lvl${sample.mob_level} ${Math.round(sample.win_rate * 100)}%/${Math.round(sample.xp_per_turn)}xp`
    )
    lines.push(`  best families: ${top.join(', ')}`)
  } else {
    lines.push('farm: no winnable, worthwhile family found in the fight world')
  }
  if (strategy.training.length > 0)
    lines.push(
      `jobs to train: ${strategy.training
        .map((t) => `${t.job} ${t.level}→${t.needed_level}`)
        .join(', ')}`
    )
  if (strategy.gear.length === 0) lines.push('gear: every character already fields its best craftable piece per slot')
  for (const target of strategy.gear.slice(0, 6)) {
    const route = target.route === 'craft' ? 'craft' : 'drop'
    const craft_text =
      route === 'craft'
        ? `craft ${target.ready ? 'ready' : `${target.job ?? '—'} ${target.job_level}→${target.needed_level}`}`
        : `drop from ${target.source_mobs.slice(0, 3).join(' ') || 'unknown'}`
    lines.push(
      `gear ${target.character_name} ${target.slot}: ${target.item_type} (lvl ${target.level}, +${Math.round(
        target.gain
      )}) ${craft_text}` +
        (route === 'craft' && target.source_mobs.length > 0
          ? ` [also drops: ${target.source_mobs.slice(0, 3).join(' ')}]`
          : '')
    )
  }
  if (strategy.gear.length > 6) lines.push(`gear: +${strategy.gear.length - 6} more upgrade(s)`)
  if (strategy.loot_focus)
    lines.push(
      `loot focus: ${strategy.loot_focus.item_type} ${strategy.loot_focus.have}/${strategy.loot_focus.need} from ${strategy.loot_focus.mob_type} @${strategy.loot_focus.distance}`
    )
  return Object.freeze(lines)
}
