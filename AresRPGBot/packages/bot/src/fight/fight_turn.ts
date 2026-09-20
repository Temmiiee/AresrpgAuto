// Live fight turn handler: each acting character's turn is decided by the SAME planner that
// trains offline (ai/sim_decide.ts's greedy pick + ai/lookahead.ts's multi-turn rollout) running
// against the real on-chain Fight state bridged through live_checkpoint.ts, then committed as one
// turn. The previous path shelled out to an RL subprocess (rl/decide_service.py in the sibling
// AresRPG-RL repo) — that service is gone, and since then every live fight silently played only
// the greedy fallback. When the planner can't run (bridge error on an unfamiliar seating, e.g. a
// non-party player sat in a resumed fight) or the chain rejects its gamble, we fall back to the
// simple strike-adjacent / move-toward logic, so a hang-up in the planning layer never costs a
// turn the chain can take. The whole plan is committed with ended=false (the SDK seal path
// requires `ended` to be literally true on-chain and a non-lethal `ended:true` reverts the turn
// for nothing — a killing blow lands fine through end_fight_turn's own ended handling).
import type { FightCommand } from '@aresrpg/fight'

import type { FightTurnAction } from '../../../sdk/src/fight.ts'
import { decide_turn_with_lookahead } from '../ai/lookahead.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import type { BotSdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { is_transient, message_of, rpc_backoff_ms, sleep, submit_with_retry } from '../shared/chain_retry.ts'

import { as_number, read_fight, type FightJson, type FighterJson } from './fight_state.ts'
import type { PartyPrep } from './fight_progression.ts'
import { live_max_hp_by_character, live_state_to_checkpoint } from './live_checkpoint.ts'

// Export the policy source for logging
const { policy: TRAINED_POLICY, source } = load_trained_policy()
export const DECISION_POLICY_SOURCE = source

// The fight grid is row-major `y * GRID_W + x`, NOT a bitpacked u16 — matching combat_grid.move's
// GRID_W=20 / GRID_H=19. Decoding clientside with `(cell & 0xff, cell >> 8)` and re-encoding with
// `x | (y << 8)` silently shifted every y-offset move out of the grid (cell+256 ≥ 380), so the
// walk_path probe always aborted 1725 → wasted RPC. These helpers share the chain's encoding.
const GRID_W = 20
const GRID_H = 19
const GRID_CELLS = GRID_W * GRID_H
const cell_x = (cell: bigint): number => Number(cell % BigInt(GRID_W))
const cell_y = (cell: bigint): number => Math.floor(Number(cell) / GRID_W)
const make_cell = (x: number, y: number): bigint => BigInt(y * GRID_W + x)

/** Exactly the chain's wall_mask minus self: state.closed (board shape + obstacles + holes,
 *  already a bitmask in the JSON) folded with every living fighter's cell. Cheap enough to
 *  rebuild per turn (6 u64 words × 64 bits). */
const walk_forbidden = (state_json: FightJson): Set<bigint> => {
  const forbidden = new Set<bigint>()
  state_json.closed.forEach((word, word_idx) => {
    const bits = BigInt(word)
    for (let bit = 0; bit < 64; bit += 1) {
      if ((bits >> BigInt(bit)) & 1n) forbidden.add(BigInt(word_idx * 64 + bit))
    }
  })
  for (const fighter of state_json.fighters) {
    if (as_number(fighter.hp) > 0) forbidden.add(BigInt(as_number(fighter.cell)))
  }
  return forbidden
}

const cardinal_neighbors = (cell: bigint): readonly bigint[] => {
  const x = cell_x(cell)
  const y = cell_y(cell)
  const neighbors: bigint[] = []
  if (x > 0) neighbors.push(make_cell(x - 1, y))
  if (x < GRID_W - 1) neighbors.push(make_cell(x + 1, y))
  if (y > 0) neighbors.push(make_cell(x, y - 1))
  if (y < GRID_H - 1) neighbors.push(make_cell(x, y + 1))
  return neighbors
}

/** Shortest 4-connected walk from `start` toward `target`, bounded by `max_steps` (the acting
 *  fighter's current mp — one cell per mp, exactly combat.move's walk_path budget). Skips every
 *  forbidden cell so a path that passes path_is_walkable is produced; null when the fighter is
 *  already there or no reachable step shortens the distance. */
