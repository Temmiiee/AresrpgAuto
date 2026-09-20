// The simulator's turn AI — mirrors fight/fight_turn.ts's live turn-decision logic (multi-enemy
// priority-weighted targeting, greedy AP-filling, one offensive action per turn, capped last),
// scored through the same shared formulas (policy.ts's priority_weight/finish_bonus/heal_score),
// but adapted to @aresrpg/fight's native bigint state instead of the on-chain JSON shape — that
// data-shape difference is real and stays separate; only the actual scoring arithmetic is shared.
import { weapon_level_of } from '@aresrpg/fight'
import type { Fighter, FightCommand, HydratedFightCheckpoint } from '@aresrpg/fight'

import { approach_path, find_cast_cell, manhattan, path_to, type SimState } from '../fight/fight_geometry.ts'

import { castable_spells } from './spell_catalog.ts'
import { DEFAULT_POLICY, element_advantage, finish_bonus, heal_score, priority_weight, type Policy } from './policy.ts'
import { caster_damage_multiplier } from './stat_allocation.ts'

const HEAL_THRESHOLD = 0.8

type Candidate = {
  kind: 'cast' | 'strike'
  spell?: string
  range_min: number
  range_max: number
  los: boolean
  ap_cost: number
  target_cell: bigint | null
  score: number
}

const candidate_key = (c: Candidate): string => `${c.kind}:${c.spell ?? ''}:${c.target_cell ?? ''}`

const max_hp_of = (fighter: Fighter, max_hp_by_character: ReadonlyMap<string, bigint>): number =>
  fighter.kind.type === 'mob'
    ? Number(fighter.kind.snapshot.max_hp)
    : Number(max_hp_by_character.get(fighter.kind.character) ?? 1n)

const heal_state = (
  ally_fighters: readonly Fighter[],
  max_hp_by_character: ReadonlyMap<string, bigint>
): { target_cell: bigint | null; deficit: number } => {
  const [wounded] = ally_fighters
    .map((f) => ({ cell: f.cell, fraction: Number(f.hp) / max_hp_of(f, max_hp_by_character) }))
    .sort((a, b) => a.fraction - b.fraction)
  const target_cell = wounded && wounded.fraction < HEAL_THRESHOLD ? wounded.cell : null
  const deficit = wounded && wounded.fraction < HEAL_THRESHOLD ? 1 - wounded.fraction : 0
  return { target_cell, deficit }
}

// The strike's real geometry (range, AP, LOS, element) comes from the acting character's own
// weapon through the engine's weapon_level_of — its category physics + damage lines replace the
// old hardcoded unarmed 1-1 range / 4 AP / earth assumption whenever a weapon source is present
// (a bow reaches 2-6 and fires its own element, etc.). With no weapon the source yields
// unarmed(), so offline behavior is UNCHANGED until a weapon reaches create_character_source —
// this just makes the planner legal for ranged fighters the day their (still-unreadable, L-D4)
// equipped weapon starts flowing into the sources. weapon_level_of only ever returns null for a
// non-player seat or a missing source — both guarded before this is ever reached.
const strike_geometry = (
  checkpoint: HydratedFightCheckpoint,
  acting_idx: bigint
): { ap_cost: number; range_min: number; range_max: number; los: boolean; element: string } => {
  const level = weapon_level_of(checkpoint, acting_idx)!
  return {
    ap_cost: Number(level.ap_cost),
    range_min: Number(level.range_min),
    range_max: Number(level.range_max),
    los: level.line_of_sight,
    element: level.effects[0]?.element ?? 'earth',
  }
}

const assemble_actions = (
  chosen: readonly { kind: 'cast' | 'strike'; spell?: string; target_cell: bigint }[],
  moved_path: readonly bigint[] | null,
  acting_idx: bigint,
  sim: SimState,
  my_cell: bigint,
  enemy_cells: ReadonlySet<bigint>
): FightCommand[] => {
  const actions: FightCommand[] = []
  if (moved_path) actions.push({ type: 'move_to', fighter: acting_idx, path: moved_path })
  for (const c of chosen)
    actions.push(
      c.kind === 'cast'
        ? { type: 'cast_spell', fighter: acting_idx, spell: c.spell!, target_cell: c.target_cell }
        : { type: 'weapon_strike', fighter: acting_idx, target_cell: c.target_cell }
    )

  if (actions.length === 0) {
    const closest_enemy_cell = [...enemy_cells].sort((a, b) =>
      Number(manhattan(my_cell, a) - manhattan(my_cell, b))
    )[0]!
    const approach = approach_path(sim, Number(acting_idx), closest_enemy_cell)
    if (approach && approach.length > 0) actions.push({ type: 'move_to', fighter: acting_idx, path: approach })
  }

  return actions
}

