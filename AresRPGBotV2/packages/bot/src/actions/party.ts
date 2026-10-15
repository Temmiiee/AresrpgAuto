// The party coordinator: the shared state that lets up to four characters fight as ONE group.
//
// The chain opens a PvM fight when the leader engages, and it only admits allies while the fight is
// in placement (round 0). Placement start is stamped at engage and the fight force-starts
// PLACEMENT_FORCE_MS (60_000) later (move-combat::combat), so the whole party must be seated within
// that window. Two consequences drive this module:
//
//   1. the leader must NOT engage until every other member can legally prove the travel leg to the
//      group (the chain's `admit` replays each joiner's proof from its own last checkpoint), and
//   2. the leader joins those allies in the SAME beat as the engage — before any seat readies.
//
// The four parallel character loops rendezvous on the one mutable `PartyState` object below: the
// leader plans a target and waits for followers to report reachability, followers travel and report,
// then every seat is driven by the ordinary active-fight path.
import type { CharacterRow } from '@aresrpg/protocol'

import { config } from '../config.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { active_fight_of, select_character } from '../state/selectors.ts'
import type { GameState } from '../state/store.ts'
import { claim_key, engage_target, pick_engage_target } from './combat.ts'
import { custody_of, type ActionContext } from './context.ts'
import type { GroupCandidate } from './fight_preview.ts'
import type { Mover } from './travel.ts'

/** How long a rendezvous may run before the party gives up and falls back to solo play. Long enough
 *  for a follower to hop its chain checkpoint (search_zone) across several zones at the speed law.
 *  Increased to 15 minutes to accommodate follower travel after leader roams. */
const STAGE_TIMEOUT_MS = 900_000
/** How long a rendezvous waits for a still-un-staged follower before writing it off as a straggler
 *  and re-planning for the members that DID arrive. A follower that has simply not caught up (a
 *  world-join drops it at the map centre, ~14k blocks and ~20 min out) would otherwise hold the
 *  whole party idle for the full stage timeout, so no fight ever starts. */
const STAGE_GRACE_MS = 90_000
/** How long an active group fight may be invisible to the roster/indexer before we conclude it ended. */
const ACTIVE_GRACE_MS = 60_000
/** How far (in blocks) a gatherer may range from a pack and still call its specialty "available". */
export const PARTY_GATHER_RADIUS = 1_024
/** How far (blocks) the leader may stray from the party's centre of mass before it must walk back
 *  and rejoin — and the most a single group relocation may step. Any activity that hands the leader
 *  a far target (the recipe-driven chore's demanded node, a dungeon city, an excursion zone, a roam
 *  band) otherwise walks it across the map in ONE silent `travel_to` leg — a healthy multi-minute
 *  walk logs nothing — while the followers are left behind and written off as stragglers. Bigger
 *  than a zone (512), far smaller than the roam band (≤20_000), so a rendezvous stays a short hop. */
export const PARTY_RADIUS = 2_000
/** Consecutive failed rendezvous before the party stops grouping for a while. */
const MAX_STAGE_FAILURES = 5
/** How long to stay in solo mode after repeated rendezvous failures. Reduced to 60s so the party
 *  quickly retries grouping instead of staying solo for 5 minutes. */
const GROUP_COOLDOWN_MS = 60_000
/** How close a follower parks to the leader between fights before it stops drifting (blocks). */
const RALLY_STANDOFF = 256
/** How often a stalled rendezvous dumps its per-member reachability, so a stuck wait is diagnosable
 *  instead of a silent 15-minute park. */
const STAGE_DIAG_MS = 30_000
let last_stage_diag_ms = 0
const stage_diag_due = (now: number): boolean => {
  if (now - last_stage_diag_ms < STAGE_DIAG_MS) return false
  last_stage_diag_ms = now
  return true
}
const follower_diag_ms = new Map<string, number>()
const follower_diag_due = (id: string, now: number): boolean => {
  if (now - (follower_diag_ms.get(id) ?? 0) < STAGE_DIAG_MS) return false
  follower_diag_ms.set(id, now)
  return true
}

export type PartyPhase = 'idle' | 'staging' | 'active'

export type PartyTarget = Readonly<{
  /** the world the leader is in; followers must re-home here to join */
  world: string
  candidate: GroupCandidate
  claim_key: string
  /** the group's world-local position every member must be able to reach */
  x: number
  z: number
}>

