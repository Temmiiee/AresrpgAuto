// The pure turn planner for a seated fighter: the ONE place that decides what a legal turn does.
// combat.ts submits its output to the chain; fight_preview.ts replays the exact same plan through
// a local @aresrpg/fight twin to score a mob group before spending gas. One planner, so the
// preview can never diverge from what the bot would actually commit.
//
// A turn packs EVERY legal action it can — move into range, then strike or cast until AP runs out.
// commit_turn renders the whole list plus one end_fight_turn into a single PTB, so spending the
// turn's full budget is strictly cheaper than committing one action per turn. AP/MP accounting is
// never recomputed here: a scratch local fight IS the engine, and it feeds back the post-action
// state the next step plans against.
import {
  CONTRACT_CONSTANTS,
  board_zone_cells,
  create_fight,
  fight_path_to,
  player_max_hp,
  project_spell_turn as raw_project_spell_turn,
  project_weapon_turn as raw_project_weapon_turn,
  reachable_fight_cells,
  spell_area_cells as raw_spell_area_cells,
  spell_target_cells as raw_spell_target_cells,
  weapon_area_cells as raw_weapon_area_cells,
  weapon_level_of,
  weapon_target_cells as raw_weapon_target_cells,
  type FightCommand,
  type BoardZone,
  type Fighter,
  type HydratedFightCheckpoint,
  type SpellCellProjection,
  type SpellTurnProjection,
} from '@aresrpg/fight'
import { AREA_SHAPES, CHANNELS, EFFECT_KINDS, TARGET_FILTERS } from '@aresrpg/fight/move_contract'

import { log_debug } from '../shared/logger.ts'

import type { BotSdk } from '../auth/sdk_client.ts'

/** One committed turn action, exactly as the SDK's commit_turn builder types it. */
export type TurnAction = Parameters<BotSdk['fight']['commit_turn']>[0]['actions'][number]

const GRID_W = CONTRACT_CONSTANTS.grid_w
const GRID_W_N = Number(GRID_W)

/** A safety bound on actions per turn, well above any legal AP/MP budget (a runaway guard). */
const MAX_TURN_ACTIONS = 16
const PROFILE_PREVIEW = Boolean(process.env.BOT_PROFILE_PREVIEW)

const cell_x = (cell: bigint): number => Number(cell % GRID_W)
const cell_y = (cell: bigint): number => Math.floor(Number(cell) / GRID_W_N)
const manhattan = (a: bigint, b: bigint): number => Math.abs(cell_x(a) - cell_x(b)) + Math.abs(cell_y(a) - cell_y(b))

// Every projection below is PURE for one checkpoint: cells, AP, cooldowns and the turn ledger do
// not change while a seat decides its next action. A checkpoint is therefore a safe cache key, and
// one decision pass asks for the same spell ranges/projections several times (tactical scoring,
// damage ranking, heal checks, the emergency scan). Scans walk the whole 625-cell board and run the
// legality/crit math per cell, so memoizing them is the difference between a preview pass and a
// multi-second stall. Entries die with the checkpoint (WeakMap).
type PlannerCache = Readonly<{
  targets: Map<string, SpellCellProjection>
  projections: Map<string, SpellTurnProjection | null>
  areas: Map<string, readonly bigint[]>
  damage_options: Map<number, readonly DamageOption[]>
}>
const planner_caches = new WeakMap<object, PlannerCache>()

const planner_cache = (cp: HydratedFightCheckpoint): PlannerCache => {
  let cache = planner_caches.get(cp)
  if (!cache) {
    cache = {
      targets: new Map(),
      projections: new Map(),
      areas: new Map(),
      damage_options: new Map(),
    }
    planner_caches.set(cp, cache)
  }
  return cache
}

const spell_target_cells = (
  cp: HydratedFightCheckpoint,
  actor: bigint,
  name: string
): SpellCellProjection => {
  const cache = planner_cache(cp)
  const key = `s:${actor}:${name}`
  let value = cache.targets.get(key)
  if (value === undefined) {
    value = raw_spell_target_cells(cp, actor, name)
    cache.targets.set(key, value)
  }
  return value
}

const weapon_target_cells = (cp: HydratedFightCheckpoint, actor: bigint): SpellCellProjection => {
  const cache = planner_cache(cp)
  const key = `w:${actor}`
  let value = cache.targets.get(key)
  if (value === undefined) {
    value = raw_weapon_target_cells(cp, actor)
    cache.targets.set(key, value)
  }
  return value
}

const project_spell_turn = (
  cp: HydratedFightCheckpoint,
  actor: bigint,
  name: string
): SpellTurnProjection | null => {
  const cache = planner_cache(cp)
  const key = `s:${actor}:${name}`
  if (!cache.projections.has(key)) cache.projections.set(key, raw_project_spell_turn(cp, actor, name))
  return cache.projections.get(key) ?? null
}

const project_weapon_turn = (cp: HydratedFightCheckpoint, actor: bigint): SpellTurnProjection | null => {
  const cache = planner_cache(cp)
  const key = `w:${actor}`
  if (!cache.projections.has(key)) cache.projections.set(key, raw_project_weapon_turn(cp, actor))
  return cache.projections.get(key) ?? null
}

const spell_area_cells = (
  cp: HydratedFightCheckpoint,
  actor: bigint,
  name: string,
  cell: bigint
): readonly bigint[] => {
  const cache = planner_cache(cp)
  const key = `s:${actor}:${name}:${cell}`
  let value = cache.areas.get(key)
  if (value === undefined) {
    value = raw_spell_area_cells(cp, actor, name, cell)
    cache.areas.set(key, value)
  }
  return value
}

const weapon_area_cells = (
  cp: HydratedFightCheckpoint,
  actor: bigint,
  cell: bigint
): readonly bigint[] => {
  const cache = planner_cache(cp)
  const key = `w:${actor}:${cell}`
  let value = cache.areas.get(key)
  if (value === undefined) {
    value = raw_weapon_area_cells(cp, actor, cell)
    cache.areas.set(key, value)
  }
  return value
}

/** The spells a seated player fighter may cast, from the fight's own replay source. */
export const spell_names_for = (cp: HydratedFightCheckpoint, seat: number): readonly string[] => {
  const fighter = cp.contract.fighters[seat]
  if (!fighter || fighter.kind.type !== 'player') return []
  const source = cp.sources.players[fighter.kind.character]
  return source ? Object.keys(source.spell_levels) : []
}

/** Get current HP for a fighter. Max HP is not on Fighter; we use current HP for relative comparisons. */
const fighter_hp = (fighter: Fighter): number => Number(fighter.hp ?? 0n)

/** A player fighter's MAX HP, from its replay source — "hurt" means below half of THIS, not
 *  below half of the pack. A fighter with no source has no bar to reason about, so it reads as
 *  never hurt (never triggering a heal we cannot justify). */
const fighter_max_hp = (cp: HydratedFightCheckpoint, fighter: Fighter): number => {
  if (fighter.kind.type !== 'player') return Number(fighter.hp ?? 0n)
  const source = cp.sources.players[fighter.kind.character]
  return source ? Number(player_max_hp(source)) : Number(fighter.hp ?? 0n)
}

