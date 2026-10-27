// The fight driver. It mirrors the official client's split: the server streams the authoritative
// checkpoint (`packet/fight_state`, pushed after every turn boundary via FightProjected), the bot
// normalizes it through @aresrpg/fight exactly as the client does, plans one legal turn from the
// normalized read model, and submits it through the SDK's custody doors. The chain re-validates
// every action; this module only has to stay legal.
//
//   * hydrate   — wire checkpoint -> create_fight (normalize strings/numbers to bigint),
//   * drive     — placement (place/ready) then the turn loop for our own seat,
//   * engage    — screen live mob groups with a local fight preview and open the best sure-win one,
//   * settle    — the post-fight doors (settle_loot / close) for ended fights.
//
// The committed-turn identity (`round:turn_ptr:turn_started_ms`, held in the runtime registry) is
// the double-commit guard: after a submit there is a window before the next checkpoint arrives in
// which the stream still shows our turn.
import {
  CONTRACT_CONSTANTS,
  create_fight,
  type Fight,
  type FightContract,
  type HydratedFightCheckpoint,
} from '@aresrpg/fight'
import type {
  CharacterRow,
  FightResolutionRow,
  FightStateRow,
  ServerPacket,
} from '@aresrpg/protocol'

import { catalog_spell_sources } from '../content/fight_sources.ts'
import { log_info, log_warn, log_debug } from '../shared/logger.ts'
import { active_fight_of, chain_now, is_version_assert_error, select_character, select_window_mob_groups } from '../state/selectors.ts'
import type { GameState } from '../state/store.ts'
import { custody_of, type ActionContext } from './context.ts'
import { describe_score, screen_groups, viable_ranking, type GroupCandidate } from './fight_preview.ts'
import type { FightRuntimeStore } from './fight_registry.ts'
import type { Mover } from './travel.ts'
import { describe_actions, plan_turn, plan_turn_party, type TurnAction } from './turn_plan.ts'

/** Submit end-turn only once the chain clock has passed the turn floor, with a small margin. */
const TURN_GUARD_MS = 500

const message_of = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ── hydration ────────────────────────────────────────────────────────

/** The wire checkpoint as create_fight's hydration input. `contract` is the indexer's machine
 *  document (unknown to @aresrpg/protocol — @aresrpg/fight's normalize_checkpoint decodes it);
 *  spell templates never ride the wire, they come from the local seed. */
const wire_checkpoint = (row: FightStateRow): HydratedFightCheckpoint =>
  ({
    contract: row.contract,
    sources: { players: row.players, spells: catalog_spell_sources() },
  }) as unknown as HydratedFightCheckpoint

/** Build (or rebuild) a normalized runtime from the latest streamed checkpoint for a fight. */
export const hydrate_fight = (state: GameState, fight_id: string): Fight | null => {
  const row = state.fight_states[fight_id]
  if (!row || row.contract == null) return null
  try {
    return create_fight({ state: wire_checkpoint(row), mode: 'remote' })
  } catch (error) {
    log_warn('combat', `could not hydrate fight ${fight_id}: ${message_of(error)}`)
    return null
  }
}

/** Fold the fight stream into the runtime registry. Called from the packet door AFTER the store
 *  reduce, so `state` already holds this packet. Only checkpoints replace a runtime: turn seeds
 *  are not replayed (the next checkpoint carries the resolved state). */
export const handle_fight_packet = (
  state: GameState,
  runtimes: FightRuntimeStore,
  packet: ServerPacket
): void => {
  if (packet.type === 'packet/fight_state') {
    const runtime = hydrate_fight(state, packet.fight)
    if (runtime) runtimes.set(packet.fight, runtime)
    return
  }
  if (packet.type === 'packet/fight_ended')
    log_info('combat', `fight ${packet.fight} ended${packet.winner === null ? '' : ` (winner: team ${packet.winner})`}`)
  else if (packet.type === 'packet/fight_started') log_info('combat', `fight ${packet.fight} started`)
}

// ── selection ────────────────────────────────────────────────────────

/** The seat our character occupies in a contract, or null when it is only watching. */
const seat_of = (contract: FightContract, character_id: string): number | null => {
  const seat = contract.fighters.findIndex(
    (fighter) => fighter.kind.type === 'player' && fighter.kind.character === character_id
  )
  return seat < 0 ? null : seat
}