export type PartyState = {
  /** the character id the party fights behind (its group opens the fight) */
  leader_id: string | null
  /** every character id in the party, leader included */
  members: readonly string[]
  phase: PartyPhase
  /** the in-flight group fight id while `phase === 'active'` */
  fight: string | null
  target: PartyTarget | null
  /** member ids that have proven they can reach the current target */
  staged: Set<string>
  /** when the current rendezvous began (ms since epoch) */
  staged_at_ms: number
  /** when the active group fight was opened (ms since epoch); covers roster/indexer lag */
  active_since_ms: number
  /** consecutive rendezvous failures, feeding the cooldown below */
  failures: number
  /** while now < retry_after_ms the party plays solo instead of trying to rendezvous */
  retry_after_ms: number

  // excursion (gathering relocation)
  /** the currently active whole-party gathering excursion, or null */
  excursion: Readonly<{
    world: string
    zx: number
    zz: number
    x: number
    z: number
    biome: string
    kind: 'biome' | 'city'
    member_ids: readonly string[]
    started_ms: number
    arrived_ms: number
  }> | null
  /** when the last excursion finished (starts the cooldown) */
  last_excursion_ms: number
  /** per-member id → when the gather gap was first seen (persistence gate) */
  need_since: Map<string, number>
  /** cross-world need key → last log time (rate limit the deferred warning) */
  deferred_log_ms: Map<string, number>
  /** member id → latest streamed pose (x,z) for reach checks */
  poses: Map<string, { x: number; z: number }>
  /** member ids temporarily OUT of the group (cross-world gathering). The rendezvous and the role
   *  assignment ignore them, so a detacher never strands the leader's `all_staged` check. */
  detached: Set<string>
  /** member ids that could not reach the last rendezvous in time (e.g. a world-join spawns a
   *  character at the map centre ~14k blocks out). Treated like `detached` — excluded from the
   *  side's preview and its `all_staged` test — until the member stages again, so one straggler
   *  cannot freeze the whole party for the full stage timeout. */
  stragglers: Set<string>
}

export const create_party = (): PartyState => ({
  leader_id: null,
  members: [],
  phase: 'idle',
  fight: null,
  target: null,
  staged: new Set(),
  staged_at_ms: 0,
  active_since_ms: 0,
  failures: 0,
  retry_after_ms: 0,
  excursion: null,
  last_excursion_ms: 0,
  need_since: new Map(),
  deferred_log_ms: new Map(),
  poses: new Map(),
  detached: new Set(),
  stragglers: new Set(),
})

/** Clear the current rendezvous/fight. The excursion state (poses, need_since, etc.) is managed
 *  separately and persists across fight resets. Exported so the loop can abandon an in-flight
 *  rendezvous when the leader becomes unavailable (a dungeon run roots it at the portal). */
export const reset_rendezvous = (party: PartyState): void => {
  party.phase = 'idle'
  party.fight = null
  party.target = null
  party.staged = new Set()
  party.staged_at_ms = 0
  party.active_since_ms = 0
  // excursion is cleared by finish_excursion when the relocation is done
  // stragglers persist: a member written off as unreachable stays out of the remains of the
  // rendezvous cycle until it actually stages again (mark_staged), so it is not re-tested every pass.
}

/** Record that a member has proven the current target's leg. Also clears any straggler write-off, so
 *  a member that has finally caught up rejoins the side on the next rendezvous. */
const mark_staged = (party: PartyState, id: string): void => {
  party.staged.add(id)
  party.stragglers.delete(id)
}

/** True while the active fight has not been visible long enough to conclude it is over. */
const active_still_fresh = (party: PartyState): boolean =>
  party.active_since_ms > 0 && Date.now() - party.active_since_ms < ACTIVE_GRACE_MS

/** True while the party should try to fight as a group (configured, has partners, not cooling down). */
export const party_attempting = (party: PartyState): boolean =>
  party.leader_id !== null && party.members.length > 1 && Date.now() >= party.retry_after_ms

/** True while the group fight (or any of its seats) is still on chain. */
const fight_outstanding = (state: GameState, fight: string): boolean =>
  state.resolutions.some((row) => row.fight === fight && !row.settled) ||
  state.characters.some((character) => active_fight_of(character) === fight)

