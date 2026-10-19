// The gathering excursion — the event-driven relocation that keeps every gatherer fed.
//
// A follower's chore can only harvest packs that are LIVE in the tracked window (gather.ts). The
// window follows the party, and the party holds the ring where the fights pay — so a gatherer whose
// specialty grows in a biome the ring does not touch starves (the shipped diagnostics showed
// `memorien: 0 FARMER-pack(s)`, `llokan: 0 MINER-pack(s)` while the party farmed a herbalist biome).
// The fix is to move the whole side to the resource, not to strand one member:
//
//   1. the LEADER reads the shared projection every idle pass and asks, per gatherer, "is the
//      highest resource tier your job has unlocked present as a live pack near you?" (gather_needs);
//   2. when that gap has PERSISTED past a trigger, the leader picks the nearest zone that answers
//      the most gatherers at once — a city hub answers all three tier-1 jobs — and records it on the
//      shared party state (plan_excursion);
//   3. the leader walks there (leader_group_step), the followers rally behind it, and the side
//      dwells long enough for the chores to fire before ordinary play resumes.
//
// Only SAME-WORLD relocations are planned. yakutia holds tiers 4-6 but has no mobs, so a party that
// fights in nauvis cannot simply walk there; a cross-world gathering trip needs its own detach
// protocol and is deliberately deferred (logged, never attempted blind).
import { job_level_from_xp } from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'

import { config, GATHERING_JOBS, type ChoreRole } from '../config.ts'
import { find_resource_zone, resource_eligible_at, type ResourceZone } from '../content/biomes.ts'
import {
  tool_category_of_job,
  tier_unlock_level,
  worlds,
  type GatheringJob,
  type SeedWorld,
} from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { select_window_resource_packs, unavailable_item_ids } from '../state/selectors.ts'
import type { GameState } from '../state/store.ts'
import type { PartyState } from './party.ts'

/** How far (in blocks) a gatherer may range from a pack and still call its specialty "available".
 *  Matches the party's local gather cap so a relocation that lands the side within this radius is
 *  guaranteed to let the chore fire. */
export const PARTY_GATHER_RADIUS = 1_024

/** A gather gap must persist this long before the party answers it — stops a single missed beat
 *  (a fight that swallowed the chore window) from triggering a multi-minute relocation. */
const EXCURSION_TRIGGER_MS = 30_000
/** How long the side sits on the resource once it arrives, so the chores can actually fire. */
const EXCURSION_DWELL_MS = 180_000
/** Minimum spacing between relocations, so the side is not permanently nomadic. */
const EXCURSION_COOLDOWN_MS = 120_000
/** How far out the leader will look for a resource zone before deciding the need is unreachable. */
const EXCURSION_SEARCH_RINGS = 160
/** How often the same deferred (cross-world) need is re-logged. */
const DEFERRED_LOG_MS = 600_000

export type PartyPose = Readonly<{ x: number; z: number }>

export type GatherMember = Readonly<{
  id: string
  name: string
  /** every gathering job this member covers (one for a single-job chore, all three for a rotator) */
  jobs: readonly GatheringJob[]
  /** the subset of `jobs` the member owns a worn/held tool for — travel cannot fix a missing tool */
  tool_ready_jobs: readonly GatheringJob[]
  /** the member's latest streamed pose, or null when it has none yet */
  pose: PartyPose | null
}>

export type GatherNeed = Readonly<{
  member_id: string
  member_name: string
  job: GatheringJob
  /** the highest resource tier the member's job level has unlocked */
  tier: number
  /** every item_type at that tier — any one in reach satisfies the need */
  item_types: readonly string[]
  /** the world those resources spawn in */
  world: string
}>

export type Excursion = Readonly<{
  world: string
  zx: number
  zz: number
  x: number
  z: number
  biome: string
  kind: 'biome' | 'city'
  /** member ids this relocation intends to satisfy */
  member_ids: readonly string[]
  started_ms: number
  /** 0 while the leader is still walking; the arrival time once it stands on the zone */
  arrived_ms: number
}>

/** job -> every authored resource of that job, tagged with the world that places it. */
const resources_by_job: Readonly<Record<string, readonly Readonly<{ item_type: string; tier: number; world: string }>[]>> =
  (() => {
    const by_job: Record<string, { item_type: string; tier: number; world: string }[]> = {}
    for (const world of worlds)
      for (const resource of world.resources) (by_job[resource.job] ??= []).push({ item_type: resource.item_type, tier: resource.tier, world: world.world })
    return Object.freeze(by_job)
  })()

const has_job_tool = (
  character: CharacterRow,
  inventory: GameState['inventory'],
  job: GatheringJob,
  unavailable: ReadonlySet<string>
): boolean => {
  const category = tool_category_of_job(job)
  return (
    character.equipment.some((worn) => worn.category === category) ||
    inventory.some((item) => item.category === category && !unavailable.has(item.id))
  )
}