const bfs_toward = (
  start: bigint,
  target: bigint,
  forbidden: ReadonlySet<bigint>,
  max_steps: number
): readonly bigint[] | null => {
  const manhattan = (cell: bigint): number =>
    Math.abs(cell_x(cell) - cell_x(target)) + Math.abs(cell_y(cell) - cell_y(target))
  if (manhattan(start) === 0) return null
  const frontier: { cell: bigint; path: readonly bigint[] }[] = [{ cell: start, path: [] }]
  const visited = new Set<bigint>([start])
  let best: readonly bigint[] | null = null
  let best_dist = manhattan(start)
  while (frontier.length > 0) {
    const current = frontier.shift()!
    if (current.path.length >= max_steps) continue
    for (const neighbor of cardinal_neighbors(current.cell)) {
      if (visited.has(neighbor) || forbidden.has(neighbor)) continue
      visited.add(neighbor)
      const next = [...current.path, neighbor] as const
      const dist = manhattan(neighbor)
      if (dist < best_dist) {
        best_dist = dist
        best = next
      }
      frontier.push({ cell: neighbor, path: next })
    }
  }
  return best
}

/** The planner emits @aresrpg/fight FightCommands acting on the seat index; the SDK owns the
 *  FighTurnAction wire shape. Every command type the planner produces maps 1:1 (fighter seat,
 *  target cells, spell name) — no re-derivation, so a greedy move_to's path reaches the chain
 *  exactly as the planner intended it. Unknown command types are dropped (the planner never
 *  emits end_turn/forfeit and the chain's commit_turn would reject them anyway). */
const commands_to_actions = (commands: readonly FightCommand[]): readonly FightTurnAction[] =>
  commands.flatMap((command): FightTurnAction[] => {
    if (command.type === 'move_to') return [{ type: 'move' as const, path: command.path.map((cell) => BigInt(cell)) }]
    if (command.type === 'weapon_strike')
      return [{ type: 'strike' as const, fighter_idx: command.fighter, target_cell: command.target_cell }]
    if (command.type === 'cast_spell')
      return [
        { type: 'cast' as const, fighter_idx: command.fighter, spell: command.spell, target_cell: command.target_cell },
      ]
    return []
  })

const describe_plan = (actions: readonly FightTurnAction[]): string =>
  actions
    .map((action) => {
      if (action.type === 'move') return `moved ${action.path.length} cells`
      if (action.type === 'cast') return `cast ${action.spell}`
      return 'struck'
    })
    .join(' + ')

/** Try the real turn planner for one acting character: bridge the live Fight JSON to a
 *  checkpoint (sim_party_stats carries what we know of their build), plan the whole turn with
 *  lookahead + the trained policy, and commit it as one turn. false (or a caught non-transient
 *  failure) means "fall back to basic"; transient errors are rethrown so the surrounding loop's
 *  caller can decide — a rate-limited RPC is backpressure, not a bad plan. */
const try_planned_turn = async (
  bot: BotSdk,
  fight_id: string,
  state_json: FightJson,
  turn: number,
  acting_idx: number,
  acting: (typeof CHARACTERS)[number],
  prep: PartyPrep,
  log: (msg: string) => void
): Promise<boolean> => {
  const { fight } = bot
  try {
    const checkpoint = live_state_to_checkpoint(state_json, prep.sim_party_stats)
    const actions = commands_to_actions(
      decide_turn_with_lookahead(
        checkpoint,
        BigInt(acting_idx),
        live_max_hp_by_character(prep.sim_party_stats),
        TRAINED_POLICY
      )
    )
    if (actions.length === 0) return false
    await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions }), log)
    log(`turn ${turn}: ${acting.name} ${describe_plan(actions)}`)
    return true
  } catch (error) {
    if (is_transient(error)) throw error
    log(`planner turn failed (${message_of(error)}) — basic behavior`)
    return false
  }
}

/** The nearest living enemy and its Manhattan distance from `my_cell` (grid encoding). */
function nearest_enemy_cell(
  my_cell: bigint,
  living_enemies: readonly (FighterJson & { idx: number })[]
): { target_cell: bigint; distance: number } {
  let target_cell = BigInt(as_number(living_enemies[0]!.cell))
  let min_distance = Number.MAX_SAFE_INTEGER

  for (const enemy of living_enemies) {
    const enemy_cell = BigInt(as_number(enemy.cell))
    const distance = Math.abs(cell_x(enemy_cell) - cell_x(my_cell)) + Math.abs(cell_y(enemy_cell) - cell_y(my_cell))
    if (distance < min_distance) {
      min_distance = distance
      target_cell = enemy_cell
    }
  }

  return { target_cell, distance: min_distance }
}