/** One live group's cross-character claim identity (zone + on-chain group bit). */
/** The cross-character claim name for one mob group — the single on-chain bit a party must not
 *  contest. Exported so the group coordinator releases the leader's claim on a rendezvous timeout. */
export const claim_key = (candidate: GroupCandidate): string =>
  `${candidate.zone.world}:${candidate.zone.zx}:${candidate.zone.zz}:${candidate.group.index}`

// ── driving one turn ─────────────────────────────────────────────────

export type FightDriveOutcome = Readonly<{
  kind:
    | 'idle'
    | 'no_runtime'
    | 'not_seated'
    | 'not_our_turn'
    | 'waiting_turn'
    | 'placed'
    | 'readied'
    | 'committed'
    | 'ended'
  detail?: string
}>

/** A free start cell for an unplaced fighter, or null when it already stands on one. Concurrent
 *  party placements must not collide, so a seat-derived preferred cell is tried first. */
const place_cell = (contract: FightContract, seat: number): bigint | null => {
  const fighter = contract.fighters[seat]
  if (!fighter) return null
  const starts = fighter.team === 0n ? contract.board.start_cells_a : contract.board.start_cells_b
  if (starts.includes(fighter.cell)) return null
  const occupied = new Set(contract.fighters.filter((row) => !row.dead).map((row) => row.cell))
  const preferred = starts.length === 0 ? undefined : starts[seat % starts.length]
  if (preferred !== undefined && !occupied.has(preferred)) return preferred
  return starts.find((cell) => !occupied.has(cell)) ?? null
}

const drive_placement = async (
  ctx: ActionContext,
  contract: FightContract,
  seat: number
): Promise<FightDriveOutcome> => {
  const fighter = contract.fighters[seat]
  if (!fighter) return { kind: 'not_seated' }
  if (fighter.ready) return { kind: 'waiting_turn', detail: 'ready, awaiting start' }

  const cell = place_cell(contract, seat)
  if (cell !== null) {
    // The checkpoint trails an accepted place; re-sending it aborts on chain. Once the place is
    // accepted, hold until the checkpoint reflects it (the streamed cell becoming a start cell
    // clears `place_cell`, and `fighter.ready` ends placement).
    if (ctx.fight_runtimes.placement_sent(contract.id, seat, 'place'))
      return { kind: 'waiting_turn', detail: 'placed; awaiting the checkpoint' }
    let placed
    try {
      placed = await ctx.sdk.fight.place({ fight: contract.id, fighter_idx: BigInt(seat), cell })
    } catch (error) {
      if (is_version_assert_error(error)) {
        log_warn('combat', `place seat ${seat} in ${contract.id} — object versions stale or game paused`)
        return { kind: 'waiting_turn', detail: 'versions stale' }
      }
      throw error
    }
    ctx.fight_runtimes.mark_placement_sent(contract.id, seat, 'place')
    ctx.ledger.append({ kind: 'fight_place', digest: placed.digest, detail: { fight: contract.id, seat } })
    log_info('combat', `placed seat ${seat} at ${cell} in ${contract.id}`)
    return { kind: 'placed', detail: String(cell) }
  }

  // Same guard for `ready`: the observed `combat::ready` abort 1706 was a seat re-readying a beat
  // after its accepted ready, before the checkpoint showed `fighter.ready`.
  if (ctx.fight_runtimes.placement_sent(contract.id, seat, 'ready'))
    return { kind: 'waiting_turn', detail: 'readied; awaiting the checkpoint' }
  let readied
  try {
    readied = await ctx.sdk.fight.ready({ fight: contract.id, fighter_idx: BigInt(seat) })
  } catch (error) {
    if (is_version_assert_error(error)) {
      log_warn('combat', `ready seat ${seat} in ${contract.id} — object versions stale or game paused`)
      return { kind: 'waiting_turn', detail: 'versions stale' }
    }
    throw error
  }
  ctx.fight_runtimes.mark_placement_sent(contract.id, seat, 'ready')
  ctx.ledger.append({
    kind: 'fight_ready',
    digest: readied.digest,
    detail: { fight: contract.id, seat, started: readied.started ?? false },
  })
  log_info('combat', `readied seat ${seat} in ${contract.id}${readied.started ? ' — fight started' : ''}`)
  return { kind: 'readied', detail: contract.id }
}

