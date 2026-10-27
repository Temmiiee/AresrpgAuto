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
  type Fighter,
  type HydratedFightCheckpoint,
  type SpellTurnProjection,
} from '@aresrpg/fight'
import { AREA_SHAPES, CHANNELS, EFFECT_KINDS } from '@aresrpg/fight/move_contract'

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

/** Check if a spell is a heal (targets allies, restores HP). */
const is_heal_spell = (name: string): boolean =>
  name.toLowerCase().includes('soothe') || name.toLowerCase().includes('heal') || name.toLowerCase().includes('bramble')

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

type DamageOption = Readonly<{ action: TurnAction; score: number; cost: number }>

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
      if (dealt > 0) options.push({ action: make_action(cell), score: dealt / ap, cost: ap })
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
  return ranked[0]?.action ?? null
}

/** The longest legal path (bounded by the fighter's MP) ending closest to the nearest enemy. */
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

  // 1. HEAL PRIORITY: any ally BELOW HALF of its OWN max HP and I have a heal → heal the most
  //    hurt one. (The old filter read `hp > 0` — ANY living ally — so supports wasted every cast
  //    on healthy targets, in the live door AND this twin's replay of it.)
  const hurt_ally = allies
    .map((ally) => ({ ally, hp: fighter_hp(ally), max: fighter_max_hp(cp, ally) }))
    .filter(({ hp, max }) => hp > 0 && hp * 2 < max)
    .sort((left, right) => left.hp / left.max - right.hp / right.max)[0]
  if (hurt_ally) {
    for (const name of spell_names_for(cp, seat)) {
      if (!is_heal_spell(name)) continue
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
  const path = step_toward_enemy(cp, seat, enemies)
  if (path === null) {
    log_debug(
      'plan',
      `seat ${seat}: no path — enemies=${enemies.length} weapon=${weapon_target_cells(cp, actor).targetable.length} reachable=${reachable_fight_cells(cp, actor).length} spells=${spell_names_for(cp, seat).join('|')}`
    )
    return null
  }
  log_debug('plan', `seat ${seat} (${party_role}): MOVE forward ${path.length}`)
  return { type: 'move', path }
}

/** Assign a party role to each seat based on stats. */
const assign_roles = (cp: HydratedFightCheckpoint, seats: readonly number[]): Map<number, 'tank' | 'support' | 'dps'> => {
  const roles = new Map<number, 'tank' | 'support' | 'dps'>()
  const seat_stats = seats.map((seat) => {
    const fighter = cp.contract.fighters[seat]
    const source = fighter?.kind.type === 'player' ? cp.sources.players[fighter.kind.character] : null
    const vit = source ? Number(source.vitality ?? 0n) : 0
    const has_heal = spell_names_for(cp, seat).some(is_heal_spell)
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