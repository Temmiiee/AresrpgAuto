// Presence + travel. There is no "walk" transaction: the character's chain checkpoint only moves
// when an action door (search_zone / gather / engage / join_world) proves a legal leg on chain.
// This module owns the client half of that law:
//
//   * `packet/position` is streamed as the bot walks, so the server's presence mesh and tracked
//     zone spiral follow the character (otherwise the world stream never reaches the farm spot);
//   * the stream never exceeds the AUTHORED speed law (11.5 blocks/s, ×1.5 while mounted, protocol
//     SPEED_BUDGET) by wall clock, so the server's own speed gate never trips;
//   * before an action door runs at a distance, `prove_ready` waits until `world_map::travel_ok`
//     (protocol travel_proof_ready) can prove the leg against the CHAIN clock.
//
// The two paces are deliberately fused: chain time drives the proof, wall time drives the bucket,
// and the effective clock is the MINIMUM of the two so a skewed chain sample can never let the bot
// outrun the server's wall-clock bucket.
import {
  PET_SPEED_MULTIPLIER,
  SPEED_BUDGET_BLOCKS_PER_SECOND,
  position_checkpoint,
  travel_proof_ready,
  zone_of,
  type ChainAnchor,
  type CharacterRow,
} from '@aresrpg/protocol'

import { chain_now, checkpoint_of } from '../state/selectors.ts'
import { log_info, log_warn, sleep } from '../shared/logger.ts'
import { custody_of, type ActionContext } from './context.ts'

/** One block takes at least this long at the legal speed, with a hair of margin. Mounted, the
 *  server's token bucket ceiling is SPEED_BUDGET × PET_SPEED_MULTIPLIER (player_world.ts); the
 *  chain proof still gates the both-end pet rule, so pacing at the mounted rate is always safe. */
const step_min_ms = (mounted: boolean): number =>
  Math.ceil(1000 / (SPEED_BUDGET_BLOCKS_PER_SECOND * (mounted ? PET_SPEED_MULTIPLIER : 1))) + 5
const POLL_MS = 40
const MAX_LEG_STEPS = 20_000
/** How often a travel leg that cannot take a single step dumps WHY, so a character stranded by a
 *  null/poisoned anchor or a pet-rule mismatch is diagnosable instead of silently spinning to the
 *  deadline. */
const STALL_DIAG_MS = 30_000
let last_stall_diag_ms = 0
/** A checkpoint timestamp this far ahead of the live chain clock cannot be real. The server's very
 *  first roster push can carry such a sentinel (observed: at_ms ~4.9e12 against a ~1.79e12 chain
 *  clock); adopting it makes `travel_proof_ready` fail its `now_ms < from_ms` test on EVERY leg, so
 *  the character can never travel, gather, engage or enter a dungeon again. */
const ANCHOR_FUTURE_SLACK_MS = 30_000

export type Pose = Readonly<{ x: number; y: number; z: number }>

export type Mover = Readonly<{
  /** the chain checkpoint that authorizes the current presence, or null when unjoined */
  anchor: () => Readonly<ChainAnchor & { world: string; pet: boolean }> | null
  pose: () => Pose
  /** re-read the character row; a fresh checkpoint snaps the reported pose onto it */
  sync: (character: CharacterRow) => void
  /** true once the chain clock can already prove the leg from the anchor to the target */
  can_reach: (to_x: number, to_z: number) => boolean
  /** stream presence toward a target at the legal speed, then stop (does NOT prove the leg) */
  travel_to: (to_x: number, to_z: number) => Promise<void>
  /** wait until the chain can prove travel from the anchor to the target (with a timeout) */
  prove_ready: (to_x: number, to_z: number, timeout_ms?: number) => Promise<boolean>
  /** discover or refresh the zone at the character's chain-proven pose */
  ensure_zone: (refresh: boolean) => Promise<void>
}>

const step_toward = (from: Pose, to_x: number, to_z: number): Pose => {
  const dx = to_x - from.x
  const dz = to_z - from.z
  if (Math.abs(dx) >= Math.abs(dz)) return Object.freeze({ x: from.x + Math.sign(dx), y: from.y, z: from.z })
  return Object.freeze({ x: from.x, y: from.y, z: from.z + Math.sign(dz) })
}

const anchor_pose = (anchor: Readonly<{ x: number; z: number }>): Pose => Object.freeze({ x: anchor.x, y: 0, z: anchor.z })