const drive_turn = async (
  ctx: ActionContext,
  actions: readonly TurnAction[],
  cp: HydratedFightCheckpoint,
  seat: number,
  fight_id: string
): Promise<FightDriveOutcome> => {
  const contract = cp.contract
  const identity = `${contract.round}:${contract.turn_ptr}:${contract.turn_started_ms}`
  if (ctx.fight_runtimes.committed_turn(contract.id) === identity)
    return { kind: 'waiting_turn', detail: 'already committed this turn' }

  const observed = chain_now(ctx.state().chain_clock, Date.now())
  if (observed === null) return { kind: 'waiting_turn', detail: 'chain clock unknown' }
  const floor = Number(contract.turn_started_ms) + Number(CONTRACT_CONSTANTS.turn_min_ms) + TURN_GUARD_MS
  if (observed < floor) return { kind: 'waiting_turn', detail: `turn floor in ${floor - observed}ms` }

  let receipt
  try {
    receipt = await ctx.sdk.fight.commit_turn({ fight: contract.id, actions })
  } catch (error) {
    if (is_version_assert_error(error)) {
      log_warn('combat', `commit turn ${identity} — object versions stale or game paused`)
      return { kind: 'waiting_turn', detail: 'versions stale' }
    }
    throw error
  }
  ctx.fight_runtimes.mark_committed(contract.id, identity)
  const summary = describe_actions(actions) || 'pass'
  ctx.ledger.append({
    kind: 'fight_turn',
    digest: receipt.digest,
    detail: { fight: contract.id, seat, actions: summary },
  })
  log_info('combat', `committed turn ${identity}: ${summary}`)
  return { kind: 'committed', detail: summary }
}

/** Drive whatever our character's active fight needs right now: a placement action, a committed
 *  turn when it is ours, or nothing while a mob turn resolves server-side. */
export const drive_fight = async (ctx: ActionContext): Promise<FightDriveOutcome> => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return { kind: 'idle', detail: 'character not in roster yet' }
  const fight_id = active_fight_of(character)
  if (!fight_id) return { kind: 'idle', detail: 'not in a fight' }

  const runtime = ctx.fight_runtimes.get(fight_id) ?? hydrate_fight(state, fight_id)
  if (!runtime) return { kind: 'no_runtime', detail: fight_id }
  ctx.fight_runtimes.set(fight_id, runtime)

  const cp = runtime.state()
  if (cp.contract.ended) return { kind: 'ended', detail: fight_id }

  const seat = seat_of(cp.contract, ctx.character_id)
  if (seat === null) return { kind: 'not_seated', detail: fight_id }

  if (cp.contract.round === 0n) return await drive_placement(ctx, cp.contract, seat)
  
  const actor = cp.contract.queue[Number(cp.contract.turn_ptr)]
  if (actor !== BigInt(seat)) return { kind: 'not_our_turn', detail: `now seat ${actor}` }

  // Determine if this is a group fight: check for allied seats in the same fight.
  const party_seats: number[] = []
  for (let i = 0; i < cp.contract.fighters.length; i++) {
    const f = cp.contract.fighters[i]
    if (f && f.kind.type === 'player' && f.team === 0n && f.kind.character !== ctx.character_id) {
      party_seats.push(i)
    }
  }
  
  // Use party-aware planner when we have allies, solo planner otherwise.
  const actions = party_seats.length > 0
    ? plan_turn_party(cp, seat, party_seats)
    : plan_turn(cp, seat)
  
  if (actions.length === 0) {
    // It is our turn but the planner found nothing to do. Committing an empty turn (a pass) is the
    // ONLY way to advance: without it the turn never ends and the whole party deadlocks on a fight
    // that can never progress (observed: an 8h-old fight stuck forever on a no-op turn, freezing
    // every seated character so they never roam/gather/craft again).
    const me = cp.contract.fighters[seat]
    const enemies_alive = cp.contract.fighters.filter((f: typeof cp.contract.fighters[0]) => !f.dead && f.team !== me?.team).length
    log_debug(
      'combat',
      `seat ${seat} no legal actions — passing (round=${cp.contract.round} ptr=${cp.contract.turn_ptr} dead=${me?.dead} ap=${me?.ap} mp=${me?.mp} enemies=${enemies_alive})`
    )
    return await drive_turn(ctx, [], cp, seat, fight_id)
  }
  
  return await drive_turn(ctx, actions, cp, seat, fight_id)
}