/** Basic behavior fallback: strike the nearest enemy when adjacent, otherwise move toward it. */
async function commit_basic_action(
  bot: BotSdk,
  fight_id: string,
  acting_idx: number,
  my_cell: bigint,
  target: { target_cell: bigint; distance: number },
  state_json: FightJson,
  turn: number,
  acting: (typeof CHARACTERS)[number],
  log: (msg: string) => void
): Promise<boolean> {
  const { fight } = bot

  if (target.distance <= 1) {
    // Adjacent - strike
    try {
      await submit_with_retry(
        () =>
          fight.commit_turn({
            fight: fight_id,
            actions: [
              {
                type: 'strike',
                fighter_idx: BigInt(acting_idx),
                target_cell: target.target_cell,
              },
            ],
          }),
        log
      )
      log(`turn ${turn}: ${acting.name} struck nearest enemy`)
      return true
    } catch (error) {
      if (!is_transient(error)) {
        // If strike fails, try moving anyway (returns whether the move actually landed)
        return try_basic_move(bot, fight_id, acting_idx, my_cell, target.target_cell, turn, acting, state_json, log)
      }
      throw error
    }
  }

  // Not adjacent - move toward enemy
  return try_basic_move(bot, fight_id, acting_idx, my_cell, target.target_cell, turn, acting, state_json, log)
}

/** Decides and commits exactly one acting character's turn: the trained planner first (lookahead
 *  + spells + movement all in ONE commit), the simple strike/move fallback only if the planner
 *  can't run or the chain rejects its plan. Returns true when a real on-chain action landed
 *  (a move/strike/cast the chain accepted), false when the turn resolved to a pure pass — the
 *  caller uses that to detect stale fights. */
const decide_and_commit_turn = async (
  bot: BotSdk,
  fight_id: string,
  state_json: FightJson,
  turn: number,
  acting_idx: number,
  acting: (typeof CHARACTERS)[number],
  acting_fighter: FighterJson,
  prep: PartyPrep,
  log: (msg: string) => void
): Promise<boolean> => {
  const { fight } = bot
  const my_team = acting_fighter.team

  // Get living enemies
  const living_enemies = state_json.fighters
    .map((f, idx) => ({ ...f, idx }))
    .filter((f) => f.team !== my_team && as_number(f.hp) > 0)

  // If no enemies left, pass turn
  if (living_enemies.length === 0) {
    await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions: [] }), log)
    return false
  }

  // The planner decides the whole turn first; any failure falls back to the greedy logic below
  // rather than ever skipping the chain's turn.
  if (await try_planned_turn(bot, fight_id, state_json, turn, acting_idx, acting, prep, log)) {
    return true
  }

  // Fallback: basic behavior - strike nearest enemy or move toward them
  const my_cell = BigInt(as_number(state_json.fighters[acting_idx]!.cell))
  const target = nearest_enemy_cell(my_cell, living_enemies)
  return commit_basic_action(bot, fight_id, acting_idx, my_cell, target, state_json, turn, acting, log)
}

/** Try to move toward the target cell, walking the shortest grid-valid path within the acting
 *  fighter's mp budget (up to GRID_W×GRID_H cells; one step per mp, matching walk_path).
 *  Returns true when a move was committed, false when every candidate was rejected (the caller
 *  then passes the turn). The path is pre-filtered against state.closed + living cells, so a
 *  rejected simulation is rare rather than the ~2-per-turn it used to be. */