export const create_mover = (ctx: ActionContext): Mover => {
  let anchor: Readonly<ChainAnchor & { world: string; pet: boolean }> | null = null
  let pose: Pose = Object.freeze({ x: 0, y: 0, z: 0 })
  /** local wall instant the anchor was first observed (extrapolates chain time honestly) */
  let anchor_local_ms = 0
  let last_report_ms = 0
  let pet_now = false

  const effective_now = (): number => {
    if (!anchor) return 0
    const chain = chain_now(ctx.state().chain_clock, Date.now())
    const wall = anchor.at_ms + (Date.now() - anchor_local_ms)
    return chain === null ? wall : Math.min(chain, wall)
  }

  const report = (): void => {
    if (!anchor) return
    ctx.send(
      Object.freeze({
        type: 'packet/position',
        character_id: ctx.character_id,
        checkpoint: position_checkpoint(anchor.world, anchor),
        x: pose.x,
        y: pose.y,
        z: pose.z,
        riding: pet_now,
      })
    )
    last_report_ms = Date.now()
  }

  const sync = (character: CharacterRow): void => {
    const checkpoint = checkpoint_of(character)
    if (!checkpoint || !character.world) return
    pet_now = character.pet === true
    const next = Object.freeze({
      world: character.world,
      x: character.x!,
      z: character.z!,
      at_ms: character.at_ms ?? 0,
      pet: pet_now,
    })
    // "Newer wins" is the normal rule, but it deadlocks against a poisoned anchor: a sentinel
    // at_ms in the future is ordered ABOVE every real checkpoint, so the guard would refuse them
    // all forever. Also adopt a row that is strictly LESS in the future than the current anchor —
    // a one-pass self-heal — while never adopting a worse future value.
    const chain = chain_now(ctx.state().chain_clock, Date.now())
    const ahead_of_chain = (at_ms: number): boolean => chain !== null && at_ms > chain + ANCHOR_FUTURE_SLACK_MS
    const moved =
      anchor === null || anchor.world !== next.world || anchor.x !== next.x || anchor.z !== next.z
    const newer = anchor !== null && anchor.at_ms < next.at_ms && !ahead_of_chain(next.at_ms)
    const healed = anchor !== null && ahead_of_chain(anchor.at_ms) && next.at_ms < anchor.at_ms
    if (!(moved || newer || healed)) return
    anchor = next
    anchor_local_ms = Date.now()
    pose = anchor_pose(next)
  }

  const can_reach = (to_x: number, to_z: number): boolean => {
    if (!anchor) return false
    return travel_proof_ready({
      from_x: anchor.x,
      from_z: anchor.z,
      from_ms: anchor.at_ms,
      pet_at_start: anchor.pet,
      to_x,
      to_z,
      now_ms: effective_now(),
      pet_now,
    })
  }

  const travel_to = async (to_x: number, to_z: number): Promise<void> => {
    // The step gate (below) only lets one block through per `step_min_ms`, and every ungated poll
    // sleeps `POLL_MS`. Counting LOOPS would therefore abort a legitimate leg after roughly half
    // its steps — the cap must count BLOCKS actually walked. A too-long single leg still throws
    // (the caller treats it as a pause and resumes from the streamed pose next pass), but a wall
    // deadline also bounds a chain clock that never lets a step through.
    const total = Math.abs(to_x - pose.x) + Math.abs(to_z - pose.z)
    const deadline = Date.now() + step_min_ms(false) * Math.min(total, MAX_LEG_STEPS) * 4 + 30_000
    let steps = 0
    // Wall instant of the last block actually streamed. The gate below is shut on most polls (a step
    // is allowed once per `step_min_ms`), so a stuck-ness warning must key off "no block moved", not
    // "this poll was gated" — otherwise a healthy walk spams a false "no step".
    let last_step_ms = Date.now()
    while (pose.x !== to_x || pose.z !== to_z) {
      if (steps >= MAX_LEG_STEPS) throw new Error(`travel_to exceeded ${MAX_LEG_STEPS} steps`)
      if (Date.now() > deadline) throw new Error(`travel_to stalled after ${steps} of ${total} steps`)
      const next = step_toward(pose, to_x, to_z)
      const mounted = anchor !== null && anchor.pet && pet_now
      const wall_ok = Date.now() - last_report_ms >= step_min_ms(mounted)
      if (!anchor || !wall_ok || !can_reach(next.x, next.z)) {
        const now = Date.now()
        if (now - last_step_ms > STALL_DIAG_MS && now - last_stall_diag_ms > STALL_DIAG_MS) {
          last_stall_diag_ms = now
          const who = ctx.state().characters.find((c) => c.id === ctx.character_id)?.name ?? ctx.character_id.slice(0, 8)
          log_warn(
            'travel',
            `${who}: stalled ${Math.round((now - last_step_ms) / 1000)}s at ${pose.x},${pose.z} -> ${to_x},${to_z} — anchor=${anchor ? `${anchor.x},${anchor.z}@${anchor.at_ms} pet=${anchor.pet}` : 'null'} pet_now=${pet_now} wall_ok=${wall_ok} reach_next=${can_reach(next.x, next.z)} eff=${effective_now()} chain=${chain_now(ctx.state().chain_clock, now)}`
          )
        }
        await sleep(POLL_MS)
        continue
      }
      pose = next
      steps += 1
      last_step_ms = Date.now()
      report()
    }
  }

  const prove_ready = async (to_x: number, to_z: number, timeout_ms = 30_000): Promise<boolean> => {
    const deadline = Date.now() + timeout_ms
    while (Date.now() < deadline) {
      if (can_reach(to_x, to_z)) return true
      await sleep(POLL_MS)
    }
    return can_reach(to_x, to_z)
  }

  const ensure_zone = async (refresh: boolean): Promise<void> => {
    const character = ctx.state().characters.find(({ id }) => id === ctx.character_id)
    if (!character) return
    const { zx, zz } = zone_of(pose.x, pose.z)
    await ctx.sdk.character.search_zone({
      character_id: ctx.character_id,
      world: character.world ?? ctx.world,
      x: pose.x,
      z: pose.z,
      refresh,
      custody: custody_of(character),
    })
    log_info('travel', `zone ${character.world ?? ctx.world}:${zx}:${zz} searched at ${pose.x},${pose.z}`)
  }

  return Object.freeze({
    anchor: () => anchor,
    pose: () => pose,
    sync,
    can_reach,
    travel_to,
    prove_ready,
    ensure_zone,
  })
}
