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
  project_spell_turn,
  project_weapon_turn,
  reachable_fight_cells,
  spell_area_cells,
  spell_target_cells,
  weapon_area_cells,
  weapon_level_of,
  weapon_target_cells,
  type FightCommand,
  type BoardZone,
  type Fighter,
  type HydratedFightCheckpoint,
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

const cell_x = (cell: bigint): number => Number(cell % GRID_W)
const cell_y = (cell: bigint): number => Math.floor(Number(cell) / GRID_W_N)
const manhattan = (a: bigint, b: bigint): number => Math.abs(cell_x(a) - cell_x(b)) + Math.abs(cell_y(a) - cell_y(b))

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
}>
const response_cache = new WeakMap<object, Map<number, EnemyResponse>>()

/** Replay the engine's deterministic enemy segment after this player's turn. The local twin runs the
 * actual mob AI (including target selection, movement, spells, cooldowns and zones), so safety is
 * estimated from the current fight state instead of a fixed distance-to-mob guess. */
const enemy_response = (cp: HydratedFightCheckpoint, seat: number): EnemyResponse => {
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
  })
  const actor = BigInt(seat)
  if (cp.contract.queue[Number(cp.contract.turn_ptr)] !== actor) return unchanged
  const scratch = create_fight({ state: cp, mode: 'local', seed: 1n })
  const before = cp.contract.fighters.map((fighter) => Number(fighter.hp))
  const result = scratch.simulate_turn({
    observed_ms: cp.contract.turn_started_ms + CONTRACT_CONSTANTS.turn_min_ms,
  })
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
  })
  by_seat.set(seat, response)
  return response
}

/** Apply one candidate action to the same local twin, then measure the enemy segment it leaves. */
const response_after_action = (
  cp: HydratedFightCheckpoint,
  seat: number,
  action: TurnAction
): EnemyResponse => {
  const scratch = create_fight({ state: cp, mode: 'local', seed: 1n })
  const applied = scratch.apply(action.type === 'move'
    ? { type: 'move_to', fighter: BigInt(seat), path: action.path }
    : action.type === 'cast'
      ? { type: 'cast_spell', fighter: action.fighter_idx, spell: action.spell, target_cell: action.target_cell }
      : { type: 'weapon_strike', fighter: action.fighter_idx, target_cell: action.target_cell })
  return applied.error ? enemy_response(cp, seat) : enemy_response(applied.state, seat)
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

/** Every damaging action this seat may take right now, scored by the enemy HP it removes per action
 *  point: the sum, over the card's WHOLE area, of the damage it lands on each enemy (never more
 *  than that enemy has left, so overkill is not worth chasing) divided by the AP the card costs. */
const damage_options = (cp: HydratedFightCheckpoint, seat: number, enemies: readonly Fighter[]): readonly DamageOption[] => {
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
      const area = point ? [cell] : area_of(cell)
      let dealt = 0
      for (const enemy of enemies) if (area.includes(enemy.cell)) dealt += Math.min(per_target, fighter_hp(enemy))
      if (dealt > 0) options.push({ action: make_action(cell), score: dealt / ap, cost: ap, damage: dealt })
    }
  }

  const strike_targets = weapon_target_cells(cp, actor).targetable.filter((cell) => enemy_cells.has(cell))
  if (strike_targets.length > 0) {
    collect(
      (cell) => ({ type: 'strike', fighter_idx: actor, target_cell: cell }),
      project_weapon_turn(cp, actor),
      (cell) => weapon_area_cells(cp, actor, cell),
      strike_targets,
      Number(weapon_level_of(cp, actor)?.ap_cost ?? 4n)
    )
  }

  for (const name of spell_names_for(cp, seat)) {
    const spell_targets = spell_target_cells(cp, actor, name).targetable.filter((cell) => enemy_cells.has(cell))
    if (spell_targets.length === 0) continue
    collect(
      (cell) => ({ type: 'cast', fighter_idx: actor, spell: name, target_cell: cell }),
      project_spell_turn(cp, actor, name),
      (cell) => spell_area_cells(cp, actor, name, cell),
      spell_targets,
      spell_ap_cost(cp, seat, name)
    )
  }

  return options
}

/** The damaging action that turns this turn's action points into the most enemy HP. Ties go to the
 *  cheaper card, which leaves AP for one more action in the same turn. */