// ── engaging a mob group ─────────────────────────────────────────────

export type EngageOutcome =
  | Readonly<{ kind: 'engaged'; fight: string; detail: string }>
  | Readonly<{ kind: 'traveling'; detail: string }>
  | Readonly<{ kind: 'skipped'; detail: string }>

/** What a screen of the live window found. `viable` is whether ANY group cleared MIN_WIN_RATE,
 *  independent of the claims — the leader uses it to tell "the window is empty/exhausted" from "the
 *  window pays by level but nothing in it is beatable", which is the signal to relocate. */
export type EngageScreen = Readonly<{ candidate: GroupCandidate | null; viable: boolean; groups: number }>

/** Screen the live mob groups in the tracked window with a local fight preview and CLAIM the best
 *  sure-win one — highest reward per committed turn among groups the twin wins reliably. `allies`
 *  is the party that will join the fight, so the preview scores the whole side. `candidate` is null
 *  when nothing is sure-win (or every sure-win group is claimed); the caller owns releasing the claim
 *  if it never engages. */
export const pick_engage_target = (
  ctx: ActionContext,
  pose: Readonly<{ x: number; z: number }>,
  character: CharacterRow,
  allies: readonly CharacterRow[] = []
): EngageScreen => {
  const state = ctx.state()
  const groups = select_window_mob_groups(state)
  if (groups.length === 0) return Object.freeze({ candidate: null, viable: false, groups: 0 })
  const scored = screen_groups(pose, groups, character, allies)
  for (const { candidate, score } of scored)
    log_info(
      'preview',
      `group ${candidate.group.index} (${candidate.group.members.length} mobs): ${Math.round(score.win_rate * 100)}% win (${describe_score(score)}), ${score.turns.toFixed(1)} turns, ${Math.round(score.xp_per_turn)} xp/turn, ${Math.round(score.loot_per_turn * 100) / 100} loot/turn`
    )
  // Claim the best sure-win group no other party member is already walking to. A group is a single
  // on-chain bit, so two characters engaging it would race and one would abort.
  const party_size = 1 + allies.length
  // The periodic strategy brain's soft preference: among equally valuable groups, favour one
  // carrying a mob whose loot the party wants (a gear upgrade source). Undefined before the first
  // strategy pass, in which case viable_ranking's default empty set changes nothing.
  const ranked = viable_ranking(pose, scored, party_size, ctx.strategy?.()?.wanted_mobs)
  const winner = ranked.find(({ candidate }) => ctx.claims.claim(claim_key(candidate), ctx.character_id))
  return Object.freeze({
    candidate: winner ? winner.candidate : null,
    viable: ranked.length > 0,
    groups: groups.length,
  })
}

/** Open an already-claimed group on chain (travel, prove the leg, engage). Releases the claim on
 *  any failure so the screen can retry it. */
export const engage_target = async (
  ctx: ActionContext,
  mover: Mover,
  candidate: GroupCandidate
): Promise<EngageOutcome> => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return { kind: 'skipped', detail: 'character not in roster yet' }
  const { zone, group } = candidate
  const claimed = claim_key(candidate)
  try {
    await mover.travel_to(group.x, group.z)
    if (!(await mover.prove_ready(group.x, group.z)))
      return { kind: 'traveling', detail: 'the chain cannot yet prove this leg' }

    const receipt = await ctx.sdk.fight.engage({
      character_id: ctx.character_id,
      custody: custody_of(character),
      world: ctx.world,
      zone_x: zone.zx,
      zone_z: zone.zz,
      group_index: group.index,
      mob_types: group.members.map((member) => member.mob_type),
    })
    ctx.ledger.append({
      kind: 'fight_engage',
      digest: receipt.digest,
      detail: {
        fight: receipt.fight,
        zone: `${zone.zx}:${zone.zz}`,
        group: group.index,
        mobs: group.members.map((member) => member.mob_type),
      },
    })
    log_info('combat', `engaged group ${group.index} at ${group.x},${group.z} -> fight ${receipt.fight}`)
    return { kind: 'engaged', fight: receipt.fight, detail: `${group.members.length} mob(s)` }
  } catch (error) {
    if (is_version_assert_error(error)) {
      log_warn('combat', `engage failed (group ${group.index}) — object versions stale or game paused`)
      ctx.claims.release(claimed, ctx.character_id)
      return { kind: 'skipped', detail: 'versions stale' }
    }
    // A refused engage (stale group, custody race, gas) must never crash the character loop: drop
    // the claim so the party can retry the group, and let the next pass re-screen fresh state.
    ctx.claims.release(claimed, ctx.character_id)
    log_warn('combat', `engage failed (group ${group.index}): ${message_of(error)}`)
    return { kind: 'skipped', detail: message_of(error) }
  }
}

