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
  reachable_fight_cells,
  spell_target_cells,
  weapon_target_cells,
  type FightCommand,
  type Fighter,
  type HydratedFightCheckpoint,
} from '@aresrpg/fight'

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

/** The next single legal action for a seated fighter, or null when nothing helps: an in-range
 *  weapon strike, else the first spell with an enemy in reach, else one move toward the nearest. */
const next_action = (cp: HydratedFightCheckpoint, seat: number): TurnAction | null => {
  const me = cp.contract.fighters[seat]
  if (!me || me.dead) return null
  const actor = BigInt(seat)
  const enemies = cp.contract.fighters.filter((fighter) => !fighter.dead && fighter.team !== me.team)
  if (enemies.length === 0) return null
  const enemy_cells = new Set(enemies.map((fighter) => fighter.cell))

  const strike = weapon_target_cells(cp, actor).targetable.find((cell) => enemy_cells.has(cell))
  if (strike !== undefined) return { type: 'strike', fighter_idx: actor, target_cell: strike }

  for (const name of spell_names_for(cp, seat)) {
    const target = spell_target_cells(cp, actor, name).targetable.find((cell) => enemy_cells.has(cell))
    if (target !== undefined) return { type: 'cast', fighter_idx: actor, spell: name, target_cell: target }
  }

  const path = step_toward_enemy(cp, seat, enemies)
  return path === null ? null : { type: 'move', path }
}

/** A full greedy turn: take legal actions until none remain. The scratch local fight applies each
 *  step so the next decision sees the real remaining AP/MP; it is discarded, never submitted. */
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
