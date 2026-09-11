// Turns the currently-in-progress live Fight object into the same board+fighters shape
// record_replay.ts produces for simulated fights (2026-09-05, project owner: "see a
// visualisation of the current fight") — so cli_control_panel.ts's viewer can reuse the exact
// same rendering code as the "Tactics Replay" artifact, just polling live chain state instead of
// loading a recorded JSON file. Reuses live_checkpoint.ts's live_state_to_checkpoint (already
// built for lookahead.ts's live rollout) rather than re-deriving fighter/board decoding here.
import { project_board_cells } from '@aresrpg/fight'
import type { HydratedFightCheckpoint } from '@aresrpg/fight'

import { live_state_to_checkpoint, live_max_hp_by_character } from './live_checkpoint.ts'
import type { SimPartyMember } from '../ai/simulate.ts'
import { CHARACTERS } from '../config/party_config.ts'

export type LiveFighterState = { id: number; x: number; y: number; hp: number; max_hp: number; dead: boolean; team: number; name: string }
export type LiveFightSnapshot = {
  ended: boolean
  won: boolean | null
  round: number
  actor: number
  board: { width: number; height: number; cells: { x: number; y: number; kind: string }[] }
  fighters: LiveFighterState[]
}

export const build_live_fight_snapshot = (
  raw_fight_json: unknown,
  sim_party_stats: ReadonlyMap<string, SimPartyMember>
): LiveFightSnapshot => {
  const checkpoint: HydratedFightCheckpoint = live_state_to_checkpoint(raw_fight_json, sim_party_stats)
  const { contract } = checkpoint

  const projected = project_board_cells(contract.board)
  const min_x = Math.min(...projected.map((c) => c.x))
  const min_y = Math.min(...projected.map((c) => c.y))
  const max_x = Math.max(...projected.map((c) => c.x))
  const max_y = Math.max(...projected.map((c) => c.y))
  const to_xy = new Map(projected.map((c) => [c.cell, { x: c.x - min_x, y: c.y - min_y }]))
  const xy_of = (cell: bigint) => to_xy.get(cell) ?? { x: 0, y: 0 }

  // Widened to plain `string` keys on purpose: CHARACTERS.map's own literal id union would
  // otherwise reject a live fighter's runtime character id (f.kind.character, typed as plain
  // `string`) at the .get() below, even though "not one of ours" is an expected, handled case
  // (the ?? fallback right there).
  const name_by_character = new Map<string, string>(CHARACTERS.map((c) => [c.id, c.name]))
  const max_hp_by_character = live_max_hp_by_character(sim_party_stats)

  const fighters: LiveFighterState[] = contract.fighters.map((f, id) => {
    const { x, y } = xy_of(f.cell)
    if (f.kind.type === 'player') {
      return {
        id,
        x,
        y,
        hp: Number(f.hp),
        max_hp: Number(max_hp_by_character.get(f.kind.character) ?? 1n),
        dead: f.dead,
        team: Number(f.team),
        name: name_by_character.get(f.kind.character) ?? f.kind.character,
      }
    }
    return {
      id,
      x,
      y,
      hp: Number(f.hp),
      max_hp: Number(f.kind.snapshot.max_hp),
      dead: f.dead,
      team: Number(f.team),
      name: f.kind.snapshot.mob_type,
    }
  })

  return {
    ended: contract.ended,
    won: contract.ended ? contract.winner === 0n : null,
    round: Number(contract.round),
    actor: Number(contract.queue[Number(contract.turn_ptr)] ?? -1),
    board: {
      width: max_x - min_x + 1,
      height: max_y - min_y + 1,
      cells: projected.map((c) => ({ x: c.x - min_x, y: c.y - min_y, kind: c.kind })),
    },
    fighters,
  }
}