/** Screen and open the best sure-win group for ONE character (the solo path). */
export const engage_once = async (ctx: ActionContext, mover: Mover): Promise<EngageOutcome> => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return { kind: 'skipped', detail: 'character not in roster yet' }
  if (character.world !== ctx.world) return { kind: 'skipped', detail: `character is in ${character.world ?? 'no world'}` }
  if (character.ambush) return { kind: 'skipped', detail: 'a protector verdict is pending' }
  if (active_fight_of(character)) return { kind: 'skipped', detail: 'already in a fight' }
  // Custody flips to `fight` the instant the engage lands on chain, but the roster row (and its
  // `active_fight`) trails behind the indexer. Re-engaging in that window adds a second fight to a
  // seated character and aborts on chain (`dynamic_field::add`, field already exists) — so hold off
  // until custody returns to the kiosk.
  if (character.custody === 'fight') return { kind: 'skipped', detail: 'custody still locked to a fight' }
  const target = pick_engage_target(ctx, mover.pose(), character)
  if (!target.candidate) return { kind: 'skipped', detail: 'no sure-win group available' }
  return engage_target(ctx, mover, target.candidate)
}

// ── post-fight settlement ────────────────────────────────────────────

const close_fight = async (ctx: ActionContext, fight: string): Promise<void> => {
  try {
    const receipt = await ctx.sdk.fight.close({ fight })
    ctx.ledger.append({ kind: 'fight_close', digest: receipt.digest, detail: { fight } })
    log_info('combat', `closed fight ${fight}`)
  } catch (error) {
    if (is_version_assert_error(error)) {
      log_warn('combat', `close ${fight} failed — object versions stale or game paused`)
      return
    }
    log_warn('combat', `close ${fight} failed: ${message_of(error)}`)
  }
}

/** The report for a settled fight: did our side win, and what our seats ACTUALLY looted.
 *  `drops` is the sealed-entropy roll the chain credited; `loot_types` is only the set of every
 *  type the defeated mobs COULD drop, so reading it would report potential instead of real loot. */
export type ResolutionReport = Readonly<{
  outcome: 'won' | 'lost' | 'draw'
  loot: readonly Readonly<{ item_type: string; qty: number }>[]
}>

export const resolution_report = (rows: readonly FightResolutionRow[]): ResolutionReport => {
  const counts = new Map<string, number>()
  for (const row of rows)
    for (const { item_type, qty } of row.drops) counts.set(item_type, (counts.get(item_type) ?? 0) + qty)
  const first = rows[0]
  const outcome: ResolutionReport['outcome'] =
    !first || first.winner === null ? 'draw' : first.winner === first.team ? 'won' : 'lost'
  return Object.freeze({
    outcome,
    loot: Object.freeze([...counts.entries()].map(([item_type, qty]) => Object.freeze({ item_type, qty }))),
  })
}