/** Every party member whose chore gathers, with the jobs it covers and the ones it is tool-ready for.
 *  A single-job chore (`gather`/`gather_craft`) covers ONE job; an all-resource chore
 *  (`gather_all`/`gather_all_craft`) covers every job. Recognising only `gather` here was the bug
 *  that killed every excursion: the default plan is `gather_craft`/`gather_all_craft`, so this
 *  returned EMPTY, `gather_needs` saw no gap, and the party never left a biome its gatherers could
 *  not work (the live window held only quartz+amber while omori's chore wanted HERBALIST — zero
 *  harvests for the whole window). */
export const gather_members = (state: GameState, party: PartyState): readonly GatherMember[] => {
  const unavailable = unavailable_item_ids(state)
  const members: GatherMember[] = []
  for (const id of party.members) {
    const character = state.characters.find((row) => row.id === id)
    if (!character) continue
    const chore: ChoreRole = config.chore_plan[character.name.toLowerCase()] ?? Object.freeze({ kind: 'none' })
    const jobs: readonly GatheringJob[] | null =
      chore.kind === 'gather' || chore.kind === 'gather_craft'
        ? [chore.job]
        : chore.kind === 'gather_all' || chore.kind === 'gather_all_craft'
          ? GATHERING_JOBS
          : null
    if (!jobs) continue
    members.push(
      Object.freeze({
        id,
        name: character.name,
        jobs,
        tool_ready_jobs: Object.freeze(jobs.filter((job) => has_job_tool(character, state.inventory, job, unavailable))),
        pose: party.poses.get(id) ?? null,
      })
    )
  }
  return Object.freeze(members)
}

/** Every authored resource of `job` in `world` at `tier` (the world filter is what keeps a need
 *  answerable: a tier that only grows in another world could never be satisfied by a same-world
 *  relocation, which is all the excursion does). */
const tier_items = (
  job: GatheringJob,
  tier: number,
  world: string
): readonly Readonly<{ item_type: string; world: string }>[] =>
  Object.freeze(
    (resources_by_job[job] ?? [])
      .filter((row) => row.world === world && row.tier === tier)
      .map((row) => Object.freeze({ item_type: row.item_type, world: row.world }))
  )

/** The highest tier of `job` that BOTH unlocks at `level` AND grows in `world` (0 when none). Scoped
 *  to the member's own world on purpose: the globally-highest unlocked tier is usually the tier 4-6
 *  line that only grows in yakutia, so a global need would always resolve cross-world, the excursion
 *  would log "holding", and the party would never relocate to answer a gap it could actually fix. */
const highest_unlocked_tier = (job: GatheringJob, level: number, world: string): number => {
  const tiers = [...new Set((resources_by_job[job] ?? []).filter((row) => row.world === world).map((row) => row.tier))]
  let best = 0
  for (const tier of tiers) if (tier_unlock_level(tier) <= level) best = Math.max(best, tier)
  return best
}

/** A gatherer's unmet specialty: NONE of the jobs it is tool-ready for has a live, unlocked pack in
 *  reach. A member without a tool for a job is skipped for that job — travel cannot fix a missing
 *  tool, only a craft can. A single-job member is unmet exactly when its one job is absent; a rotator
 *  only when all of its jobs are. */
export const gather_needs = (
  state: GameState,
  members: readonly GatherMember[],
  radius = PARTY_GATHER_RADIUS
): readonly GatherNeed[] => {
  const packs = select_window_resource_packs(state)
  const needs: GatherNeed[] = []
  for (const member of members) {
    const character = state.characters.find((row) => row.id === member.id)
    if (!character) continue
    const pose =
      member.pose ?? (character.x !== undefined && character.z !== undefined ? { x: character.x, z: character.z } : null)
    if (!pose) continue
    const world = character.world
    if (!world) continue
    const unmet: GatherNeed[] = []
    let satisfied = false
    for (const job of member.tool_ready_jobs) {
      const level = job_level_from_xp(Number(character.jobs?.[job] ?? '0'))
      const tier = highest_unlocked_tier(job, level, world)
      if (tier <= 0) continue
      const items = tier_items(job, tier, world)
      if (items.length === 0) continue
      const item_set = new Set(items.map((row) => row.item_type))
      const present = packs.some(
        ({ pack }) =>
          item_set.has(pack.item_type) &&
          Math.max(Math.abs(pack.x - pose.x), Math.abs(pack.z - pose.z)) <= radius
      )
      if (present) {
        satisfied = true
        break
      }
      unmet.push(
        Object.freeze({
          member_id: member.id,
          member_name: member.name,
          job,
          tier,
          item_types: Object.freeze(items.map((row) => row.item_type)),
          world: items[0]!.world,
        })
      )
    }
    if (satisfied || unmet.length === 0) continue
    // Relocate for the richest missing specialty when a rotator has several.
    unmet.sort((left, right) => right.tier - left.tier)
    needs.push(unmet[0]!)
  }
  return Object.freeze(needs)
}

const eligible_for = (world: SeedWorld, need: GatherNeed, zx: number, zz: number): boolean =>
  need.item_types.some((item_type) => resource_eligible_at(world, item_type, zx, zz))