const best_damage_action = (cp: HydratedFightCheckpoint, seat: number, enemies: readonly Fighter[]): TurnAction | null => {
  const ranked = [...damage_options(cp, seat, enemies)].sort(
    (left, right) => right.score - left.score || left.cost - right.cost
  )
  if (ranked.length <= 1) return ranked[0]?.action ?? null

  // Damage per AP remains the baseline, but when two attacks are close prefer the one that leaves
  // the simulated enemy segment less dangerous. This makes lethal/focus-fire hits count without
  // letting a defensive bonus routinely displace a much stronger attack.
  const baseline = enemy_response(cp, seat)
  const safety_score = (option: DamageOption): number => {
    const after = response_after_action(cp, seat, option.action)
    const prevented = Math.max(0, baseline.party_damage - after.party_damage)
    const deaths_prevented = Math.max(0, baseline.party_deaths - after.party_deaths)
    return option.score + prevented * 0.08 + deaths_prevented * 8
  }
  let best = ranked[0]!
  let best_score = safety_score(best)
  // Bound extra engine replays: options outside the top four by raw damage efficiency cannot
  // displace the baseline enough to justify the simulation cost.
  for (const option of ranked.slice(1, 4)) {
    const score = safety_score(option)
    if (score > best_score) {
      best = option
      best_score = score
    }
  }
  return best.action
}

/** The longest legal path (bounded by the fighter's MP) ending closest to the nearest enemy. */

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

const TACTICAL_CANDIDATE_LIMIT = 6