const settle_one = async (
  ctx: ActionContext,
  character: CharacterRow,
  fight: string,
  rows: readonly FightResolutionRow[]
): Promise<ResolutionReport | null> => {
  const state = ctx.state()
  const settlements = rows.map((row) => ({
    fighter_idx: BigInt(row.fighter),
    loot: row.loot_types.map((item_type) => ({
      item_type,
      existing: state.inventory.find((item) => item.item_type === item_type)?.id ?? null,
    })),
  }))
  // This batch covers every seat of the fight still owing settlement, so it is the final one.
  const last = !state.resolutions.some(
    (row) => row.fight === fight && !row.settled && !rows.some((r) => r.fighter === row.fighter)
  )
  const boss_rewards = rows.some((row) => row.boss_weight > 0)
  // A dungeon room settles through the dungeon door (its settle advances or ends the run); an
  // ordinary fight through the fight door. Both share the seat/loot/`last`/`boss_rewards` shape.
  const dungeon = rows.find((row) => row.dungeon !== null)?.dungeon ?? null
  try {
    const receipt = dungeon
      ? await ctx.sdk.dungeon.settle({
          fight,
          dungeon,
          settlements,
          custody: custody_of(character),
          last,
          boss_rewards,
        })
      : await ctx.sdk.fight.settle({
          fight,
          settlements,
          custody: custody_of(character),
          last,
          boss_rewards,
        })
    ctx.ledger.append({
      kind: 'fight_settle',
      digest: receipt.digest,
      detail: { fight, seats: rows.map((row) => row.fighter), kares: receipt.kares_rewards?.length ?? 0, last },
    })
    log_info('combat', `settled fight ${fight} (${rows.length} seat(s)${last ? ', final' : ''})`)
    const report = resolution_report(rows)
    ctx.fight_runtimes.mark_settlement_done(fight)
    if (receipt.closable && !receipt.closed) await close_fight(ctx, fight)
    ctx.fight_runtimes.drop(fight)
    return report
  } catch (error) {
    if (is_version_assert_error(error)) {
      log_warn('combat', `settle ${fight} failed — object versions stale or game paused`)
      return null
    }
    log_warn('combat', `settle ${fight} failed: ${message_of(error)}`)
    return null
  }
}

/** Settle every ended fight that a party seat owes. Rows are gathered FIGHT-WIDE: one transaction
 *  settles every seat of a fight this character is part of, so a four-seat group fight closes in
 *  one shot instead of letting each seat race the final-settlement reclaim (all seats share one
 *  kiosk, so one character can settle the whole party). */
export const settle_pending = async (
  ctx: ActionContext
): Promise<{ settled: boolean; pending: boolean; detail: string; reports: readonly ResolutionReport[] }> => {
  const state = ctx.state()
  const our_fights = new Set(
    state.resolutions.filter((row) => row.character === ctx.character_id).map((row) => row.fight)
  )
  if (our_fights.size === 0) return { settled: false, pending: false, detail: 'nothing to settle', reports: [] }
  const mine = state.resolutions.filter(
    (row) => our_fights.has(row.fight) && !row.settled && !ctx.fight_runtimes.settlement_done(row.fight)
  )
  if (mine.length === 0) return { settled: false, pending: false, detail: 'nothing to settle', reports: [] }

  const character = select_character(state, ctx.character_id)
  if (!character) return { settled: false, pending: false, detail: 'character not in roster yet', reports: [] }

  const by_fight = new Map<string, FightResolutionRow[]>()
  for (const row of mine) {
    const bucket = by_fight.get(row.fight)
    if (bucket) bucket.push(row)
    else by_fight.set(row.fight, [row])
  }

  const settled: string[] = []
  const reports: ResolutionReport[] = []
  for (const [fight, rows] of by_fight) {
    const report = await ctx.fight_runtimes.with_lock(fight, async () => {
      // Another allied seat may have settled the same shared fight while we queued: doing it again
      // would abort on chain, so treat an already-done settlement as our own.
      if (ctx.fight_runtimes.settlement_done(fight)) return null
      return settle_one(ctx, character, fight, rows)
    })
    if (report) {
      settled.push(fight)
      reports.push(report)
    } else if (ctx.fight_runtimes.settlement_done(fight)) {
      settled.push(fight)
    }
  }
  if (settled.length === by_fight.size)
    return { settled: true, pending: false, detail: `settled ${settled.join(', ')}`, reports }
  return {
    settled: settled.length > 0,
    pending: true,
    detail: `settled ${settled.length}/${by_fight.size} fight(s)`,
    reports,
  }
}

/** Close every fight the chain reports as reclaimable. */
export const close_pending = async (ctx: ActionContext): Promise<{ closed: boolean; detail: string }> => {
  const { closable } = ctx.state()
  if (closable.length === 0) return { closed: false, detail: 'nothing to close' }
  for (const row of closable) await close_fight(ctx, row.fight)
  return { closed: true, detail: `closed ${closable.length}` }
}
