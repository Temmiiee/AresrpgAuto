// Movement/targeting geometry — reuses the game's own deterministic TS twin of the Move combat
// grid (packages/fight) instead of reimplementing BFS pathing/line-of-sight by hand, so the
// bot's movement decisions can never diverge from what the chain will actually accept.
import { fight_path_to } from '@aresrpg/fight'

// bfs_cast_cell/mask_add_cells/approach_field/step_cell/CARDINAL_DIRECTIONS aren't in that
// package's public exports map — relative import, same monorepo convention used for
// @aresrpg/sdk's character_actions.ts/fight.ts.
import {
  CARDINAL_DIRECTIONS,
  approach_field,
  bfs_cast_cell,
  manhattan,
  mask_add_cells,
  step_cell,
} from '../../../fight/src/combat_grid.ts'

export { manhattan }

export type SimFighter = { cell: bigint; dead: boolean; mp: bigint }
export type SimState = { fighters: readonly SimFighter[]; closed: readonly bigint[] }

const living_cells_excluding = (state: SimState, exclude: number): bigint[] =>
  state.fighters.filter((f, i) => i !== exclude && !f.dead).map((f) => f.cell)

const wall_mask_for = (state: SimState, fighter_idx: number): bigint[] =>
  mask_add_cells([...state.closed], living_cells_excluding(state, fighter_idx))

/** The best reachable cell (within the fighter's MP) to attack `target_cell` with a
 *  [range_min, range_max] (LOS-aware) attack — null if nothing in budget works, including
 *  "already in range" (returns the fighter's own cell in that case). */
export const find_cast_cell = (
  state: SimState,
  fighter_idx: number,
  target_cell: bigint,
  range_min: number,
  range_max: number,
  needs_los: boolean,
  obstacles: readonly bigint[]
): bigint | null => {
  const subject = state.fighters[fighter_idx]
  if (!subject || subject.dead) return null
  return bfs_cast_cell({
    start: subject.cell,
    target: target_cell,
    wall_mask: wall_mask_for(state, fighter_idx),
    budget: subject.mp,
    range_min: BigInt(range_min),
    range_max: BigInt(range_max),
    needs_los,
    obstacles: [...obstacles],
  })
}

/** The exact orthogonal walk path to `cell` — the same shape move_fighter expects, validated
 *  the same way the chain validates it (path_is_walkable inside fight_path_to's caller). */
export const path_to = (state: SimState, fighter_idx: number, cell: bigint): readonly bigint[] | null =>
  fight_path_to({ contract: { fighters: state.fighters, closed: state.closed } } as never, BigInt(fighter_idx), cell)

const best_step = (current: bigint, field: readonly bigint[]): bigint | null => {
  let best: bigint | null = null
  let best_value = field[Number(current)]!
  for (const direction of CARDINAL_DIRECTIONS) {
    const cell = step_cell(current, direction)
    if (cell === null) continue
    const value = field[Number(cell)]
    if (value === undefined) continue
    if (value < best_value || (value === best_value && best !== null && cell < best)) {
      best = cell
      best_value = value
    }
  }
  return best
}

/** Best-effort "get closer" when nothing can be reached to attack this turn: walk DOWN the
 *  approach field (distance to the target's nearest open flank) for as many steps as this
 *  fighter's MP allows — unlike path_to, this does not require fully arriving anywhere, it
 *  just spends the available MP closing the gap (the game's own `walk_down`/`approach_field`
 *  technique for a rusher who can't yet reach striking range). */
export const approach_path = (state: SimState, fighter_idx: number, target_cell: bigint): readonly bigint[] | null => {
  const subject = state.fighters[fighter_idx]
  if (!subject || subject.dead || subject.mp <= 0n) return null
  const field = approach_field(target_cell, wall_mask_for(state, fighter_idx), subject.cell)
  const path: bigint[] = []
  let current = subject.cell
  while (path.length < Number(subject.mp) && (field[Number(current)] ?? 0n) > 0n) {
    const next = best_step(current, field)
    if (next === null) break
    path.push(next)
    current = next
  }
  return path.length > 0 ? path : null
}