type EnemyResponse = Readonly<{
  party_damage: number
  seat_damage: number
  party_deaths: number
  seat_dies: boolean
  fighter_damage: readonly number[]
  fighter_hp_after: readonly number[]
}>
const response_cache = new WeakMap<object, Map<number, EnemyResponse>>()

// Diagnostic temporaire : mesures cumulées des simulations tactiques.
// Les compteurs sont remis à zéro à chaque rapport de tour.
type PlannerPerfKey =
  | 'enemy_response_calls'
  | 'enemy_response_ms'
  | 'enemy_simulate_turn_ms'
  | 'response_after_action_calls'
  | 'response_after_action_ms'
  | 'tactical_cast_calls'
  | 'tactical_cast_ms'
  | 'tactical_create_ms'
  | 'tactical_apply_ms'
  | 'tactical_zone_ms'
  | 'tactical_enemy_ms'
  | 'movement_candidates'
  | 'damage_candidates'

const planner_perf: Record<PlannerPerfKey, number> = {
  enemy_response_calls: 0,
  enemy_response_ms: 0,
  enemy_simulate_turn_ms: 0,
  response_after_action_calls: 0,
  response_after_action_ms: 0,
  tactical_cast_calls: 0,
  tactical_cast_ms: 0,
  tactical_create_ms: 0,
  tactical_apply_ms: 0,
  tactical_zone_ms: 0,
  tactical_enemy_ms: 0,
  movement_candidates: 0,
  damage_candidates: 0,
}

const planner_perf_add = (key: PlannerPerfKey, value = 1): void => {
  if (!PROFILE_PREVIEW) return
  planner_perf[key] += value
}

const planner_perf_report = (label: string): void => {
  if (!PROFILE_PREVIEW) return
  const values = { ...planner_perf }
  if (Object.values(values).some((value) => value > 0)) {
    log_debug(
      'combat',
      `[PERF-PLAN] ${label} ` +
        `enemy=${values.enemy_response_calls}/${values.enemy_response_ms.toFixed(1)}ms ` +
        `enemy_sim=${values.enemy_simulate_turn_ms.toFixed(1)}ms ` +
        `after_action=${values.response_after_action_calls}/${values.response_after_action_ms.toFixed(1)}ms ` +
        `casts=${values.tactical_cast_calls}/${values.tactical_cast_ms.toFixed(1)}ms ` +
        `cast_create=${values.tactical_create_ms.toFixed(1)}ms ` +
        `cast_apply=${values.tactical_apply_ms.toFixed(1)}ms ` +
        `cast_zones=${values.tactical_zone_ms.toFixed(1)}ms ` +
        `cast_enemy=${values.tactical_enemy_ms.toFixed(1)}ms ` +
        `moves=${values.movement_candidates} damage=${values.damage_candidates}`
    )
  }
  for (const key of Object.keys(planner_perf) as PlannerPerfKey[]) planner_perf[key] = 0
}


/** Replay the engine's deterministic enemy segment after this player's turn. The local twin runs the
 * actual mob AI (including target selection, movement, spells, cooldowns and zones), so safety is
 * estimated from the current fight state instead of a fixed distance-to-mob guess. */
const enemy_response = (cp: HydratedFightCheckpoint, seat: number): EnemyResponse => {
  const perf_started = PROFILE_PREVIEW ? performance.now() : 0
  planner_perf_add('enemy_response_calls')
  try {
    let by_seat = response_cache.get(cp)
    if (!by_seat) {
      by_seat = new Map()
      response_cache.set(cp, by_seat)
    }
    const cached = by_seat.get(seat)
    if (cached) return cached
    const unchanged = Object.freeze({
      party_damage: 0,
      seat_damage: 0,
      party_deaths: 0,
      seat_dies: false,
      fighter_damage: Object.freeze(cp.contract.fighters.map(() => 0)),
      fighter_hp_after: Object.freeze(cp.contract.fighters.map((fighter) => Number(fighter.hp))),
    })
    const actor = BigInt(seat)
    if (cp.contract.queue[Number(cp.contract.turn_ptr)] !== actor) return unchanged
    const scratch = create_fight({ state: cp, mode: 'local', hydrated: true, seed: 1n })
    const before = cp.contract.fighters.map((fighter) => Number(fighter.hp))
    const simulate_started = PROFILE_PREVIEW ? performance.now() : 0
    const result = scratch.simulate_turn({
      observed_ms: cp.contract.turn_started_ms + CONTRACT_CONSTANTS.turn_min_ms,
    })
    if (PROFILE_PREVIEW) planner_perf_add('enemy_simulate_turn_ms', performance.now() - simulate_started)
    if (result.error) return unchanged
    let party_damage = 0
    let seat_damage = 0
    let party_deaths = 0
    const fighter_damage = cp.contract.fighters.map(() => 0)
    for (let index = 0; index < result.state.contract.fighters.length; index++) {
      const initial = cp.contract.fighters[index]
      const final = result.state.contract.fighters[index]
      if (!initial || !final || initial.team !== cp.contract.fighters[seat]?.team || initial.dead) continue
      const loss = Math.max(0, before[index]! - Number(final.hp))
      fighter_damage[index] = loss
      party_damage += loss
      if (index === seat) seat_damage += loss
      if (!initial.dead && final.dead) party_deaths += 1
    }
    const response = Object.freeze({
      party_damage,
      seat_damage,
      party_deaths,
      seat_dies: Boolean(result.state.contract.fighters[seat]?.dead),
      fighter_damage: Object.freeze(fighter_damage),
      fighter_hp_after: Object.freeze(result.state.contract.fighters.map((fighter) => Number(fighter.hp))),
    })
    by_seat.set(seat, response)
    return response
  } finally {
    if (PROFILE_PREVIEW) planner_perf_add('enemy_response_ms', performance.now() - perf_started)
  }
}

/** Apply one candidate action to the same local twin, then measure the enemy segment it leaves. */
const response_after_action = (
  cp: HydratedFightCheckpoint,
  seat: number,
  action: TurnAction
): Readonly<{ state: HydratedFightCheckpoint; response: EnemyResponse }> => {
  const perf_started = PROFILE_PREVIEW ? performance.now() : 0
  planner_perf_add('response_after_action_calls')
  const scratch = create_fight({ state: cp, mode: 'local', hydrated: true, seed: 1n })
  const applied = scratch.apply(action.type === 'move'
    ? { type: 'move_to', fighter: BigInt(seat), path: action.path }
    : action.type === 'cast'
      ? { type: 'cast_spell', fighter: action.fighter_idx, spell: action.spell, target_cell: action.target_cell }
      : { type: 'weapon_strike', fighter: action.fighter_idx, target_cell: action.target_cell })
  const state = applied.error ? cp : applied.state
  const response = enemy_response(state, seat)
  if (PROFILE_PREVIEW) planner_perf_add('response_after_action_ms', performance.now() - perf_started)
  return { state, response }
}

/** Check if a spell is a heal (targets allies, restores HP). */
/**
 * Detect healing from the actual spell projection.
 * This avoids treating damaging spells such as Aggressive Brambles as heals.
 */