export const allies_of = (state: GameState, party: PartyState, leader_id: string): readonly CharacterRow[] =>
  party.members
    .filter((id) => id !== leader_id && !party.detached.has(id) && !party.stragglers.has(id))
    .flatMap((id) => {
      const row = state.characters.find((c) => c.id === id)
      return row ? [row] : []
    })

/** The party's centre of mass: the per-axis MEDIAN of the non-leader, non-detached member poses.
 *  Falls back to `leader_pose` when no follower pose is known yet (solo, or before the first stream).
 *  The median — not the mean — ignores a single outlier, so one straggler mid-trek cannot drag the
 *  centre (and the rendezvous it anchors) off the cluster the rest of the party is actually standing
 *  in. Detached members (cross-world gatherers) are left out: they are deliberately elsewhere. */
export const party_center = (
  party: PartyState,
  leader_pose: Readonly<{ x: number; z: number }>
): Readonly<{ x: number; z: number }> => {
  const xs: number[] = []
  const zs: number[] = []
  for (const id of party.members) {
    if (id === party.leader_id || party.detached.has(id)) continue
    const pose = party.poses.get(id)
    if (!pose) continue
    xs.push(pose.x)
    zs.push(pose.z)
  }
  if (xs.length === 0) return leader_pose
  const median = (values: number[]): number => {
    values.sort((left, right) => left - right)
    const mid = values.length >> 1
    return values.length % 2 === 1 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2)
  }
  return Object.freeze({ x: median(xs), z: median(zs) })
}

/** Where the leader must walk to rejoin the party, or null when it is already close enough. The
 *  target is the point exactly `PARTY_RADIUS` from the centre on the line to the leader — walking to
 *  the centre itself would cross the inbound followers and overshoot past them. `offset` is the
 *  current stray distance (for the log). Callers own the walk itself. */
export const regroup_step = (
  party: PartyState,
  pose: Readonly<{ x: number; z: number }>
): Readonly<{ x: number; z: number; offset: number }> | null => {
  const centre = party_center(party, pose)
  const dx = pose.x - centre.x
  const dz = pose.z - centre.z
  const offset = Math.hypot(dx, dz)
  if (offset <= PARTY_RADIUS) return null
  const scale = (offset - PARTY_RADIUS) / offset
  return Object.freeze({
    x: Math.round(pose.x - dx * scale),
    z: Math.round(pose.z - dz * scale),
    offset,
  })
}

/** Join every follower seat in ONE transaction on the leader's kiosk. The joins land before any
 *  seat readies, so the fight cannot start without the party. */
export const join_followers = async (ctx: ActionContext, followers: readonly string[], fight: string): Promise<number> => {
  if (followers.length === 0) return 0
  const leader = select_character(ctx.state(), ctx.character_id)
  if (!leader) return 0
  const receipt = await ctx.sdk.fight.join_many({
    fight,
    character_ids: followers,
    custody: custody_of(leader),
    team: 0,
    access: 0,
  })
  ctx.ledger.append({ kind: 'fight_join_group', digest: receipt.digest, detail: { fight, members: followers } })
  log_info('party', `joined ${followers.length} partner(s) to ${fight}`)
  return followers.length
}

/** The leader's pass: plan a rendezvous when idle, then engage + join once every follower can reach
 *  the group. Returns a sleep (this pass is handled) or null to fall through to the solo path. */