/** The nearest zone that answers the most local needs at once. City hubs cover whole early tiers
 *  (thebes: wheat + green_mushroom + quartz), so this naturally prefers them over a pure biome. */
export const plan_excursion = (
  needs: readonly GatherNeed[],
  world: string,
  from_x: number,
  from_z: number
): Excursion | null => {
  const local = needs.filter((need) => need.world === world)
  if (local.length === 0) return null
  const seed_world = worlds.find((row) => row.world === world)
  if (!seed_world) return null

  const candidates = new Map<string, ResourceZone>()
  for (const need of local)
    for (const item_type of need.item_types) {
      const zone = find_resource_zone(world, item_type, from_x, from_z, EXCURSION_SEARCH_RINGS)
      if (zone) candidates.set(`${zone.zx},${zone.zz}`, zone)
    }
  if (candidates.size === 0) return null

  const from_zx = Math.floor(from_x / 32)
  const from_zz = Math.floor(from_z / 32)
  let best: ResourceZone | null = null
  let best_score = -1
  let best_distance = Number.POSITIVE_INFINITY
  for (const zone of candidates.values()) {
    const score = local.filter((need) => eligible_for(seed_world, need, zone.zx, zone.zz)).length
    const distance = Math.max(Math.abs(zone.zx - from_zx), Math.abs(zone.zz - from_zz))
    if (score > best_score || (score === best_score && distance < best_distance)) {
      best = zone
      best_score = score
      best_distance = distance
    }
  }
  if (!best) return null
  const member_ids = local.filter((need) => eligible_for(seed_world, need, best!.zx, best!.zz)).map((need) => need.member_id)
  return Object.freeze({
    world,
    zx: best.zx,
    zz: best.zz,
    x: best.x,
    z: best.z,
    biome: best.biome,
    kind: best.kind,
    member_ids: Object.freeze(member_ids),
    started_ms: Date.now(),
    arrived_ms: 0,
  })
}

/** The leader's idle relocation decision. Updates the persistence clock, then — when a gap has
 *  lasted past the trigger and the cooldown has elapsed — records a destination and returns true.
 *  Returns false when there is nothing to answer (the caller then plans an ordinary fight). */
export const maybe_start_excursion = (
  ctx: { state: () => GameState },
  party: PartyState,
  character: CharacterRow,
  pose: PartyPose
): boolean => {
  if (party.excursion) return false
  const state = ctx.state()
  const needs = gather_needs(state, gather_members(state, party))
  const now = Date.now()

  const live = new Set(needs.map((need) => need.member_id))
  for (const id of [...party.need_since.keys()]) if (!live.has(id)) party.need_since.delete(id)
  for (const need of needs) if (!party.need_since.has(need.member_id)) party.need_since.set(need.member_id, now)
  if (needs.length === 0) return false

  const persistent = needs.filter((need) => now - (party.need_since.get(need.member_id) ?? now) >= EXCURSION_TRIGGER_MS)
  if (persistent.length === 0) return false
  if (now - party.last_excursion_ms < EXCURSION_COOLDOWN_MS) return false

  const world = character.world ?? config.world ?? 'nauvis'
  const planned = plan_excursion(persistent, world, pose.x, pose.z)
  if (!planned) {
    // Nothing in this world answers the gap: log the cross-world (deferred) needs once in a while.
    for (const need of persistent)
      if (need.world !== world) {
        const key = `${need.member_id}:${need.world}`
        if (now - (party.deferred_log_ms.get(key) ?? 0) >= DEFERRED_LOG_MS) {
          party.deferred_log_ms.set(key, now)
          log_warn(
            'excursion',
            `${need.member_name} needs T${need.tier} ${need.job} in ${need.world} — cross-world gathering is not automated; holding`
          )
        }
      }
    return false
  }

  party.excursion = planned
  party.last_excursion_ms = now
  log_info(
    'party',
    `excursion: relocating to ${planned.zx}:${planned.zz} (${planned.kind} ${planned.biome}) for ${persistent
      .filter((need) => planned.member_ids.includes(need.member_id))
      .map((need) => `${need.member_name}:${need.job} T${need.tier}`)
      .join(', ')}`
  )
  return true
}

/** True when the relocation has served its purpose: the dwell has elapsed. Also guards against
 *  a stuck excursion by timing out the travel phase. */
export const excursion_done = (_state: GameState, party: PartyState): boolean => {
  const excursion = party.excursion
  if (!excursion) return true
  const now = Date.now()
  if (excursion.arrived_ms > 0 && now - excursion.arrived_ms >= EXCURSION_DWELL_MS) return true
  // Travel phase timeout: if we've been walking for > 10 minutes, give up and clear.
  if (excursion.arrived_ms === 0 && now - excursion.started_ms > 600_000) return true
  return false
}

/** Clear the excursion and start the cooldown. */
export const finish_excursion = (party: PartyState): void => {
  if (!party.excursion) return
  party.excursion = null
  party.last_excursion_ms = Date.now()
}