/** Decides every action for the current actor's turn — a move (at most one) plus as many
 *  cast/strike actions as AP allows, capped to one enemy-targeting action (placed last) for the
 *  same reason fight_session.ts caps it: a killing blow can end the fight mid-transaction, and
 *  anything bundled after that reverts the whole turn on the real chain. The simulator doesn't
 *  have that failure mode (there's no transaction to revert), but keeping the same shape means
 *  what wins here is exactly what would win live.
 *
 *  `exclude_first` (lookahead.ts) forces the greedy pick at step 0 to skip these candidates —
 *  calling this repeatedly with an accumulating exclusion set of the previous winners' keys
 *  yields the top-K distinct turn PLANS instead of just the single best one, so lookahead has
 *  more than one option per actor to actually compare. */
export const decide_turn = (
  checkpoint: HydratedFightCheckpoint,
  acting_idx: bigint,
  max_hp_by_character: ReadonlyMap<string, bigint>,
  policy: Policy = DEFAULT_POLICY,
  exclude_first: ReadonlySet<string> = new Set()
): readonly FightCommand[] => {
  const { contract, sources } = checkpoint
  const acting_idx_n = Number(acting_idx)
  const acting = contract.fighters[acting_idx_n]!
  if (acting.kind.type !== 'player') return []
  const character = sources.players[acting.kind.character]
  if (!character) return []

  const my_team = acting.team
  const living_enemies = contract.fighters.map((f, idx) => ({ ...f, idx })).filter((f) => f.team !== my_team && !f.dead)
  if (living_enemies.length === 0) return []

  const enemies_by_priority = [...living_enemies].sort((a, b) => Number(a.hp - b.hp))
  const enemy_cells = new Set(enemies_by_priority.map((f) => f.cell))
  const finish_bonus_of = (enemy: (typeof enemies_by_priority)[number]): number =>
    finish_bonus(Number(enemy.hp), max_hp_of(enemy, max_hp_by_character), policy.finish_weight)
  const resistance_of = (enemy: (typeof enemies_by_priority)[number], element: string | null): number | null => {
    if (!element || enemy.kind.type !== 'mob') return null
    const { snapshot } = enemy.kind
    const raw =
      element === 'earth'
        ? snapshot.earth_res
        : element === 'fire'
          ? snapshot.fire_res
          : element === 'water'
            ? snapshot.water_res
            : element === 'air'
              ? snapshot.air_res
              : null
    return raw === null ? null : Number(raw)
  }
  const element_bonus = (enemy: (typeof enemies_by_priority)[number], element: string | null): number =>
    policy.element_weight * element_advantage(resistance_of(enemy, element))

  const sim: SimState = {
    fighters: contract.fighters.map((f) => ({ cell: f.cell, dead: f.dead, mp: f.mp })),
    closed: contract.closed,
  }
  const { obstacles } = contract.board
  const my_cell = sim.fighters[acting_idx_n]!.cell

  const ally_fighters = contract.fighters
    .map((f, idx) => ({ ...f, idx }))
    .filter((f) => f.team === my_team && !f.dead && f.kind.type === 'player')
  const heal_target = heal_state(ally_fighters, max_hp_by_character)
  const heal_target_cell = heal_target.target_cell
  const heal_deficit = heal_target.deficit

  const known_spells = castable_spells(
    character.classe,
    Number(character.level),
    Object.fromEntries(Object.entries(character.spell_levels).map(([name, lvl]) => [name, Number(lvl)]))
  )
  const caster_stats = {
    strength: Number(character.strength),
    intelligence: Number(character.intelligence),
    chance: Number(character.chance),
    agility: Number(character.agility),
  }
  const strike = strike_geometry(checkpoint, acting_idx)
  const build_candidates = (): Candidate[] => {
    const list: Candidate[] = []
    for (const s of known_spells) {
      if (s.role === 'damage') {
        enemies_by_priority.forEach((enemy, rank) => {
          list.push({
            kind: 'cast',
            spell: s.name,
            range_min: s.range_min,
            range_max: s.range_max,
            los: s.line_of_sight,
            ap_cost: s.ap_cost,
            target_cell: enemy.cell,
            score:
              policy.base_weight *
                s.score *
                caster_damage_multiplier(s.element, caster_stats) *
                priority_weight(rank, policy.priority_decay) +
              finish_bonus_of(enemy) +
              element_bonus(enemy, s.element),
          })
        })
        continue
      }
      if (s.role !== 'support') continue
      const target = s.is_heal ? heal_target_cell : my_cell
      if (target === null) continue
      const score = s.is_heal
        ? heal_score(policy.base_weight, s.score, policy.heal_weight, heal_deficit)
        : policy.base_weight * s.score
      list.push({
        kind: 'cast',
        spell: s.name,
        range_min: s.range_min,
        range_max: s.range_max,
        los: s.line_of_sight,
        ap_cost: s.ap_cost,
        target_cell: target,
        score,
      })
    }
    enemies_by_priority.forEach((enemy, rank) => {
      list.push({
        kind: 'strike',
        range_min: strike.range_min,
        range_max: strike.range_max,
        los: strike.los,
        ap_cost: strike.ap_cost,
        target_cell: enemy.cell,
        score:
          policy.strike_bias +
          priority_weight(rank, policy.priority_decay) +
          finish_bonus_of(enemy) +
          element_bonus(enemy, strike.element),
      })
    })
    return list.sort((a, b) => b.score - a.score)
  }

  let remaining_ap = Number(acting.ap)
  let cursor_cell = my_cell
  let moved_path: readonly bigint[] | null = null
  const chosen: { kind: 'cast' | 'strike'; spell?: string; target_cell: bigint }[] = []
  const used_spell_names = new Set<string>()
  let offensive_committed = false
  // Candidate scores are a pure function of the turn's static state (enemy HP/cells, caster
  // stats, spell/weapon rows) — none of it changes as the greedy loop spends AP, so build + sort
  // the ranked list ONCE per turn and let each step just re-scan it against the current cursor.
  // The per-step `.find` still evaluates reachability (find_cast_cell / path_to) fresh, since a
  // moved cursor genuinely changes what's castable — only the score work is hoisted. (Measured
  // win: build_candidates once vs. once per greedy step, the previous behavior.)
  const candidates = build_candidates()
  for (let step = 0; step < 6 && remaining_ap > 0 && !offensive_committed; step += 1) {
    const at_cursor: SimState = {
      ...sim,
      fighters: sim.fighters.map((f, i) => (i === acting_idx_n ? { ...f, cell: cursor_cell } : f)),
    }
    const picked = candidates.find((c) => {
      if (step === 0 && exclude_first.has(candidate_key(c))) return false
      if (c.ap_cost > remaining_ap) return false
      if (c.spell && used_spell_names.has(c.spell)) return false
      if (c.target_cell === null) return false
      const cast_cell = find_cast_cell(
        at_cursor,
        acting_idx_n,
        c.target_cell,
        c.range_min,
        c.range_max,
        c.los,
        obstacles
      )
      if (cast_cell === null) return false
      if (cast_cell !== cursor_cell) {
        if (moved_path) return false
        const path = path_to(at_cursor, acting_idx_n, cast_cell)
        if (!path) return false
        moved_path = path
        cursor_cell = cast_cell
      }
      return true
    })
    if (!picked) break
    chosen.push({ kind: picked.kind, spell: picked.spell, target_cell: picked.target_cell! })
    remaining_ap -= picked.ap_cost
    if (picked.spell) used_spell_names.add(picked.spell)
    if (enemy_cells.has(picked.target_cell!)) offensive_committed = true
  }

  return assemble_actions(chosen, moved_path, acting_idx, sim, my_cell, enemy_cells)
}