export const leader_group_step = async (
  ctx: ActionContext,
  mover: Mover,
  character: CharacterRow,
  party: PartyState
): Promise<number | null> => {
  const idle = config.idle_sleep_ms
  const state = ctx.state()

  if (party.phase === 'staging') {
    const target = party.target
    if (!target) {
      reset_rendezvous(party)
      return null
    }
    try {
      await mover.travel_to(target.x, target.z)
    } catch (error) {
      // A leg that cannot make progress must NOT skip the checks below: returning here left an
      // already-staged group parked forever (the reach test and the stage timeout both ran only on
      // the success path, so the rendezvous never engaged and never abandoned). Fall through so the
      // leader either engages the moment it can reach, or times out and re-plans.
      log_warn('party', `staging leg paused: ${error instanceof Error ? error.message : String(error)}`)
    }
    // A follower that cannot get here in time must not hold the party hostage. After the grace,
    // write off every still-un-staged follower, release the claim and re-plan for the members that
    // ARE here — `allies_of` then drops it from the preview too, so the side is scored honestly at
    // its real size. The straggler keeps walking in its own loop and rejoins the moment it stages.
    const pending = party.members.filter(
      (id) =>
        id !== party.leader_id &&
        !party.detached.has(id) &&
        !party.stragglers.has(id) &&
        !party.staged.has(id)
    )
    if (pending.length > 0 && Date.now() - party.staged_at_ms > STAGE_GRACE_MS) {
      for (const id of pending) {
        party.stragglers.add(id)
        log_warn(
          'party',
          `${state.characters.find((c) => c.id === id)?.name ?? id}: wrote off as a straggler — engaging without it`
        )
      }
      ctx.claims.release(target.claim_key, ctx.character_id)
      reset_rendezvous(party)
      return null
    }
    // Everyone in position AND the leader can prove its own leg: fight now. This is tested BEFORE the
    // timeout so a follower that arrives in the same pass the window elapses still gets its fight
    // (the followers touch `staged` from their own concurrent pass, so the two checks race).
    const followers = party.members.filter(
      (id) => id !== party.leader_id && !party.detached.has(id) && !party.stragglers.has(id)
    )
    const all_staged = followers.length === 0 || followers.every((id) => party.staged.has(id))
    if (all_staged && mover.can_reach(target.x, target.z)) {
      const outcome = await engage_target(ctx, mover, target.candidate)
      if (outcome.kind === 'engaged') {
        try {
          await join_followers(ctx, followers, outcome.fight)
        } catch (error) {
          log_warn('party', `join failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        party.fight = outcome.fight
        party.phase = 'active'
        party.target = null
        party.staged = new Set()
        party.active_since_ms = Date.now()
        party.failures = 0
        log_info('party', `engaged group ${target.candidate.group.index} -> fight ${outcome.fight}`)
        return idle
      }
      if (outcome.kind === 'traveling') return idle
      log_warn('party', `group engage failed: ${outcome.detail}`)
      party.failures += 1
      reset_rendezvous(party)
      return null
    }
    // Not everyone has arrived. Give up only once the whole window has elapsed.
    if (stage_diag_due(Date.now())) {
      const roster = party.members
        .map((id) => {
          const row = state.characters.find((c) => c.id === id)
          const flag = id === party.leader_id ? 'leader' : party.staged.has(id) ? 'staged' : party.detached.has(id) ? 'detached' : 'PENDING'
          return `${row?.name ?? id}:${flag}@${row?.world}:${row?.x},${row?.z}`
        })
        .join(' ')
      log_warn(
        'party',
        `staging wait ${Math.round((Date.now() - party.staged_at_ms) / 1000)}s: target ${target.x},${target.z} leader_reach=${mover.can_reach(target.x, target.z)} anchor=${JSON.stringify(mover.anchor())} [${roster}]`
      )
    }
    if (Date.now() - party.staged_at_ms > STAGE_TIMEOUT_MS) {
      ctx.claims.release(target.claim_key, ctx.character_id)
      party.failures += 1
      if (party.failures >= MAX_STAGE_FAILURES) {
        party.failures = 0
        party.retry_after_ms = Date.now() + GROUP_COOLDOWN_MS
        log_warn('party', `rendezvous keeps failing — playing solo for ${Math.round(GROUP_COOLDOWN_MS / 60_000)}m`)
      }
      log_warn('party', `rendezvous timed out — abandoning group ${target.candidate.group.index}`)
      reset_rendezvous(party)
      return null
    }
    return idle
  }

  if (party.phase === 'active') {
    // The active-fight step already drove our seat; wait until the whole fight is gone, then clear.
    // The roster/indexer can lag an engage by seconds, so do not conclude "gone" too early.
    if (party.fight && fight_outstanding(state, party.fight)) return idle
    if (active_still_fresh(party)) return idle
    reset_rendezvous(party)
    return null
  }

  // idle — plan the next rendezvous, unless the party is cooling down after failures
  if (!party_attempting(party)) return null
  if (character.custody === 'fight') return null
  const allies = allies_of(state, party, ctx.character_id)
  // Plan the rendezvous from the party's centre of mass, not the leader's own pose: the followers
  // gather there, so the group opens where the side already stands instead of thousands of blocks
  // behind it — which the leader would then walk to alone, stranding them. The leader is guaranteed
  // to be near that centre (the session's regroup gate above), so this stays a short hop.
  const candidate = pick_engage_target(ctx, party_center(party, mover.pose()), character, allies)
  if (!candidate) return null
  party.phase = 'staging'
  party.fight = null
  party.staged = new Set()
  party.staged_at_ms = Date.now()
  party.target = Object.freeze({
    world: candidate.zone.world,
    candidate,
    claim_key: claim_key(candidate),
    x: candidate.group.x,
    z: candidate.group.z,
  })
  log_info(
    'party',
    `staging group ${candidate.group.index} at ${candidate.group.x},${candidate.group.z} in ${candidate.zone.world} — party worlds: ${party.members
      .map((id) => state.characters.find((c) => c.id === id)?.world ?? '?')
      .join(', ')}`
  )
  return idle
}

/** A follower's pass: travel to the staged group and report reachability; wait while the party fight
 *  is active. Returns a sleep (this pass is handled) or null to fall through to the solo path. */
export const follower_group_step = async (
  ctx: ActionContext,
  mover: Mover,
  character: CharacterRow,
  party: PartyState
): Promise<number | null> => {
  const idle = config.idle_sleep_ms

  if (party.phase === 'staging') {
    const target = party.target
    if (!target) return null
    // In another world: fall through to the normal roam path so we re-home; the rendezvous retries.
    if (character.world !== target.world) return null
    if (party.staged.has(character.id)) return idle
    if (mover.can_reach(target.x, target.z)) {
      mark_staged(party, character.id)
      log_info('party', `${character.name}: staged for group ${target.candidate.group.index}`)
      return idle
    }
    // Stream presence toward the group. That moves the REPORTED pose but not the chain checkpoint,
    // and the join (`fight::admit`) proves the leg from that checkpoint — so whenever we make
    // progress, also RE-ANCHOR at the new pose (`search_zone`). The checkpoint then hops toward the
    // group instead of being stranded at wherever this character last acted.
    const before = mover.pose()
    try {
      await mover.travel_to(target.x, target.z)
      if (mover.can_reach(target.x, target.z)) {
        mark_staged(party, character.id)
        log_info('party', `${character.name}: staged for group ${target.candidate.group.index}`)
        return idle
      }
      const after = mover.pose()
      if (after.x !== before.x || after.z !== before.z) await mover.ensure_zone(false)
    } catch (error) {
      if (follower_diag_due(character.id, Date.now()))
        log_warn(
          'party',
          `${character.name}: cannot reach ${target.x},${target.z} — ${error instanceof Error ? error.message : String(error)}; anchor=${JSON.stringify(mover.anchor())} pose=${JSON.stringify(mover.pose())}`
        )
      return idle
    }
    if (mover.can_reach(target.x, target.z)) {
      mark_staged(party, character.id)
      log_info('party', `${character.name}: staged for group ${target.candidate.group.index}`)
    }
    return idle
  }

  if (party.phase === 'active') {
    // wait for the roster to surface our seat; the ordinary active-fight step drives it. Any member
    // may clear a finished fight so no seat is stranded when the leader is slow to notice — but only
    // once the fight has had a chance to appear (the roster lags the engage).
    if (party.fight && fight_outstanding(ctx.state(), party.fight)) return idle
    if (active_still_fresh(party)) return idle
    reset_rendezvous(party)
    return null
  }
  return null
}

/** A follower's idle move: drift toward the leader's checkpoint so the side stays a side between
 *  fights. A follower that roams to its own band strands the next rendezvous and pays a multi-minute
 *  re-convergence; rallying keeps the whole party within a zone or two, so the next engage is cheap.
 *  Returns true when it actually travelled. */
export const rally_to_leader = async (mover: Mover, leader: CharacterRow): Promise<boolean> => {
  if (leader.x === undefined || leader.z === undefined) return false
  const pose = mover.pose()
  if (Math.max(Math.abs(leader.x - pose.x), Math.abs(leader.z - pose.z)) <= RALLY_STANDOFF) return false
  try {
    // Only STREAM presence toward the leader here; the chain checkpoint is re-anchored by the
    // rendezvous (ensure_zone) when the leader actually opens a fight, so a rally costs no gas.
    await mover.travel_to(leader.x, leader.z)
    return true
  } catch {
    return false
  }
}