async function try_basic_move(
  bot: BotSdk,
  fight_id: string,
  acting_idx: number,
  my_cell: bigint,
  target_cell: bigint,
  turn: number,
  acting: (typeof CHARACTERS)[number],
  state_json: FightJson,
  log: (msg: string) => void
): Promise<boolean> {
  const { fight } = bot

  // The acting fighter's current mp is the walk_path budget (spend_mp per step). Move only if
  // it has at least 1 mp; otherwise passing is cheaper than a doomed simulation.
  const mp_budget = as_number(state_json.fighters[acting_idx]?.mp ?? 0)
  if (mp_budget <= 0) return false

  // Shortest valid walk toward the target, capped by mp. Never attempts a wall/occupied/off-grid
  // step, so a path that passes the chain's own path_is_walkable is produced first try.
  const path = bfs_toward(my_cell, target_cell, walk_forbidden(state_json), mp_budget)

  if (path === null || path.length === 0) {
    log(`turn ${turn}: ${acting.name} moved failed, passing`)
    await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions: [] }), log)
    return false
  }

  try {
    await submit_with_retry(
      () =>
        fight.commit_turn({
          fight: fight_id,
          actions: [{ type: 'move', path }],
        }),
      log
    )
    log(`turn ${turn}: ${acting.name} moved toward enemy (${path.length} steps)`)
    return true
  } catch (error) {
    if (is_transient(error)) throw error
    // Rare (grid snapshot race): the whole path was rejected despite pre-filtering. Still keep
    // the turn honest rather than retry-looping the same RPC budget.
    log(`turn ${turn}: ${acting.name} moved failed, passing`)
    await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions: [] }), log)
    return false
  }
}

export const run_turn_loop = async (
  bot: BotSdk,
  fight_id: string,
  prep: PartyPrep,
  log: (msg: string) => void
): Promise<{ final_state: FightJson; turns: number }> => {
  const { sdk, fight } = bot
  let final_state: FightJson | null = null
  let turns = 0

  // No action but passes for this many consecutive acting-character turns means the fight
  // geometry can't be improved from here (every move/strike rejected). Keep grinding the 400-turn
  // cap costs gas on commits that never move the fight forward, so abort participation instead
  // and let the chain resolve (or time out) the fight on its own.
  const STALL_LIMIT = 18
  let stall_turns = 0

  for (let turn = 0; turn < 400; turn += 1) {
    const state_json = await read_fight(sdk, fight_id)
    if (state_json.ended) {
      final_state = state_json
      break
    }
    turns = turn + 1

    const acting_idx_raw = state_json.queue[as_number(state_json.turn_ptr)]
    // Just-created fights can briefly snapshot with turn_ptr past the populated queue (fighters
    // attach under their own authority over a few checkpoints); a missing/NaN actor must pass
    // instead of crashing the whole session with the party stuck in custody on-chain.
    const acting_idx = Number(acting_idx_raw)
    const acting_fighter = Number.isFinite(acting_idx) ? state_json.fighters[acting_idx] : undefined
    const acting_character = acting_fighter?.kind['@variant'] === 'Player' ? acting_fighter.kind.character : undefined
    const acting = CHARACTERS.find((c) => c.id === acting_character)

    if (!acting_fighter || !acting || as_number(acting_fighter.hp) <= 0) {
      await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions: [] }), log)
      await sleep(rpc_backoff_ms(250, 1_000)) // Reduced sleep for faster turns
      continue
    }

    // combat.move's end_fight_turn asserts `now_ms >= turn_started_ms + TURN_MIN_MS(3_000)` —
    // committing before the floor reverts the WHOLE PTB (move/cast included) and burns that
    // attempt's gas, then submit_with_retry stalls 2.5s before retrying. Targeting ~2.35s before
    // commit leaves the final on-chain commit (RPC + validator latency ≈ 0.5-1s) just past the
    // 3s floor instead of occasionally under it on back-to-back own-party seats.
    const turn_started_ms = as_number(state_json.turn_started_ms)
    const now_ms = Date.now()
    const wait = turn_started_ms + 2_350 - now_ms
    if (wait > 0) await sleep(wait)

    const took_action = await decide_and_commit_turn(
      bot,
      fight_id,
      state_json,
      turn,
      acting_idx,
      acting,
      acting_fighter,
      prep,
      log
    )
    stall_turns = took_action ? 0 : stall_turns + 1
    if (stall_turns >= STALL_LIMIT) {
      log(
        `fight ${fight_id}: ${STALL_LIMIT} consecutive turns with no action — fight looks stuck, ` +
          `stopping participation (letting it resolve on-chain)`
      )
      break
    }
    await sleep(rpc_backoff_ms(300, 1_000)) // Reduced sleep between turns
  }

  // A fight we left before it reached a result (stall guard) — there is nothing to settle and no
  // winner to report. Throw here so the session loop treats it as an aborted fight (won: null)
  // without calling settle on an unfinished fight.
  final_state ??= await read_fight(sdk, fight_id)
  if (!final_state!.ended) {
    throw new Error(
      `fight ${fight_id} aborted after ${turns} turns without a result — stopped participating to stop burning gas, letting it resolve on-chain`
    )
  }

  return { final_state, turns }
}
