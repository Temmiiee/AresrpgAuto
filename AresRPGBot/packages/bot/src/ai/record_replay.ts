// Records one full fight as a turn-by-turn trace for cli_record_replay.ts's visualization
// export (2026-09-03, project owner: "it would be good to have a visualisation of what the bot
// actually do"). Mirrors simulate.ts's simulate_fight loop exactly (same virtual clock, same
// decider contract) but also snapshots board + fighter state after every turn, instead of only
// the final outcome -- simulate_fight itself stays untouched since normal training/validation
// runs thousands of fights and don't need this overhead.
//
// Cell coordinates are re-projected to LOCAL x/y (via @aresrpg/fight's own project_board_cells,
// cropped to this board's occupied bounding box) rather than shipping raw cell numbers: a fight
// cell is encoded against the engine's fixed 20x19 global grid (combat_grid.ts's GRID_W/GRID_H),
// completely independent of this board's own (usually much smaller) width/height -- a viewer
// naively doing `cell % board.width` would misplace every token. Reusing project_board_cells
// instead of re-deriving that encoding keeps this file correct if the engine's grid constants
// or shape_mask logic ever change.
import { create_fight, player_max_hp, project_board_cells } from '@aresrpg/fight'
import type { HydratedFightCheckpoint } from '@aresrpg/fight'

import { build_setup, type SimMobGroupMember, type SimPartyMember, type TurnDecider } from './simulate.ts'
import { decide_turn } from './sim_decide.ts'
import { all_spell_sources } from './sim_content.ts'
import { DEFAULT_POLICY, type Policy } from './policy.ts'

const SPELLS = all_spell_sources()

export type ReplayFighter = {
  id: number
  team: number
  name: string
  is_player: boolean
  classe: string | null
  max_hp: number
}

export type ReplayAction = {
  type: string
  spell: string | null
  target: { x: number; y: number } | null
  path: { x: number; y: number }[] | null
}

export type ReplayFighterState = { id: number; x: number; y: number; hp: number; dead: boolean }

export type ReplayFrame = {
  turn: number
  round: number
  actor: number
  actions: ReplayAction[]
  /** Every fighter's x/y/hp AFTER this turn's actions resolved (including whatever the engine's
   *  own mob-turn auto-resolution did in between, since apply({type: 'end_turn'}) runs every
   *  mob turn up to the next living player in one call). */
  fighters: ReplayFighterState[]
}

export type Replay = {
  seed: string
  won: boolean
  board: {
    width: number
    height: number
    cells: { x: number; y: number; kind: 'floor' | 'obstacle' | 'hole' | 'start_a' | 'start_b' }[]
  }
  fighters: ReplayFighter[]
  /** Starting positions, before turn 1 -- so the viewer has a real "turn 0" to open on instead
   *  of starting mid-action. */
  initial: ReplayFighterState[]
  frames: ReplayFrame[]
}

export const record_fight = (
  party: readonly SimPartyMember[],
  mob_group: readonly SimMobGroupMember[],
  seed: bigint,
  policy: Policy = DEFAULT_POLICY,
  decider: TurnDecider = decide_turn
): Replay => {
  const { players, mobs, characters } = build_setup(party, mob_group)
  const max_hp_by_character = new Map(characters.map(({ id, source }) => [id, player_max_hp(source)]))

  const fight = create_fight({
    setup: { fight_id: 'replay', world: 'replay', board_seed: seed, players, mobs, spells: SPELLS },
    mode: 'local',
    seed,
  })
  const TURN_MIN_MS = 3_100n
  let virtual_ms = 0n
  fight.apply({ type: 'start', observed_ms: virtual_ms })

  let checkpoint: HydratedFightCheckpoint = fight.state()

  const projected = project_board_cells(checkpoint.contract.board)
  const min_x = Math.min(...projected.map((c) => c.x))
  const min_y = Math.min(...projected.map((c) => c.y))
  const max_x = Math.max(...projected.map((c) => c.x))
  const max_y = Math.max(...projected.map((c) => c.y))
  const to_xy = new Map(projected.map((c) => [c.cell, { x: c.x - min_x, y: c.y - min_y }]))
  const xy_of = (cell: bigint) => to_xy.get(cell) ?? { x: 0, y: 0 }

  const board = {
    width: max_x - min_x + 1,
    height: max_y - min_y + 1,
    cells: projected.map((c) => ({ x: c.x - min_x, y: c.y - min_y, kind: c.kind })),
  }

  const fighters: ReplayFighter[] = checkpoint.contract.fighters.map((f, id) => {
    const { kind } = f
    if (kind.type === 'player') {
      // Narrowing a destructured `const` (kind) survives into this nested closure; narrowing
      // f.kind directly would not — TS only tracks that across the enclosing scope, not into a
      // callback passed to another function (findIndex here).
      const index = characters.findIndex(({ id: cid }) => cid === kind.character)
      const member = index >= 0 ? party[index] : undefined
      return {
        id,
        team: Number(f.team),
        name: member?.name ?? kind.character,
        is_player: true,
        classe: member?.classe ?? null,
        max_hp: Number(max_hp_by_character.get(kind.character) ?? 1n),
      }
    }
    return {
      id,
      team: Number(f.team),
      name: kind.snapshot.mob_type,
      is_player: false,
      classe: null,
      max_hp: Number(kind.snapshot.max_hp),
    }
  })

  const snapshot_fighters = (cp: HydratedFightCheckpoint): ReplayFighterState[] =>
    cp.contract.fighters.map((f, id) => ({ id, ...xy_of(f.cell), hp: Number(f.hp), dead: f.dead }))

  const initial = snapshot_fighters(checkpoint)

  const frames: ReplayFrame[] = []
  let turns = 0
  while (!checkpoint.contract.ended && turns < 400) {
    const acting_idx = checkpoint.contract.queue[Number(checkpoint.contract.turn_ptr)]!
    const actions = decider(checkpoint, acting_idx, max_hp_by_character, policy)
    for (const action of actions) fight.apply(action)
    virtual_ms += TURN_MIN_MS
    const result = fight.apply({ type: 'end_turn', fighter: acting_idx, observed_ms: virtual_ms })
    checkpoint = result.state
    turns += 1
    frames.push({
      turn: turns,
      round: Number(checkpoint.contract.round),
      actor: Number(acting_idx),
      actions: actions.map((a) => ({
        type: a.type,
        spell: 'spell' in a ? a.spell : null,
        target: 'target_cell' in a ? xy_of(a.target_cell) : null,
        path: 'path' in a ? a.path.map(xy_of) : null,
      })),
      fighters: snapshot_fighters(checkpoint),
    })
  }

  return {
    seed: seed.toString(),
    won: checkpoint.contract.winner === 0n,
    board,
    fighters,
    initial,
    frames,
  }
}
