// The roam action: keep the bot where the fights are worth their gas.
//
// A zone's difficulty is a function of its distance from the world centre (content/zone_map.ts):
// farther zones draw bigger groups and higher mob levels. The bot measures the live window
// against the chain's own XP penalties (fight_math::xp_for_player) and steps outward while the
// prey is trivial, inward while it is out of reach, and holds once a group can pay. The live
// preview still owns which group to fight — this action only decides WHERE to stand, and it runs
// BEFORE the engage so a trivial window is never farmed. It also owns zone discovery: an
// unsearched current zone has no population to judge, so searching it is this action's job.
//
// It is also the world door: the bot fights in the highest-entry world with mobs that its level
// qualifies for (today `nauvis`), joining it from the world's portal when it is elsewhere.
import { create_mob_snapshot } from '@aresrpg/fight'
import type { CharacterRow, MobGroupRow } from '@aresrpg/protocol'

import {
  MAX_ROAM_DISTANCE,
  MIN_ROAM_DISTANCE,
  WORLD_CENTER,
  distance_blocks,
  fight_world_for_level,
  target_distance,
  zone_at,
  zone_at_distance,
} from '../content/zone_map.ts'
import { type SeedWorld } from '../content/catalog.ts'
import { mob_template_of } from '../content/fight_sources.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { active_fight_of, select_character, select_window_mob_groups, select_zone } from '../state/selectors.ts'
import { zone_key } from '../state/store.ts'
import { custody_of, type ActionContext } from './context.ts'
import { nearest_candidates } from './fight_preview.ts'
import type { Mover } from './travel.ts'

/** One outward step in blocks — small enough to sample the ramp, large enough to not crawl. */
const STEP_BLOCKS = 2_500
/** A group whose every member is this far above the player is treated as out of reach. */
const OVERWHELM_MARGIN = 15
/** A failed world join is not retried more often than this (the loop keeps calling us). */
const JOIN_RETRY_MS = 600_000

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

/** `Mover.travel_to` throws once a single leg passes its step cap (a long diagonal). The blocks it
 *  already streamed persist in the mover, so the next pass resumes where this one stopped — treat
 *  the cap as a pause, not a failure. Shared with the gathering excursion, which walks the same way. */