const beneficial_effect_kinds: readonly bigint[] = [
  EFFECT_KINDS.add,
  EFFECT_KINDS.reduce,
  EFFECT_KINDS.reflect,
  EFFECT_KINDS.redirect,
  EFFECT_KINDS.return,
  EFFECT_KINDS.invis,
  EFFECT_KINDS.chatiment,
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
 * Evaluate one candidate cast by applying it to a disposable local fight.
 *
 * This uses the same resolver as the real fight:
 * - damage and healing
 * - AP/MP grants and removals
 * - status effects
 * - dispels
 * - teleport, push, pull and swaps
 * - trap and glyph placement
 */
const evaluate_tactical_cast = (
  cp: HydratedFightCheckpoint,
  seat: number,
  spell: string,
  cell: bigint,
  profile: TacticalProfile
): number | null => {
  const actor = BigInt(seat)
  const caster = cp.contract.fighters[seat]
  if (!caster || caster.dead) return null

  const cost = spell_ap_cost(cp, seat, spell)
  if (Number(caster.ap) < cost) return null

  const simulation = create_fight({ state: cp, mode: 'local' })
  const result = simulation.apply({
    type: 'cast_spell',
    fighter: actor,
    spell,
    target_cell: cell,
  })

  if (result.error) return null

  const after = result.state
  const friends = cp.contract.fighters.filter(
    (fighter) => !fighter.dead && fighter.team === caster.team
  )
  const enemies = cp.contract.fighters.filter(
    (fighter) => !fighter.dead && fighter.team !== caster.team
  )

  let utility = 0

  // 1. Actual HP changes, including resisted damage and healing.
  for (let index = 0; index < cp.contract.fighters.length; index++) {
    const before_fighter = cp.contract.fighters[index]
    const after_fighter = after.contract.fighters[index]

    if (!before_fighter || !after_fighter || before_fighter.dead) continue

    const delta = Number(after_fighter.hp - before_fighter.hp)
    const ally = before_fighter.team === caster.team

    if (delta > 0) {
      if (ally) {
        const missing = Math.max(
          0,
          fighter_max_hp(cp, before_fighter) - fighter_hp(before_fighter)
        )

        utility +=
          Math.min(delta, missing) * profile.healing
      } else {
        utility -= Math.min(delta, fighter_hp(before_fighter))
      }
    } else if (delta < 0) {
      if (ally) {
        utility += delta * 1.4
      } else {
        utility += Math.min(-delta, fighter_hp(before_fighter))
      }
    }
  }

  // 2. AP and MP changes from effects.
  // Cast costs are deliberately excluded.
  for (const event of result.events) {
    if (event.type !== 'ap_mp_change') continue
    if (event.payload.reason === 'cast_cost') continue

    const target = cp.contract.fighters[Number(event.payload.fighter)]
    if (!target) continue

    const ally = target.team === caster.team
    const ap_delta = Number(
      event.payload.ap_after - event.payload.ap_before
    )
    const mp_delta = Number(
      event.payload.mp_after - event.payload.mp_before
    )

    utility += (ally ? ap_delta : -ap_delta) * 3.5
    utility += (ally ? mp_delta : -mp_delta) * 1.5
  }

  // 3. Persistent effects, shields, buffs, debuffs, poison and invisibility.
  for (const event of result.events) {
    if (event.type !== 'effect_applied') continue

    const payload = event.payload
    const index = Number(payload.target)
    const target = cp.contract.fighters[index]
    if (!target) continue

    const ally = target.team === caster.team
    const kind = payload.kind
    const channel = payload.channel
    const value = Math.min(100, Math.abs(Number(payload.value)))
    const duration = Math.max(1, Math.min(4, Number(payload.turns)))

    const positive = beneficial_effect_kinds.includes(kind)
    const helps_party = ally === positive

    let magnitude = 0

    if (channel === CHANNELS.hp) {
      // Regeneration and poison can matter even though they do not
      // immediately change HP when first applied.
      magnitude = value * duration * 0.45
    } else if (channel === CHANNELS.ap) {
      magnitude = value * duration * 0.9
    } else if (channel === CHANNELS.mp) {
      magnitude = value * duration * 0.4
    } else {
      magnitude = 2 + value * 0.06 * duration
    }

    if (kind === EFFECT_KINDS.invis) {
      magnitude = 8 + duration * 2
    } else if (kind === EFFECT_KINDS.reduce) {
      magnitude = 3 + value * duration * 0.12
    }

    const duplicate = target.effects.some(
      (effect) =>
        effect.kind === kind &&
        effect.stat === channel &&
        effect.element === payload.element &&
        effect.turns_left > 0n
    )

    if (duplicate) magnitude *= 0.18

    const weight =
      channel === CHANNELS.hp
        ? profile.healing
        : helps_party
          ? profile.buff
          : profile.control

    utility += (helps_party ? magnitude : -magnitude) * weight
  }

  // 4. Dispel effects.
  for (const event of result.events) {
    if (event.type !== 'effects_dispelled') continue

    const target = cp.contract.fighters[Number(event.payload.target)]
    if (!target) continue

    const ally = target.team === caster.team
    const count = event.payload.removed_effect_ids.length

    utility += (ally ? -count : count) * 3 * profile.control
  }

  // 5. Non-walking movement: teleport, push, pull and swap.
  for (const event of result.events) {
    if (event.type !== 'fighter_moved') continue
    if (event.payload.mode === 'walk') continue

    const index = Number(event.payload.fighter)
    const before_fighter = cp.contract.fighters[index]
    const after_fighter = after.contract.fighters[index]

    if (!before_fighter || !after_fighter) continue

    if (index === seat) {
      const old_distance = distance_to_group(
        before_fighter.cell,
        enemies
      )
      const new_distance = distance_to_group(
        after_fighter.cell,
        enemies
      )

      utility +=
        Math.max(0, old_distance - new_distance) *
        profile.mobility
    } else if (before_fighter.team !== caster.team) {
      const old_distance = distance_to_group(
        before_fighter.cell,
        friends
      )
      const new_distance = distance_to_group(
        after_fighter.cell,
        friends
      )

      if (event.payload.mode === 'push') {
        utility +=
          Math.max(0, new_distance - old_distance) *
          0.6 *
          profile.control
      } else if (event.payload.mode === 'pull') {
        utility +=
          Math.max(0, old_distance - new_distance) *
          0.45 *
          profile.control
      }
    }
  }

  // 6. Placement-only spells.
  utility += score_new_zones(cp, after, seat, profile)

  // 7. Survival through the next enemy segment. A locally replayed mob turn captures the effects
  // of damage, kills, control, healing and displacement. Reward casts that reduce party damage and
  // heavily reject a cast that leaves this caster dead before its next turn.
  const baseline_response = enemy_response(cp, seat)
  const caster_hp_ratio = fighter_hp(caster) / Math.max(1, fighter_max_hp(cp, caster))
  if (baseline_response.party_damage > 0 || caster_hp_ratio < 0.7) {
    const candidate_response = enemy_response(after, seat)
    utility += (baseline_response.party_damage - candidate_response.party_damage) * 0.8
    utility += (baseline_response.party_deaths - candidate_response.party_deaths) * 160
    if (!baseline_response.seat_dies && candidate_response.seat_dies) utility -= 500
    else if (baseline_response.seat_dies && !candidate_response.seat_dies) utility += 500
  }

  return utility / Math.max(1, cost)
}

/**
 * Pick the best class-aware spell only when it beats the existing
 * damage planner. This prevents support spells from replacing a much
 * stronger available attack.
 */
const best_class_tactical_action = (
  cp: HydratedFightCheckpoint,
  seat: number,
  _party_allies: readonly Fighter[],
  enemies: readonly Fighter[]
): TurnAction | null => {
  const profile = tactical_profile(cp, seat)
  const me = cp.contract.fighters[seat]

  if (!profile || !me || me.dead || enemies.length === 0) return null

  const actor = BigInt(seat)
  const living = cp.contract.fighters.filter((fighter) => !fighter.dead)

  let best: { action: TurnAction; score: number } | null = null

  for (const spell of spell_names_for(cp, seat)) {
    if (spell_ap_cost(cp, seat, spell) > Number(me.ap)) continue

    const legal = spell_target_cells(cp, actor, spell).targetable
    if (legal.length === 0) continue

    // Always include occupied target cells first, then nearby legal cells.
    // This keeps the number of expensive local simulations bounded.
    const occupied = legal.filter((cell) =>
      living.some((fighter) => fighter.cell === cell)
    )

    const nearby = [...legal].sort(
      (a, b) =>
        distance_to_group(a, living) - distance_to_group(b, living)
    )

    const candidates = [...new Set([...occupied, ...nearby])]
      .slice(0, TACTICAL_CANDIDATE_LIMIT)

    for (const cell of candidates) {
      const score = evaluate_tactical_cast(
        cp,
        seat,
        spell,
        cell,
        profile
      )

      if (score === null || score <= 0) continue

      if (!best || score > best.score) {
        best = {
          action: {
            type: 'cast',
            fighter_idx: actor,
            spell,
            target_cell: cell,
          },
          score,
        }
      }
    }
  }

  if (!best) return null

  // The old damage scorer remains the fallback and comparison baseline.
  const damage_baseline = Math.max(
    0,
    ...damage_options(cp, seat, enemies).map((option) => option.score)
  )

  const required_score = Math.max(0.65, damage_baseline * 1.08)

  if (best.score <= required_score) return null

  log_debug(
    'combat',
    `seat ${seat}: CLASS TACTICAL ${describe_actions([best.action])} score=${best.score.toFixed(2)} baseline=${damage_baseline.toFixed(2)}`
  )

  return best.action
}


const step_toward_enemy = (
  cp: HydratedFightCheckpoint,
  seat: number,
  enemies: readonly Fighter[]
): readonly bigint[] | null => {
  const me = cp.contract.fighters[seat]
  if (!me) return null
  const nearest = enemies.reduce((best, fighter) =>
    manhattan(me.cell, fighter.cell) < manhattan(me.cell, best.cell) ? fighter : best
  )
  const occupied = new Set(cp.contract.fighters.filter((fighter) => !fighter.dead).map((fighter) => fighter.cell))
  const best = reachable_fight_cells(cp, BigInt(seat))
    .filter((cell) => !occupied.has(cell))
    .reduce<bigint | null>(
      (target, cell) =>
        target === null || manhattan(cell, nearest.cell) < manhattan(target, nearest.cell) ? cell : target,
      null
    )
  if (best === null) return null
  const path = fight_path_to(cp, BigInt(seat), best)
  return path && path.length > 0 ? path : null
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
  const nearest = [...reachable].sort((a, b) => distance(a) - distance(b)).slice(0, 8)
  const farthest = [...reachable].sort((a, b) => distance(b) - distance(a)).slice(0, 4)
  const options = [...new Set([...nearest, ...farthest])]
    .flatMap((cell) => {
      const path = fight_path_to(cp, BigInt(seat), cell)
      return path?.length ? [{ cell, path }] : []
    })
  const current_hp = fighter_hp(me)
  const max_hp = Math.max(1, fighter_max_hp(cp, me))
  const danger_weight = 0.01 + (1 - Math.min(1, current_hp / max_hp)) * 0.25
  const score = (cell: bigint, response: EnemyResponse): number =>
    distance(cell) + response.seat_damage * danger_weight + (response.seat_dies ? 10_000 : 0)

  let best_path: readonly bigint[] | null = null
  let best_score = score(me.cell, enemy_response(cp, seat))
  for (const option of options) {
    const action: TurnAction = { type: 'move', path: option.path }
    const candidate_score = score(option.cell, response_after_action(cp, seat, action))
    if (candidate_score < best_score) {
      best_score = candidate_score
      best_path = option.path
    }
  }
  return best_path
}

/** A heal that can prevent a near-term party casualty outranks damage and ordinary class utility. */
const critical_heal_action = (
  cp: HydratedFightCheckpoint,
  seat: number,
  allies: readonly Fighter[]
): TurnAction | null => {
  const actor = BigInt(seat)
  const me = cp.contract.fighters[seat]
  if (!me) return null
  const forecast = enemy_response(cp, seat).fighter_damage
  const endangered = [...allies]
    .map((ally) => {
      const ally_seat = cp.contract.fighters.indexOf(ally)
      const hp = fighter_hp(ally)
      const max = fighter_max_hp(cp, ally)
      const projected_hp = Math.max(0, hp - (forecast[ally_seat] ?? 0))
      return { ally, hp, max, projected_hp }
    })
    .filter(({ hp, max, projected_hp }) =>
      hp > 0 && (hp / Math.max(1, max) <= 0.4 || projected_hp === 0 || projected_hp / Math.max(1, max) <= 0.25)
    )
    .sort((a, b) => a.projected_hp / Math.max(1, a.max) - b.projected_hp / Math.max(1, b.max))
  if (!endangered.length) return null
  for (const { ally, hp, max, projected_hp } of endangered) {
    for (const name of spell_names_for(cp, seat)) {
      if (spell_ap_cost(cp, seat, name) > Number(me.ap) || !is_heal_spell(cp, seat, name)) continue
      if (!spell_target_cells(cp, actor, name).targetable.includes(ally.cell)) continue
      log_debug(
        'combat',
        `seat ${seat}: EMERGENCY HEAL ${name} on ally at ${ally.cell} (HP ${hp}/${max}, forecast ${projected_hp}/${max})`
      )
      return { type: 'cast', fighter_idx: actor, spell: name, target_cell: ally.cell }
    }
  }
  return null
}

/** The best action for ONE seat given a SHARED party context (focus fire, heal priority, positioning). */
const next_action_party = (
  cp: HydratedFightCheckpoint,
  seat: number,
  ally_seats: readonly number[],
  party_role: 'tank' | 'support' | 'dps'
): TurnAction | null => {
  const me = cp.contract.fighters[seat]
  if (!me || me.dead) return null
  const actor = BigInt(seat)
  const enemies = cp.contract.fighters.filter((fighter) => !fighter.dead && fighter.team !== me.team)
  if (enemies.length === 0) return null
  const allies = cp.contract.fighters.filter((f, i) => !f.dead && f.team === me.team && ally_seats.includes(i))

  const emergency_heal = critical_heal_action(cp, seat, allies)
  if (emergency_heal) return emergency_heal

  const class_aware = tactical_profile(cp, seat) !== null
  const tactical = best_class_tactical_action(cp, seat, allies, enemies)
  if (tactical !== null) return tactical

  // 1. HEAL PRIORITY: any ally BELOW HALF of its OWN max HP and I have a heal → heal the most
  //    hurt one. (The old filter read `hp > 0` — ANY living ally — so supports wasted every cast
  //    on healthy targets, in the live door AND this twin's replay of it.)
  const hurt_ally = class_aware ? undefined : allies
    .map((ally) => ({ ally, hp: fighter_hp(ally), max: fighter_max_hp(cp, ally) }))
    .filter(({ hp, max }) => hp > 0 && hp * 2 < max)
    .sort((left, right) => left.hp / left.max - right.hp / right.max)[0]
  if (hurt_ally) {
    for (const name of spell_names_for(cp, seat)) {
      if (!is_heal_spell(cp, seat, name)) continue
      const targets = spell_target_cells(cp, actor, name).targetable
      if (targets.includes(hurt_ally.ally.cell)) {
        log_debug(
          'combat',
          `seat ${seat} (${party_role}): HEAL ${name} on ally at ${hurt_ally.ally.cell} (HP ${hurt_ally.hp}/${hurt_ally.max})`
        )
        return { type: 'cast', fighter_idx: actor, spell: name, target_cell: hurt_ally.ally.cell }
      }
    }
  }

  // 2. DAMAGE: the strongest hit this turn's action points can buy (see damage_options — the
  //    weapon strike and every spell are ranked on the enemy HP they actually remove per AP).
  const damage = best_damage_action(cp, seat, enemies)
  if (damage !== null) {
    log_debug('combat', `seat ${seat} (${party_role}): DAMAGE ${describe_actions([damage])}`)
    return damage
  }

  // 3. POSITIONING: no attack in range — ALWAYS close the distance to the nearest enemy. (An
  //    earlier "supports hold back when an ally is ahead" rule returned a null action, which made a
  //    whole turn empty: the character wasted its turn AND, before the pass guard existed, froze the
  //    fight on a no-op turn. Closing distance gets every seat into range and can never deadlock.)
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

/** Assign a party role to each seat based on stats. */
const assign_roles = (cp: HydratedFightCheckpoint, seats: readonly number[]): Map<number, 'tank' | 'support' | 'dps'> => {
  const roles = new Map<number, 'tank' | 'support' | 'dps'>()
  const seat_stats = seats.map((seat) => {
    const fighter = cp.contract.fighters[seat]
    const source = fighter?.kind.type === 'player' ? cp.sources.players[fighter.kind.character] : null
    const vit = source ? Number(source.vitality ?? 0n) : 0
    const has_heal = spell_names_for(cp, seat).some((name) => is_heal_spell(cp, seat, name))
    return { seat, vit, has_heal }
  })
  
  // One tank (highest vitality)
  const tank = seat_stats.reduce((best, cur) => cur.vit > best.vit ? cur : best)
  roles.set(tank.seat, 'tank')
  
  // Supports = have heals (excluding tank)
  for (const s of seat_stats) {
    if (s.seat === tank.seat) continue
    if (s.has_heal) roles.set(s.seat, 'support')
    else roles.set(s.seat, 'dps')
  }
  
  return roles
}

/** The next single legal action for a seated fighter (solo). */
const next_action = (cp: HydratedFightCheckpoint, seat: number): TurnAction | null => {
  const me = cp.contract.fighters[seat]
  if (!me || me.dead) return null
  const enemies = cp.contract.fighters.filter((fighter) => !fighter.dead && fighter.team !== me.team)
  if (enemies.length === 0) return null

  const tactical = best_class_tactical_action(cp, seat, [], enemies)
  if (tactical !== null) return tactical

  const damage = best_damage_action(cp, seat, enemies)
  if (damage !== null) return damage

  const path = step_toward_enemy(cp, seat, enemies)
  return path === null ? null : { type: 'move', path }
}

/** A full greedy turn: take legal actions until none remain (solo). */
export const plan_turn = (cp: HydratedFightCheckpoint, seat: number): readonly TurnAction[] => {
  const scratch = create_fight({ state: cp, mode: 'local' })
  const actions: TurnAction[] = []
  let state = scratch.state()
  while (actions.length < MAX_TURN_ACTIONS) {
    const action = next_action(state, seat)
    if (action === null) break
    const result = scratch.apply(sim_commands([action], BigInt(seat))[0]!)
    if (result.error) break
    actions.push(action)
    state = result.state
  }
  return actions
}

/** A full coordinated turn for a party seat. */
export const plan_turn_party = (
  cp: HydratedFightCheckpoint,
  seat: number,
  party_seats: readonly number[] = []
): readonly TurnAction[] => {
  if (party_seats.length === 0) return plan_turn(cp, seat) // solo fallback
  
  const roles = assign_roles(cp, party_seats)
  const my_role = roles.get(seat) ?? 'dps'
  const scratch = create_fight({ state: cp, mode: 'local' })
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
    `plan_turn_party seat=${seat} role=${my_role} allies=[${party_seats.join(',')}] actions=${actions.length} ap=${cp.contract.fighters[seat]?.ap} mp=${cp.contract.fighters[seat]?.mp}`
  )
  return actions
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
  const first_is_heal = first?.type === 'cast' && is_heal_spell(cp, seat, first.spell)
  const first_is_raw_damage = first !== undefined && damage.some((option) =>
    option.action.type === first.type &&
    (option.action.type === 'move' || first.type === 'move'
      ? option.action.type === 'move' && first.type === 'move' && option.action.path.join(',') === first.path.join(',')
      : option.action.type === 'cast' && first.type === 'cast'
        ? option.action.spell === first.spell && option.action.target_cell === first.target_cell
        : option.action.type === 'strike' && first.type === 'strike' && option.action.target_cell === first.target_cell)
  )
  const first_action_reason = !first
    ? 'no_legal_action_found'
    : first.type === 'move'
      ? actions.length > 1
        ? 'repositioning_then_followup_action'
        : 'no_current_attack_or_support_action_selected; repositioning'
      : first_is_heal
        ? 'healing_or_emergency_survival'
        : first_is_raw_damage
          ? 'damage_option; candidates ranked by damage efficiency and simulated threat reduction'
          : 'class_tactical_utility (control, buff, zone, displacement, or survival)'
  const replay = create_fight({ state: cp, mode: 'local', seed: 1n })
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