const is_heal_spell = (
  cp: HydratedFightCheckpoint,
  seat: number,
  name: string
): boolean => {
  const projection = project_spell_turn(cp, BigInt(seat), name)
  return projection?.effects.some(
    (effect) =>
      effect.stat === CHANNELS.hp &&
      effect.kind === EFFECT_KINDS.add
  ) ?? false
}

// ── damage scoring ───────────────────────────────────────────────────
// What decides how long a fight lasts is how much enemy HP a turn REMOVES, never how fast the
// turn lands: the chain paces every turn at its own floor (turn_min_ms) whatever the turn holds, so
// a turn that walks or heals costs exactly as much wall-clock as one that kills. The planner used
// to spend the turn on the FIRST hit it found — the weapon strike, and only a spell when the strike
// was out of reach — which made a fighter whose fists were in range (4 base damage, reach 1) ignore
// a damage spell basing three to five times higher. Both cards are ranked below on the engine's OWN
// damage projection, so the turn's whole AP budget goes into the strongest hit it actually owns.

/** The effect kinds that take HP off a target, mirroring @aresrpg/fight's own damage display: a
 *  direct hit, plus any HP remove/steal/fixed-remove (e.g. a "sacrifice" that steals life). */
const HP_LOSS_KINDS: readonly bigint[] = [
  EFFECT_KINDS.damage,
  EFFECT_KINDS.remove,
  EFFECT_KINDS.steal,
  EFFECT_KINDS.fixed_remove,
]

const takes_hp = (effect: Readonly<{ kind: bigint; stat: bigint }>): boolean =>
  effect.kind === EFFECT_KINDS.damage || (effect.stat === CHANNELS.hp && HP_LOSS_KINDS.includes(effect.kind))

/** Average HP one card takes off ONE target, before that target's own resistances. The engine's
 *  projection already amplified every value by the caster's stat and raw damage, so the only gap
 *  left is an unrolled magnitude roll — the midpoint is the expectation. */
const projected_damage = (projection: SpellTurnProjection | null): number => {
  if (projection === null) return 0
  let total = 0
  for (const effect of projection.effects) {
    if (!takes_hp(effect)) continue
    total += (Number(effect.value) + Number(effect.value_max)) / 2
  }
  return total
}

/** True when a card lands on the single target cell alone: its area then needs no engine lookup,
 *  which keeps the per-turn scoring as cheap as the old single-cell strike scan. */
const single_target_card = (projection: SpellTurnProjection): boolean =>
  projection.effects.every((effect) => effect.area_shape === AREA_SHAPES.point)

/** The action points the chain charges for one cast of a spell this seat has invested in. */
const spell_ap_cost = (cp: HydratedFightCheckpoint, seat: number, name: string): number => {
  const fighter = cp.contract.fighters[seat]
  const player = fighter?.kind.type === 'player' ? cp.sources.players[fighter.kind.character] : undefined
  const level = cp.sources.spells[name]?.levels[Number((player?.spell_levels[name] ?? 1n) - 1n)]
  return level ? Math.max(1, Number(level.ap_cost)) : 4
}

type DamageOption = Readonly<{ action: TurnAction; score: number; cost: number; damage: number }>

/** Legal target cells whose effect area reaches at least one enemy. An area spell may use an empty
 *  target centre as long as one of the cells in its area contains an enemy. */
export const damage_target_cells = (
  targetable: readonly bigint[],
  projection: SpellTurnProjection | null,
  enemy_cells: ReadonlySet<bigint>,
  area_of: (cell: bigint) => readonly bigint[]
): readonly bigint[] => {
  if (projection === null) return []
  if (single_target_card(projection)) return targetable.filter((cell) => enemy_cells.has(cell))
  return targetable.filter((cell) => area_of(cell).some((area_cell) => enemy_cells.has(area_cell)))
}

/** Every damaging action this seat may take right now, scored by the enemy HP it removes per action
 *  point: the sum, over the card's WHOLE area, of the damage it lands on each enemy (never more
 *  than that enemy has left, so overkill is not worth chasing) divided by the AP the card costs. */
const damage_options = (cp: HydratedFightCheckpoint, seat: number, enemies: readonly Fighter[]): readonly DamageOption[] => {
  const cached = planner_cache(cp).damage_options.get(seat)
  if (cached) return cached
  const actor = BigInt(seat)
  const enemy_cells = new Set(enemies.map((fighter) => fighter.cell))
  const options: DamageOption[] = []
  const collect = (
    make_action: (cell: bigint) => TurnAction,
    projection: SpellTurnProjection | null,
    area_of: (cell: bigint) => readonly bigint[],
    targets: readonly bigint[],
    cost: number
  ): void => {
    const per_target = projected_damage(projection)
    if (projection === null || per_target <= 0) return
    const point = single_target_card(projection)
    const ap = Math.max(1, cost)
    for (const cell of targets) {
      const area = new Set(point ? [cell] : area_of(cell))
      let dealt = 0
      for (const enemy of enemies) if (area.has(enemy.cell)) dealt += Math.min(per_target, fighter_hp(enemy))
      if (dealt > 0) options.push({ action: make_action(cell), score: dealt / ap, cost: ap, damage: dealt })
    }
  }

  const weapon_projection = project_weapon_turn(cp, actor)
  const strike_targets = damage_target_cells(
    weapon_target_cells(cp, actor).targetable,
    weapon_projection,
    enemy_cells,
    (cell) => weapon_area_cells(cp, actor, cell)
  )
  if (strike_targets.length > 0) {
    collect(
      (cell) => ({ type: 'strike', fighter_idx: actor, target_cell: cell }),
      weapon_projection,
      (cell) => weapon_area_cells(cp, actor, cell),
      strike_targets,
      Number(weapon_level_of(cp, actor)?.ap_cost ?? 4n)
    )
  }

  for (const name of spell_names_for(cp, seat)) {
    const projection = project_spell_turn(cp, actor, name)
    const spell_targets = damage_target_cells(
      spell_target_cells(cp, actor, name).targetable,
      projection,
      enemy_cells,
      (cell) => spell_area_cells(cp, actor, name, cell)
    )
    if (spell_targets.length === 0) continue
    collect(
      (cell) => ({ type: 'cast', fighter_idx: actor, spell: name, target_cell: cell }),
      projection,
      (cell) => spell_area_cells(cp, actor, name, cell),
      spell_targets,
      spell_ap_cost(cp, seat, name)
    )
  }

  planner_cache(cp).damage_options.set(seat, options)
  return options
}

const best_damage_option = (cp: HydratedFightCheckpoint, seat: number): DamageOption | null => {
  const fighter = cp.contract.fighters[seat]
  if (!fighter || fighter.dead) return null
  const enemies = cp.contract.fighters.filter((target) => !target.dead && target.team !== fighter.team)
  return [...damage_options(cp, seat, enemies)]
    .filter((option) => option.cost <= Number(fighter.ap))
    .sort((left, right) => right.score - left.score || left.cost - right.cost)[0] ?? null
}