export const safe_travel_to = async (mover: Mover, x: number, z: number): Promise<boolean> => {
  try {
    await mover.travel_to(x, z)
    return mover.pose().x === x && mover.pose().z === z
  } catch (error) {
    log_warn('roam', `leg paused: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

const distance_at = (pose: Readonly<{ x: number; z: number }>): number => {
  const { zx, zz } = zone_at(pose.x, pose.z)
  return distance_blocks(zx, zz)
}

/** What the live window says about the fight on offer, judged with the chain's own penalties:
 *  a group pays in full only while its highest member reaches `0.4 × level` (penalty 3) and its
 *  total reaches `level − 5` (penalty 2). Missing both means the prey is trivial. */
export type WindowAssessment = Readonly<{
  groups: number
  highest_level: number
  best_total_level: number
  trivial: boolean
  overwhelming: boolean
}>

const group_vitals = (group: MobGroupRow): Readonly<{ highest: number; total: number }> =>
  group.members.reduce(
    (acc, member) => {
      const template = mob_template_of(member.mob_type)
      if (!template) return acc
      const level = Number(create_mob_snapshot(template, BigInt(member.level_scalar)).level)
      return { highest: Math.max(acc.highest, level), total: acc.total + level }
    },
    { highest: 0, total: 0 }
  )

export const assess_window = (level: number, groups: readonly MobGroupRow[]): WindowAssessment => {
  const vitals = groups.map(group_vitals)
  const pays = (v: Readonly<{ highest: number; total: number }>): boolean =>
    v.highest * 5 >= level * 2 && v.total + 5 >= level
  return Object.freeze({
    groups: groups.length,
    highest_level: vitals.reduce((top, v) => Math.max(top, v.highest), 0),
    best_total_level: vitals.reduce((top, v) => Math.max(top, v.total), 0),
    trivial: groups.length > 0 && !vitals.some(pays),
    overwhelming: groups.length > 0 && vitals.every((v) => v.highest > level + OVERWHELM_MARGIN),
  })
}

export type RoamPlan =
  | Readonly<{ kind: 'stay'; reason: string }>
  | Readonly<{ kind: 'advance'; distance: number; reason: string }>

/** Where the roam wants to stand next. Pure: the caller does the walking. */
export const plan_roam = (
  level: number,
  pose: Readonly<{ x: number; z: number }>,
  world: SeedWorld,
  assessment: WindowAssessment,
  stepBlocks: number = STEP_BLOCKS,
  /** The fight preview found at least one group the party can reliably win HERE. When false the
   *  window pays by the chain's XP table but nothing in it is actually beatable, so holding is a
   *  deadlock: the whole party sits still while the preview keeps failing to certify a target. */
  viable: boolean = true
): RoamPlan => {
  const current = distance_at(pose)
  if (assessment.overwhelming) {
    const distance = clamp(current - stepBlocks, MIN_ROAM_DISTANCE, MAX_ROAM_DISTANCE)
    return distance < current
      ? Object.freeze({ kind: 'advance', distance, reason: 'prey out of reach' })
      : Object.freeze({ kind: 'stay', reason: 'already at the inner ring' })
  }
  if (assessment.groups === 0 || assessment.trivial) {
    // Creep toward the dial's band by at most one step instead of jumping straight to it. A world
    // join drops a character at the map centre ~20_000 blocks in, and the old `Math.max` teleported
    // the leader to the band in ONE silent `travel_to` leg while the party it leads was left at the
    // old spot. Stepping out one bounded hop at a time lets the followers keep up and re-reads the
    // window the party is passing through. Past the band there is nothing stronger to walk to, so
    // hold (the inward case is the `overwhelming` branch above).
    const band = target_distance(level, world)
    const want = current < band ? Math.min(band, current + stepBlocks) : current
    const distance = clamp(want, MIN_ROAM_DISTANCE, MAX_ROAM_DISTANCE)
    return distance > current
      ? Object.freeze({
          kind: 'advance',
          distance,
          reason: assessment.groups === 0 ? 'undiscovered ground' : 'trivial prey',
        })
      : Object.freeze({ kind: 'stay', reason: 'at the strongest distance the world offers' })
  }
  if (!viable) {
    // The window pays by the XP table but the preview cannot certify ANY group in it (observed: six
    // 6-mob packs at 0-60% win while the party needed 80%). Staying put then means never fighting —
    // the group step finds no target, the roam holds, and the pass falls through to a chore. Step
    // INWARD one leg toward weaker prey: the group that is merely hard becomes the group that is
    // winnable, and the pass that would have idled becomes a fight. Bounded so a party already at
    // the inner ring simply holds there instead of oscillating.
    const distance = clamp(current - stepBlocks, MIN_ROAM_DISTANCE, MAX_ROAM_DISTANCE)
    return distance < current
      ? Object.freeze({ kind: 'advance', distance, reason: 'no winnable group' })
      : Object.freeze({ kind: 'stay', reason: 'already at the inner ring' })
  }
  return Object.freeze({ kind: 'stay', reason: 'worthwhile groups in the window' })
}

export type RoamOutcome = Readonly<{
  kind: 'roamed' | 'joined' | 'traveling' | 'waiting' | 'skipped'
  detail: string
}>

const outcome = (kind: RoamOutcome['kind'], detail: string): RoamOutcome => Object.freeze({ kind, detail })

export type Roamer = Readonly<{
  roam_once: (mover: Mover, level?: number, stepBlocks?: number, viable?: boolean) => Promise<RoamOutcome>
}>

export const create_roamer = (ctx: ActionContext): Roamer => {
  let last_join_ms = 0
  let last_window = ''

  /** Travel to the world portal and switch worlds. Rate-limited so a refusal cannot loop. */
  const join_world = async (mover: Mover, character: CharacterRow, world: string): Promise<RoamOutcome> => {
    if (Date.now() - last_join_ms < JOIN_RETRY_MS) return outcome('skipped', `recent join refused; waiting`)
    last_join_ms = Date.now()
    if (!(await safe_travel_to(mover, WORLD_CENTER, WORLD_CENTER)))
      return outcome('traveling', 'still walking to the world portal')
    if (!(await mover.prove_ready(WORLD_CENTER, WORLD_CENTER)))
      return outcome('traveling', 'the chain cannot yet prove travel to the portal')
    try {
      const receipt = await ctx.sdk.character.join_world({
        character_id: ctx.character_id,
        world,
        custody: custody_of(character),
      })
      ctx.ledger.append({
        kind: 'world_join',
        digest: receipt.digest,
        detail: { world, first_join: receipt.joined.first_join },
      })
      log_info('roam', `joined ${world}${receipt.joined.first_join ? ' (first join)' : ''}`)
      return outcome('joined', world)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log_warn('roam', `join ${world} failed: ${detail}`)
      return outcome('skipped', `join ${world} failed: ${detail}`)
    }
  }

  /** Discover and stand in a stronger zone at the planned distance. */
  const advance = async (mover: Mover, world: SeedWorld, distance: number, reason: string): Promise<RoamOutcome> => {
    const pose = mover.pose()
    const from = zone_at(pose.x, pose.z)
    const target = zone_at_distance(world, pose, distance)
    if (target.zx === from.zx && target.zz === from.zz)
      return outcome('skipped', `already standing at ${from.zx}:${from.zz}`)
    log_info('roam', `roaming ${reason}: ${from.zx}:${from.zz} -> ${target.zx}:${target.zz} (d=${distance})`)
    if (!(await safe_travel_to(mover, target.x, target.z)))
      return outcome('traveling', `still walking to ${target.zx}:${target.zz}`)
    if (!(await mover.prove_ready(target.x, target.z)))
      return outcome('traveling', 'the chain cannot yet prove this leg')
    await mover.ensure_zone(false)
    ctx.ledger.append({
      kind: 'roam',
      detail: { from: `${from.zx}:${from.zz}`, to: `${target.zx}:${target.zz}`, distance, reason },
    })
    log_info('roam', `arrived ${target.zx}:${target.zz}`)
    return outcome('roamed', `${target.zx}:${target.zz}`)
  }

  const roam_once = async (mover: Mover, level?: number, stepBlocks?: number, viable = true): Promise<RoamOutcome> => {
    const state = ctx.state()
    const character = select_character(state, ctx.character_id)
    if (!character) return outcome('skipped', 'character not in roster yet')
    if (character.ambush) return outcome('skipped', 'a protector verdict is pending')
    if (active_fight_of(character)) return outcome('skipped', 'already in a fight')
    if (character.dungeon_run) return outcome('skipped', 'a dungeon run is staging')
    if (!mover.anchor()) return outcome('skipped', 'no chain checkpoint to roam from')

    const effectiveLevel = level ?? character.level
    const fight_world = fight_world_for_level(effectiveLevel)
    if (!fight_world) return outcome('skipped', `no mob world for level ${character.level}`)

    if ((character.world ?? null) !== fight_world.world)
      return await join_world(mover, character, fight_world.world)

    const pose = mover.pose()
    const { zx, zz } = zone_at(pose.x, pose.z)
    // A zone nobody has searched has no population to read; searching it IS the discovery step.
    if (!select_zone(state, fight_world.world, zx, zz)) {
      await mover.ensure_zone(false)
      return outcome('roamed', `${zx}:${zz} (discovered)`)
    }
    if (!state.zone_spawns[zone_key(fight_world.world, zx, zz)])
      // The tracked window still holds the OLD ground until this new zone's population lands; acting
      // on it now would send the engage/gather walking back. Pause the whole chain for this pass.
      return outcome('waiting', `awaiting the population of ${zx}:${zz}`)

    const nearby = nearest_candidates(pose, select_window_mob_groups(state)).map(({ group }) => group)
    const assessment = assess_window(effectiveLevel, nearby)
    // Use smaller steps when grouping so followers can keep up
    const step = stepBlocks ?? STEP_BLOCKS
    const plan = plan_roam(effectiveLevel, pose, fight_world, assessment, step, viable)
    if (plan.kind === 'stay') {
      // Log the live level match once per distinct window, so it is visible whether the prey we
      // hold at is actually high enough for the character (and never spams every pass).
      const signature = `${effectiveLevel}:${assessment.groups}:${assessment.highest_level}:${assessment.best_total_level}:${viable}`
      if (signature !== last_window) {
        last_window = signature
        log_info(
          'roam',
          `holding at lvl ${effectiveLevel} · window ${assessment.groups} groups · best mob lvl ${assessment.highest_level} (sum ${assessment.best_total_level}) — ${plan.reason}`
        )
      }
      return outcome('skipped', plan.reason)
    }
    return await advance(mover, fight_world, plan.distance, plan.reason)
  }

  return Object.freeze({ roam_once })
}