/** Recompute one known attack after an effect, avoiding a full scan of every card and cell. */
const action_damage = (cp: HydratedFightCheckpoint, seat: number, action: TurnAction): number => {
  if (action.type === 'move') return 0
  const actor = BigInt(seat)
  const projection = action.type === 'cast'
    ? project_spell_turn(cp, actor, action.spell)
    : project_weapon_turn(cp, actor)
  if (!projection) return 0
  const targets = action.type === 'cast'
    ? spell_target_cells(cp, actor, action.spell).targetable
    : weapon_target_cells(cp, actor).targetable
  if (!targets.includes(action.target_cell)) return 0
  const area = single_target_card(projection)
    ? new Set([action.target_cell])
    : new Set(action.type === 'cast'
      ? spell_area_cells(cp, actor, action.spell, action.target_cell)
      : weapon_area_cells(cp, actor, action.target_cell))
  const value = projected_damage(projection)
  const caster = cp.contract.fighters[seat]
  return cp.contract.fighters.reduce((total, target) =>
    !caster || target.dead || target.team === caster.team || !area.has(target.cell)
      ? total
      : total + Math.min(value, fighter_hp(target)), 0)
}

/** HP damage made reachable by extra MP, measured only on newly reachable cells. */
const new_movement_attack_damage = (
  before: HydratedFightCheckpoint,
  after: HydratedFightCheckpoint,
  seat: number
): number => {
  const actor = BigInt(seat)
  const old_cells = new Set(reachable_fight_cells(before, actor))
  const enemies = after.contract.fighters.filter(
    (fighter) => !fighter.dead && fighter.team !== after.contract.fighters[seat]?.team
  )
  const added_cells = reachable_fight_cells(after, actor)
    .filter((cell) => !old_cells.has(cell))
    .sort((left, right) => distance_to_group(left, enemies) - distance_to_group(right, enemies))
    .slice(0, 3)
  let best = 0
  for (const cell of added_cells) {
    const path = fight_path_to(after, actor, cell)
    const fighter = after.contract.fighters[seat]
    if (!path || !fighter || BigInt(path.length) > fighter.mp) continue
    const positioned = {
      ...after,
      contract: {
        ...after.contract,
        fighters: after.contract.fighters.map((row, index) => index === seat
          ? { ...row, cell, mp: row.mp - BigInt(path.length) }
          : row),
      },
    } as HydratedFightCheckpoint
    best = Math.max(best, best_damage_option(positioned, seat)?.damage ?? 0)
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────
// CLASS-AWARE TACTICAL EVALUATION
// ─────────────────────────────────────────────────────────────────────

type TacticalProfile = Readonly<{
  healing: number
  buff: number
  control: number
  zone: number
  mobility: number
}>

type PartyCombatRole = 'support' | 'controller' | 'dps'

const tactical_profile = (
  cp: HydratedFightCheckpoint,
  seat: number
): TacticalProfile | null => {
  const fighter = cp.contract.fighters[seat]
  if (!fighter || fighter.kind.type !== 'player') return null

  const source = cp.sources.players[fighter.kind.character]
  const name = source?.classe.toLowerCase().replace(/[^a-z]/g, '') ?? ''

  if (name.includes('tomoda')) {
    return {
      healing: 1.45,
      buff: 1.35,
      control: 1.0,
      zone: 1.15,
      mobility: 1.0,
    }
  }

  // Yogan is a ranged archer: value useful repositioning and area control while retaining the
  // damage planner as the baseline so support actions do not displace stronger attacks.
  if (name.includes('yogan')) {
    return {
      healing: 0.75,
      buff: 0.9,
      control: 1.15,
      zone: 1.35,
      mobility: 1.3,
    }
  }

  if (name.includes('yajin')) {
    return {
      healing: 1.0,
      buff: 1.1,
      control: 1.55,
      zone: 1.5,
      mobility: 1.5,
    }
  }

  if (name.includes('mori')) {
    return {
      healing: 1.6,
      buff: 1.1,
      control: 1.5,
      zone: 1.35,
      mobility: 0.9,
    }
  }

  return null
}

const TACTICAL_CANDIDATE_LIMIT = 1

const beneficial_effect_kinds: readonly bigint[] = [
  EFFECT_KINDS.add,
  EFFECT_KINDS.reduce,
  EFFECT_KINDS.reflect,
  EFFECT_KINDS.redirect,
  EFFECT_KINDS.return,
  EFFECT_KINDS.invis,
  EFFECT_KINDS.chatiment,
]
const damage_stats: readonly bigint[] = [
  CHANNELS.strength,
  CHANNELS.intelligence,
  CHANNELS.chance,
  CHANNELS.agility,
  CHANNELS.power,
  CHANNELS.raw_damage,
  CHANNELS.critical,
]

const distance_to_group = (
  cell: bigint,
  fighters: readonly Fighter[]
): number => {
  if (fighters.length === 0) return 999

  return Math.min(
    ...fighters.map((fighter) => manhattan(cell, fighter.cell))
  )
}

/**
 * Estimate the tactical value of a zone payload against one fighter.
 * This is used for traps and glyphs, whose placement may not immediately
 * affect a fighter and therefore cannot be evaluated only by HP changes.
 */
const zone_target_score = (
  zone: BoardZone,
  owner: Fighter,
  owner_seat: number,
  target: Fighter,
  target_seat: number,
  profile: TacticalProfile
): number => {
  let total = 0
  const ally = owner.team === target.team

  for (const row of zone.effects) {
    if (row.target_filter === TARGET_FILTERS.not_team && ally) continue
    if (row.target_filter === TARGET_FILTERS.not_self && owner_seat === target_seat) continue
    if (row.target_filter === TARGET_FILTERS.not_enemy && !ally) continue
    if (row.target_filter === TARGET_FILTERS.only_caster && owner_seat !== target_seat) continue

    const value = Math.min(100, Math.abs(Number(row.value)))
    const duration = Math.max(1, Math.min(3, Number(row.turns)))
    const chance = Number(row.chance_bp) / 10000

    let magnitude = 0

    if (row.stat === CHANNELS.hp) {
      magnitude = value * 0.65 * duration
    } else if (row.stat === CHANNELS.ap) {
      magnitude = value * 4
    } else if (row.stat === CHANNELS.mp) {
      magnitude = value * 1.6
    } else {
      magnitude = 2 + value * 0.08 * duration
    }

    if (
      row.kind === EFFECT_KINDS.push ||
      row.kind === EFFECT_KINDS.pull
    ) {
      magnitude *= profile.control
    }

    const helps_target = beneficial_effect_kinds.includes(row.kind)
    const helps_party = ally === helps_target

    const weight = row.stat === CHANNELS.hp
      ? profile.healing
      : row.stat === CHANNELS.ap || row.stat === CHANNELS.mp
        ? profile.control
        : helps_target
          ? profile.buff
          : profile.control

    total += (helps_party ? magnitude : -magnitude) * weight * chance
  }

  return total
}

/**
 * Score newly placed traps and glyphs.
 *
 * Glyphs trigger at the beginning of a fighter's turn while that fighter
 * remains inside the zone.
 *
 * Traps trigger on entering the zone, not merely standing inside it.
 * Their score is therefore discounted and considers nearby enemies and allies.
 */
const score_new_zones = (
  before: HydratedFightCheckpoint,
  after: HydratedFightCheckpoint,
  seat: number,
  profile: TacticalProfile
): number => {
  const owner = before.contract.fighters[seat]
  if (!owner) return 0

  const old_zones = before.contract.zones
  const new_zones = after.contract.zones.filter(
    (zone) =>
      !old_zones.some(
        (old) =>
          old.owner_fighter === zone.owner_fighter &&
          old.anchor === zone.anchor &&
          old.trap === zone.trap
      )
  )

  let score = 0

  for (const zone of new_zones) {
    const cells = board_zone_cells(zone)
    if (cells.length === 0) continue

    const occupied = before.contract.fighters.flatMap((fighter, index) =>
      !fighter.dead && cells.includes(fighter.cell)
        ? [{ fighter, index }]
        : []
    )

    if (!zone.trap) {
      // Glyph: score actual occupants, discounted by uncertainty that
      // they will still be there when their next turn begins.
      for (const { fighter, index } of occupied) {
        score +=
          zone_target_score(
            zone,
            owner,
            seat,
            fighter,
            index,
            profile
          ) *
          Math.min(3, Math.max(1, Number(zone.turns_left))) *
          0.25
      }

      continue
    }

    // Trap: only a fighter entering the zone triggers it.
    const enemies = before.contract.fighters.flatMap((fighter, index) =>
      !fighter.dead && fighter.team !== owner.team
        ? [{ fighter, index }]
        : []
    )

    const nearby_allies = before.contract.fighters.flatMap((fighter, index) =>
      !fighter.dead &&
      fighter.team === owner.team &&
      index !== seat
        ? [{ fighter, index }]
        : []
    )

    const distance_to_zone = (fighter: Fighter): number =>
      Math.min(...cells.map((cell) => manhattan(cell, fighter.cell)))

    const nearest_enemy = [...enemies].sort(
      (a, b) => distance_to_zone(a.fighter) - distance_to_zone(b.fighter)
    )[0]

    const nearest_ally = [...nearby_allies].sort(
      (a, b) => distance_to_zone(a.fighter) - distance_to_zone(b.fighter)
    )[0]

    if (nearest_enemy) {
      const enemy_distance = distance_to_zone(nearest_enemy.fighter)

      if (enemy_distance <= 3) {
        score +=
          zone_target_score(
            zone,
            owner,
            seat,
            nearest_enemy.fighter,
            nearest_enemy.index,
            profile
          ) *
          profile.zone *
          (0.3 / (1 + enemy_distance * 0.2))
      }

      // A nearby ally may consume the trap before an enemy reaches it.
      if (nearest_ally) {
        const ally_distance = distance_to_zone(nearest_ally.fighter)

        if (ally_distance <= 3 && ally_distance <= enemy_distance) {
          score -= 3 / (1 + ally_distance * 0.2)
        }
      }
    }
  }

  return score
}

/**
 * Evaluate one candidate action by applying it to a disposable local fight.
 *
 * This uses the same resolver as the real fight:
 * - damage and healing
 * - AP/MP grants and removals
 * - status effects
 * - dispels
 * - teleport, push, pull and swaps
 * - trap and glyph placement
 */
const evaluate_action = (
  cp: HydratedFightCheckpoint,
  seat: number,
  action: TurnAction,
  cost: number,
  baseline_response: EnemyResponse,
  profile: TacticalProfile
): number | null => {
  const actor = BigInt(seat)
  const caster = cp.contract.fighters[seat]
  if (!caster || caster.dead) return null

  if (Number(caster.ap) < cost) return null

  const create_started = PROFILE_PREVIEW ? performance.now() : 0
  const simulation = create_fight({ state: cp, mode: 'local', hydrated: true })
  if (PROFILE_PREVIEW) {
    planner_perf_add('tactical_create_ms', performance.now() - create_started)
  }

  const apply_started = PROFILE_PREVIEW ? performance.now() : 0
  const result = simulation.apply(sim_commands([action], actor)[0]!)
  if (PROFILE_PREVIEW) {
    planner_perf_add('tactical_apply_ms', performance.now() - apply_started)
  }

  if (result.error) return null

  const after = result.state
  const needs_response = baseline_response.party_damage > 0 || baseline_response.party_deaths > 0 ||
    baseline_response.seat_dies ||
    cp.contract.fighters.some((fighter, index) =>
      fighter.team === caster.team && !fighter.dead &&
      fighter_hp(fighter) / Math.max(1, fighter_max_hp(cp, fighter)) < 0.7 &&
      (baseline_response.fighter_damage[index] ?? 0) > 0
    )
  const enemy_started = PROFILE_PREVIEW ? performance.now() : 0
  const candidate_response = needs_response ? enemy_response(after, seat) : null
  if (needs_response) planner_perf_add('tactical_enemy_ms', performance.now() - enemy_started)
  let utility = 0

  // Compare the two projected checkpoints after the same enemy segment. This scores actual
  // damage, healing, control, displacement, and prevented casualties in one HP-based unit without
  // separately counting the direct effect and the response it caused.
  for (let index = 0; index < cp.contract.fighters.length; index++) {
    const fighter = cp.contract.fighters[index]
    if (!fighter || fighter.dead) continue
    const baseline_hp = needs_response
      ? baseline_response.fighter_hp_after[index] ?? Number(fighter.hp)
      : Number(fighter.hp)
    const candidate_hp = needs_response
      ? candidate_response?.fighter_hp_after[index] ?? Number(after.contract.fighters[index]?.hp ?? fighter.hp)
      : Number(after.contract.fighters[index]?.hp ?? fighter.hp)
    utility += fighter.team === caster.team
      ? candidate_hp - baseline_hp
      : baseline_hp - candidate_hp
  }

  // Persistent ally effects create future attack capacity. Derive their value from the actual
  // spell/weapon projection and duration, rather than class-specific AP/MP multipliers.
  for (const event of result.events) {
    if (event.type !== 'ap_mp_change' || event.payload.reason === 'cast_cost') continue
    const index = Number(event.payload.fighter)
    const target = cp.contract.fighters[index]
    if (!target || target.team !== caster.team) continue
    const ap_delta = Number(event.payload.ap_after - event.payload.ap_before)
    const mp_delta = Number(event.payload.mp_after - event.payload.mp_before)
    if (ap_delta > 0) utility += ap_delta * (best_damage_option(cp, index)?.score ?? 0)
    if (mp_delta > 0) utility += new_movement_attack_damage(cp, after, index)
  }

  for (const event of result.events) {
    if (event.type !== 'effect_applied') continue
    const index = Number(event.payload.target)
    const target = cp.contract.fighters[index]
    if (
      !target || target.team !== caster.team ||
      !beneficial_effect_kinds.includes(event.payload.kind) ||
      !damage_stats.includes(event.payload.channel)
    ) continue
    const duration = Math.max(0, Number(event.payload.turns))
    const baseline_attack = best_damage_option(cp, index)
    if (!baseline_attack) continue
    const added_damage = Math.max(0, action_damage(after, index, baseline_attack.action) - baseline_attack.damage)
    utility += added_damage * duration
  }

  for (const event of result.events) {
    if (event.type !== 'effects_dispelled') continue
    const index = Number(event.payload.target)
    const target = cp.contract.fighters[index]
    if (!target || event.payload.removed_effect_ids.length === 0) continue
    const baseline_attack = best_damage_option(cp, index)
    if (!baseline_attack) continue
    const damage_change = action_damage(after, index, baseline_attack.action) - baseline_attack.damage
    utility += target.team === caster.team ? damage_change : -damage_change
  }

  // A non-walking displacement is valuable when it opens a legal follow-up attack.
  if (result.events.some((event) => event.type === 'fighter_moved' && event.payload.mode !== 'walk')) {
    const before = best_damage_option(cp, seat)?.damage ?? 0
    const after_damage = best_damage_option(after, seat)?.damage ?? 0
    utility += Math.max(0, after_damage - before)
  }

  // 6. Placement-only spells.
  const zones_started = PROFILE_PREVIEW ? performance.now() : 0
  utility += score_new_zones(cp, after, seat, profile)
  if (PROFILE_PREVIEW) {
    planner_perf_add('tactical_zone_ms', performance.now() - zones_started)
  }

  return utility / Math.max(1, cost)
}

/** Compare attacks and tactical casts through the same engine-backed impact score. */
type ActionDiagnostic = {
  action: TurnAction
  ap_cost: number
  impact_per_ap: number | null
  reason: string
}

const best_action = (
  cp: HydratedFightCheckpoint,
  seat: number,
  _party_allies: readonly Fighter[],
  enemies: readonly Fighter[],
  party_role: PartyCombatRole = 'dps',
  diagnostics?: ActionDiagnostic[]
): TurnAction | null => {
  const profile = tactical_profile(cp, seat) ?? {
    healing: 1,
    buff: 1,
    control: 1,
    zone: 1,
    mobility: 1,
  }
  const me = cp.contract.fighters[seat]

  if (!me || me.dead || enemies.length === 0) return null

  const actor = BigInt(seat)
  const living = cp.contract.fighters.filter((fighter) => !fighter.dead)
  const friends = living.filter((fighter) => fighter.team === me.team)

  let baseline_response: EnemyResponse | null = null
  let best: { action: TurnAction; score: number } | null = null
  const candidates = new Map<string, { action: TurnAction; cost: number }>()

  const action_key = (action: TurnAction): string => action.type === 'cast'
    ? `cast:${action.spell}:${action.target_cell}`
    : action.type === 'strike'
      ? `strike:${action.target_cell}`
      : `move:${action.path.join(',')}`

  for (const option of [...damage_options(cp, seat, enemies)]
    .sort((left, right) => right.score - left.score || left.cost - right.cost)
    .slice(0, 2)) {
    candidates.set(action_key(option.action), { action: option.action, cost: option.cost })
  }

  for (const spell of spell_names_for(cp, seat)) {
    const cost = spell_ap_cost(cp, seat, spell)
    if (cost > Number(me.ap)) continue

    const projection = project_spell_turn(cp, actor, spell)
    const needs_tactical_review = projection?.effects.some((effect) => !takes_hp(effect)) ?? false
    // Pure damage, including AoE, is ranked across every legal target by damage_options. Avoid
    // simulating it twice; keep spells with a distinct tactical effect for the shared scorer.
    if (!needs_tactical_review) continue

    const legal = spell_target_cells(cp, actor, spell).targetable
    if (legal.length === 0) continue

    // Keep the simulation budget bounded, but rank legal centres by who their actual engine area
    // reaches. Nearest-to-group alone systematically loses good AoE and trap/glyph placements.
    const radius = Math.max(1, ...((projection?.effects ?? []).map((effect) => Number(effect.area_size))))
    const has_ally_value = (projection?.effects ?? []).some(
      (effect) => beneficial_effect_kinds.includes(effect.kind) ||
        (effect.stat === CHANNELS.hp && effect.kind === EFFECT_KINDS.add)
    )
    const healing_per_target = (projection?.effects ?? [])
      .filter((effect) => effect.stat === CHANNELS.hp && effect.kind === EFFECT_KINDS.add)
      .reduce((total, effect) => total + (Number(effect.value) + Number(effect.value_max)) / 2, 0)
    const occupied = legal.filter((cell) => living.some((fighter) => fighter.cell === cell))
    const nearby = legal
      .filter((cell) => living.some((fighter) => manhattan(cell, fighter.cell) <= radius))
      .sort((left, right) => distance_to_group(left, living) - distance_to_group(right, living))
      .slice(0, 12)
    const target_cells = [...new Set([...occupied, ...nearby])]
      .map((cell) => {
        const area = new Set(spell_area_cells(cp, actor, spell, cell))
        const enemy_hits = enemies.filter((fighter) => area.has(fighter.cell)).length
        const ally_value = friends
          .filter((fighter) => area.has(fighter.cell))
          .reduce((total, fighter) => {
            const missing = Math.max(0, fighter_max_hp(cp, fighter) - fighter_hp(fighter))
            return total + (healing_per_target > 0
              ? Math.min(missing, healing_per_target)
              : has_ally_value ? 1 : 0.1)
          }, 0)
        const occupied_bonus = living.some((fighter) => fighter.cell === cell) ? 0.25 : 0
        const coverage = enemy_hits + ally_value + occupied_bonus
        return { cell, coverage, distance: distance_to_group(cell, living) }
      })
      .sort((left, right) => right.coverage - left.coverage || left.distance - right.distance)
      .slice(0, TACTICAL_CANDIDATE_LIMIT)
      .map(({ cell }) => cell)

    if (target_cells.length === 0) continue

    for (const cell of target_cells) {
      const action: TurnAction = { type: 'cast', fighter_idx: actor, spell, target_cell: cell }
      candidates.set(action_key(action), { action, cost })
    }
  }

  baseline_response = enemy_response(cp, seat)
  for (const { action, cost } of candidates.values()) {
    const cast_started = PROFILE_PREVIEW ? performance.now() : 0
    planner_perf_add('tactical_cast_calls')
    const score = evaluate_action(cp, seat, action, cost, baseline_response, profile)
    if (PROFILE_PREVIEW) planner_perf_add('tactical_cast_ms', performance.now() - cast_started)
    if (score === null || score <= 0) {
      diagnostics?.push({
        action,
        ap_cost: cost,
        impact_per_ap: score,
        reason: score === null ? 'engine_rejected_or_unaffordable' : 'no_positive_projected_impact',
      })
      continue
    }
    diagnostics?.push({ action, ap_cost: cost, impact_per_ap: score, reason: 'lower_projected_impact' })
    if (!best || score > best.score) best = { action, score }
  }

  if (!best) return null

  if (diagnostics) {
    const selected_key = action_key(best.action)
    const selected = diagnostics.findIndex((row) => action_key(row.action) === selected_key)
    if (selected >= 0) diagnostics[selected]!.reason = 'selected_highest_projected_hp_per_ap'
  }

  log_debug(
    'combat',
    `seat ${seat} (${party_role}): BEST ACTION ${describe_actions([best.action])} impact_per_ap=${best.score.toFixed(2)} candidates=${candidates.size}`
  )

  return best.action
}


/** Party movement balances closing distance against the mob damage that the engine predicts before
 * this seat acts again. Include holding position and a few flank/retreat cells so the planner can
 * avoid walking the most durable member into a lethal focus-fire lane. */
const safe_step_toward_enemy = (
  cp: HydratedFightCheckpoint,
  seat: number,
  enemies: readonly Fighter[]
): readonly bigint[] | null => {
  const me = cp.contract.fighters[seat]
  if (!me) return null
  const occupied = new Set(cp.contract.fighters.filter((fighter) => !fighter.dead).map((fighter) => fighter.cell))
  const distance = (cell: bigint): number => distance_to_group(cell, enemies)
  const reachable = reachable_fight_cells(cp, BigInt(seat)).filter((cell) => !occupied.has(cell))
  const ranked_cells = reachable
    .map((cell) => ({ cell, distance: distance(cell) }))
    .sort((left, right) => left.distance - right.distance)
  // Enemy responses and attack access are simulated for every candidate; keep the closest advance
  // and one distant alternative so safety checks stay bounded as board reach grows.
  const nearest = ranked_cells.slice(0, 1).map(({ cell }) => cell)
  const farthest = ranked_cells.slice(-1).map(({ cell }) => cell)
  const options = [...new Set([...nearest, ...farthest])]
    .flatMap((cell) => {
      const path = fight_path_to(cp, BigInt(seat), cell)
      return path?.length ? [{ cell, path }] : []
    })
  type MovementScore = readonly [number, number, number, number, number, number]
  const movement_score = (cell: bigint, response: EnemyResponse, attack: DamageOption | null): MovementScore => [
    response.seat_dies ? 1 : 0,
    response.party_deaths,
    attack ? 0 : 1,
    -(attack?.damage ?? 0),
    response.party_damage,
    distance(cell),
  ]
  const compare_score = (left: MovementScore, right: MovementScore): number => {
    for (let index = 0; index < left.length; index++) {
      const difference = left[index]! - right[index]!
      if (difference !== 0) return difference
    }
    return 0
  }

  let best_path: readonly bigint[] | null = null
  let best_score = movement_score(me.cell, enemy_response(cp, seat), best_damage_option(cp, seat))
  for (const option of options) {
    planner_perf_add('movement_candidates')
    const action: TurnAction = { type: 'move', path: option.path }
    const result = response_after_action(cp, seat, action)
    const candidate_score = movement_score(option.cell, result.response, best_damage_option(result.state, seat))
    if (compare_score(candidate_score, best_score) < 0) {
      best_score = candidate_score
      best_path = option.path
    }
  }
  return best_path
}

/** Choose the highest-value legal action, otherwise reposition using safety and attack access. */
const next_action_party = (
  cp: HydratedFightCheckpoint,
  seat: number,
  ally_seats: readonly number[],
  party_role: PartyCombatRole
): TurnAction | null => {
  const me = cp.contract.fighters[seat]
  if (!me || me.dead) return null
  const actor = BigInt(seat)
  const enemies = cp.contract.fighters.filter((fighter) => !fighter.dead && fighter.team !== me.team)
  if (enemies.length === 0) return null
  const allies = cp.contract.fighters.filter((f, i) => !f.dead && f.team === me.team && ally_seats.includes(i))

  const preferred = best_action(cp, seat, allies, enemies, party_role)
  if (preferred !== null) return preferred

  // If no positive-impact action is available, advance only when the projected response is safe.
  const path = safe_step_toward_enemy(cp, seat, enemies)
  if (path === null) {
    log_debug(
      'plan',
      `seat ${seat}: holding position — no safe advance; enemies=${enemies.length} weapon=${weapon_target_cells(cp, actor).targetable.length} reachable=${reachable_fight_cells(cp, actor).length} spells=${spell_names_for(cp, seat).join('|')}`
    )
    return null
  }
  log_debug('plan', `seat ${seat} (${party_role}): MOVE after enemy-response check ${path.length}`)
  return { type: 'move', path }
}

/** Assign soft preferences from the character's class and actual spell kit. */
const assign_roles = (cp: HydratedFightCheckpoint, seats: readonly number[]): Map<number, PartyCombatRole> => {
  const roles = new Map<number, PartyCombatRole>()
  const seat_stats = seats.map((seat) => {
    const fighter = cp.contract.fighters[seat]
    const source = fighter?.kind.type === 'player' ? cp.sources.players[fighter.kind.character] : null
    const has_heal = spell_names_for(cp, seat).some((name) => is_heal_spell(cp, seat, name))
    const classe = source?.classe.toLowerCase() ?? ''
    return { seat, has_heal, classe }
  })

  // Roles are preferences only; the action scorer still evaluates the live state and available kit.
  for (const row of seat_stats) {
    if (row.classe.includes('yogan')) roles.set(row.seat, 'dps')
    else if (row.classe.includes('tomoda')) roles.set(row.seat, 'support')
    else if (row.classe.includes('mori') || row.classe.includes('yajin')) roles.set(row.seat, 'controller')
  }

  const unassigned = seat_stats.filter((row) => !roles.has(row.seat))
  for (const row of unassigned) roles.set(row.seat, row.has_heal ? 'support' : 'dps')

  return roles
}

const plan_turn_with_party = (
  cp: HydratedFightCheckpoint,
  seat: number,
  party_seats: readonly number[]
): readonly TurnAction[] => {
  const roles = assign_roles(cp, [seat, ...party_seats])
  const my_role = roles.get(seat) ?? 'dps'
  const scratch = create_fight({ state: cp, mode: 'local', hydrated: true })
  const actions: TurnAction[] = []
  let state = scratch.state()
  while (actions.length < MAX_TURN_ACTIONS) {
    const action = next_action_party(state, seat, party_seats, my_role)
    if (action === null) break
    const result = scratch.apply(sim_commands([action], BigInt(seat))[0]!)
    if (result.error) {
      log_debug('plan', `seat ${seat}: apply error ${String(result.error)}`)
      break
    }
    actions.push(action)
    state = result.state
  }
  log_debug(
    'plan',
    `plan_turn seat=${seat} role=${my_role} allies=[${party_seats.join(',')}] actions=${actions.length} ap=${cp.contract.fighters[seat]?.ap} mp=${cp.contract.fighters[seat]?.mp}`
  )
  planner_perf_report(`turn seat=${seat} role=${my_role} actions=${actions.length}`)
  return actions
}

/** A full greedy turn using the same decision rules for solo and party fights. */
export const plan_turn = (cp: HydratedFightCheckpoint, seat: number): readonly TurnAction[] => {
  const me = cp.contract.fighters[seat]
  const party_seats = me
    ? cp.contract.fighters.flatMap((fighter, index) =>
        index !== seat && !fighter.dead && fighter.team === me.team && fighter.kind.type === 'player' ? [index] : []
      )
    : []
  return plan_turn_with_party(cp, seat, party_seats)
}

/** A full coordinated turn for a party seat. */
export const plan_turn_party = (
  cp: HydratedFightCheckpoint,
  seat: number,
  party_seats: readonly number[] = []
): readonly TurnAction[] => {
  return plan_turn_with_party(cp, seat, party_seats)
}

/** Structured snapshot of the planner's main constraints and top attack candidates for analytics. */
export const inspect_turn_plan = (
  cp: HydratedFightCheckpoint,
  seat: number,
  actions: readonly TurnAction[] = []
): Readonly<Record<string, unknown>> => {
  const me = cp.contract.fighters[seat]
  if (!me || me.kind.type !== 'player') return Object.freeze({ reason: 'seat_missing_or_not_player' })
  const actor = BigInt(seat)
  const enemies = cp.contract.fighters.filter((fighter) => !fighter.dead && fighter.team !== me.team)
  const player = cp.sources.players[me.kind.character]
  const damage = [...damage_options(cp, seat, enemies)]
    .sort((left, right) => right.score - left.score || left.cost - right.cost)
    .slice(0, 8)
    .map((option) => ({ action: option.action, expected_damage: option.damage, ap_cost: option.cost, damage_per_ap: option.score }))
  const spells = spell_names_for(cp, seat).map((name) => {
    const level_index = Number((player?.spell_levels[name] ?? 1n) - 1n)
    const level = cp.sources.spells[name]?.levels[level_index]
    const cells = spell_target_cells(cp, actor, name)
    const enemy_cells = new Set(enemies.map((enemy) => enemy.cell))
    const legal_enemy_cells = cells.targetable.filter((cell) => enemy_cells.has(cell))
    const cooldown = me.cooldowns.find((entry) => entry.spell === name)?.left ?? 0n
    return {
      name,
      ap_cost: level ? Number(level.ap_cost) : null,
      cooldown: Number(cooldown),
      range_min: level ? Number(level.range_min) : null,
      range_max: level ? Number(level.range_max) : null,
      line_of_sight: level?.line_of_sight ?? null,
      range_cells: cells.range.length,
      legal_target_cells: cells.targetable.length,
      legal_enemy_cells: legal_enemy_cells.map(String),
      unavailable_reason:
        legal_enemy_cells.length > 0 ? null : cells.range.length === 0 ? 'no_cells_in_range' : 'no_legal_enemy_target',
    }
  })
  const response = enemy_response(cp, seat)
  const first = actions[0]
  const party_seats = cp.contract.fighters.flatMap((fighter, index) =>
    index !== seat && !fighter.dead && fighter.team === me.team && fighter.kind.type === 'player' ? [index] : []
  )
  const allies = cp.contract.fighters.filter((fighter, index) => party_seats.includes(index) && !fighter.dead)
  const role = assign_roles(cp, [seat, ...party_seats]).get(seat) ?? 'dps'
  const action_candidates: ActionDiagnostic[] = []
  const recommended = best_action(cp, seat, allies, enemies, role, action_candidates)
  const first_action_reason = !first
    ? 'no_legal_action_found'
    : first.type === 'move'
      ? actions.length > 1 ? 'movement opens a follow-up action' : 'movement selected after action candidates had no positive impact'
      : recommended && describe_actions([recommended]) === describe_actions([first])
        ? action_candidates.find((candidate) => candidate.reason === 'selected_highest_projected_hp_per_ap')?.reason ?? 'highest projected impact'
        : 'action differs from the current best candidate; checkpoint may have advanced'
  const replay = create_fight({ state: cp, mode: 'local', hydrated: true, seed: 1n })
  let replay_state = replay.state()
  const action_contexts = actions.map((action, index) => {
    const actor_before = replay_state.contract.fighters[seat]
    const live_enemies = replay_state.contract.fighters.filter(
      (fighter) => !fighter.dead && actor_before && fighter.team !== actor_before.team
    )
    const options = [...damage_options(replay_state, seat, live_enemies)]
      .sort((left, right) => right.score - left.score || left.cost - right.cost)
      .slice(0, 4)
      .map((option) => ({ action: option.action, expected_damage: option.damage, ap_cost: option.cost, damage_per_ap: option.score }))
    const spell_targets = spell_names_for(replay_state, seat).map((name) => {
      const enemy_cells = new Set(live_enemies.map((enemy) => enemy.cell))
      return {
        spell: name,
        legal_enemy_cells: spell_target_cells(replay_state, actor, name).targetable
          .filter((cell) => enemy_cells.has(cell))
          .map(String),
      }
    })
    const before = actor_before
      ? { cell: String(actor_before.cell), hp: Number(actor_before.hp), ap: Number(actor_before.ap), mp: Number(actor_before.mp) }
      : null
    const applied = replay.apply(sim_commands([action], actor)[0]!)
    if (!applied.error) replay_state = applied.state
    return {
      index,
      action,
      before,
      legal_enemy_targets: spell_targets.filter((row) => row.legal_enemy_cells.length > 0),
      top_damage_options: options,
      apply_error: applied.error ? String(applied.error) : null,
    }
  })
  return Object.freeze({
    selected_reason: first_action_reason,
    selected_action: first ?? null,
    selected_candidate: recommended,
    action_candidates,
    action_contexts,
    actor: {
      name: player?.name ?? me.kind.character,
      classe: player?.classe ?? null,
      cell: String(me.cell),
      hp: Number(me.hp),
      max_hp: fighter_max_hp(cp, me),
      ap: Number(me.ap),
      mp: Number(me.mp),
    },
    enemies: enemies.map((enemy) => {
      const enemy_seat = cp.contract.fighters.indexOf(enemy)
      return {
        seat: enemy_seat,
        turn_order: cp.contract.queue.indexOf(BigInt(enemy_seat)),
        mob_type: enemy.kind.type === 'mob' ? enemy.kind.snapshot.mob_type : enemy.kind.type,
        cell: String(enemy.cell),
        hp: Number(enemy.hp),
        max_hp: enemy.kind.type === 'mob' ? Number(enemy.kind.snapshot.max_hp) : Number(enemy.hp),
        distance: manhattan(me.cell, enemy.cell),
      }
    }),
    movement: {
      reachable_cells: reachable_fight_cells(cp, actor).length,
      actor_turn_order: cp.contract.queue.indexOf(actor),
    },
    spells,
    top_damage_options: damage,
    predicted_enemy_segment: {
      party_damage: response.party_damage,
      actor_damage: response.seat_damage,
      party_deaths: response.party_deaths,
      actor_dies: response.seat_dies,
      fighter_damage: response.fighter_damage.map((hp_loss, fighter_seat) => ({ seat: fighter_seat, hp_loss })).filter((row) => row.hp_loss > 0),
    },
  })
}

export const describe_actions = (actions: readonly TurnAction[]): string =>
  actions
    .map((action) => {
      if (action.type === 'move') return `move ${action.path.length}`
      if (action.type === 'cast') return `cast ${action.spell}@${action.target_cell}`
      return `strike@${action.target_cell}`
    })
    .join(', ')

/** Translate the planner's SDK-shaped actions into @aresrpg/fight commands for a local replay
 *  (mirrors the SDK's own agent_actions.ts simulator_action). */
export const sim_commands = (actions: readonly TurnAction[], fighter: bigint): readonly FightCommand[] =>
  actions.map((action) => {
    if (action.type === 'move') return { type: 'move_to', fighter, path: action.path }
    if (action.type === 'cast')
      return { type: 'cast_spell', fighter: action.fighter_idx, spell: action.spell, target_cell: action.target_cell }
    return { type: 'weapon_strike', fighter: action.fighter_idx, target_cell: action.target_cell }
  })
