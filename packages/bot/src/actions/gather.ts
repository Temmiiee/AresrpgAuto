// The gather action: pick the highest-tier live resource pack the character's job level can
// harvest, walk to it, discover the zone, harvest one node, and face a fired protector.
//
// The wire pack row carries only identity + position (`item_type`, x/z, remaining nodes); the job,
// tier, protector, and rare link are authored facts the seed already holds, merged by the content
// projection. A gather can only be composed with those, so they are read here, never guessed.
import { zone_of, type CharacterRow, type ItemRow } from '@aresrpg/protocol'
import { gather_time_ms, job_level_from_xp } from '@aresrpg/immutable'

import { gatherable_of, tool_category_of_job, tier_unlock_level, type Gatherable, type GatheringJob } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { GATHER_DEMAND_STOCK } from './craft.ts'
import { analytics_fight_origin } from './combat_analytics.ts'
import { is_version_assert_error, select_character, select_window_resource_packs, unavailable_item_ids } from '../state/selectors.ts'
import { custody_of, type ActionContext } from './context.ts'
import { EQUIP_SETTLE_MS, equip_settling, mark_equip_settling, verify_equip_ownership } from './equip_guard.ts'
import type { Mover } from './travel.ts'

export type GatherOutcome =
  | Readonly<{ kind: 'gathered'; item_type: string; quantity: number; protector: string | null }>
  | Readonly<{ kind: 'skipped'; reason: string }>

const skipped = (reason: string): GatherOutcome => Object.freeze({ kind: 'skipped', reason })

const find_held = (
  inventory: readonly ItemRow[],
  item_type: string,
  unavailable: ReadonlySet<string>
): ItemRow | undefined => inventory.find((item) => item.item_type === item_type && !unavailable.has(item.id))

const distance_to = (pose: Readonly<{ x: number; z: number }>, x: number, z: number): number =>
  Math.abs(pose.x - x) + Math.abs(pose.z - z)

export type GatherCandidate = Readonly<{
  pack: Readonly<{ item_type: string; x: number; z: number }>
  gatherable: Gatherable
}>

/** Rank live packs for harvest. A pack the crafting rotation still needs outranks every other pack
 *  by its demand score (recipe-driven gathering), then the higher tier wins, then the nearer pack.
 *  A pack in no demand scores 0, so a demanded staple — even a tier-1 wheat against a tier-3
 *  ivory_shroom — wins. Exported so that rule is tested without a live socket. */
export const rank_gather_candidates = <T extends GatherCandidate>(
  candidates: readonly T[],
  demand: ReadonlyMap<string, number> | undefined,
  pose: Readonly<{ x: number; z: number }>
): readonly T[] =>
  [...candidates].sort(
    (left, right) =>
      (demand?.get(right.pack.item_type) ?? 0) - (demand?.get(left.pack.item_type) ?? 0) ||
      right.gatherable.tier - left.gatherable.tier ||
      distance_to(pose, left.pack.x, left.pack.z) - distance_to(pose, right.pack.x, right.pack.z)
  )

/** Whether the character already has (worn or held) the tool a job's gathers require. Packs whose
 *  job tool is missing (or only held as an unavailable item) are not candidates: harvesting them
 *  is refused, and skipping them lets the highest tier the character can ACTUALLY harvest win. */
const tool_ready = (
  character: CharacterRow,
  inventory: readonly ItemRow[],
  job: Gatherable['job'],
  unavailable: ReadonlySet<string>
): boolean => {
  const category = tool_category_of_job(job)
  return (
    character.equipment.some((worn) => worn.category === category) ||
    inventory.some((item) => item.category === category && !unavailable.has(item.id))
  )
}

/** Ensure the tool the job requires is equipped, swapping the current one out if needed. Returns
 *  false when the character owns no equippable tool of that category (the gather would be refused
 *  anyway). Listed/worn tools are un-equippable (their kiosk extraction would abort on chain), so
 *  they are never chosen; a failed swap is logged and skipped rather than aborting the whole pass. */
/** character id → the tool this process swapped in last (bridges the projection lag) */
const recent_tool_swaps = new Map<string, { category: string; item_id: string; at_ms: number }>()
const stale_resource_packs = new Map<string, number>()
const STALE_RESOURCE_PACK_MS = 10 * 60_000
const ambush_resolution_retry_at = new Map<string, number>()
const AMBUSH_RESOLUTION_RETRY_MS = 30_000
const AMBUSH_RESOLUTION_SETTLE_MS = 90_000

const abort_code = (error: unknown): number | null => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  const match = /abort code:\s*(\d+)\b/.exec(text)
  return match ? Number(match[1]) : null
}

const gather_template_mismatch = (error: unknown): boolean => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return /gathering::gather/.test(text) && /abort code:\s*2202\b/.test(text)
}

const gather_tool_not_equipped = (error: unknown): boolean => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return /gathering::gather/.test(text) && /abort code:\s*2203\b/.test(text)
}

const resource_pack_key = (world: string, zx: number, zz: number, index: number, item_type: string): string =>
  `${world}:${zx}:${zz}:${index}:${item_type}`

const resolve_protector = async (
  ctx: ActionContext,
  character: CharacterRow,
  protector: string,
  origin?: Readonly<{ resource?: string; x?: number; z?: number }>
): Promise<void> => {
  const now = Date.now()
  if (now < (ambush_resolution_retry_at.get(character.id) ?? 0)) return
  try {
    const fight = await ctx.sdk.character.resolve_ambush({
      character_id: character.id,
      protector_mob_type: protector,
      custody: custody_of(character),
    })
    ambush_resolution_retry_at.set(character.id, Date.now() + AMBUSH_RESOLUTION_SETTLE_MS)
    ctx.ledger.append({
      kind: 'ambush',
      digest: fight.digest,
      detail: { fight: fight.fight, protector, ...origin },
    })
    analytics_fight_origin(fight.fight, {
      kind: 'resource_protector',
      character: character.name,
      protector,
      ...origin,
    })
    log_info('gather', `${character.name}: ambushed by ${protector} → fight ${fight.fight}`)
  } catch (error) {
    const code = abort_code(error)
    const retry_ms = code === 2207 ? AMBUSH_RESOLUTION_SETTLE_MS : AMBUSH_RESOLUTION_RETRY_MS
    ambush_resolution_retry_at.set(character.id, Date.now() + retry_ms)
    if (is_version_assert_error(error)) {
      log_warn('gather', `${character.name}: protector ${protector} resolution hit MoveAbort 601; will retry after projection/version settles`)
      return
    }
    if (code === 2207) {
      log_warn('gather', `${character.name}: protector verdict is already cleared on chain (2207); waiting for the fight projection`)
      return
    }
    log_warn(
      'gather',
      `${character.name}: protector ${protector} resolution failed${code === null ? '' : ` (MoveAbort ${code})`}; retrying in ${Math.round(retry_ms / 1000)}s: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** A fired verdict can outlive a failed resolve transaction or a process restart. Retry it from
 *  the ordinary character pass, including when gathering itself is disabled. */
export const resolve_pending_ambush = async (ctx: ActionContext, character: CharacterRow): Promise<boolean> => {
  const pending = character.ambush
  if (!pending) {
    ambush_resolution_retry_at.delete(character.id)
    return false
  }
  await resolve_protector(ctx, character, pending.protector, { x: pending.x, z: pending.z })
  return true
}

const ensure_tool = async (
  ctx: ActionContext,
  character: CharacterRow,
  job: Gatherable['job'],
  unavailable: ReadonlySet<string>
): Promise<boolean> => {
  const category = tool_category_of_job(job)
  const worn_tool = character.equipment.find((worn) => worn.slot === 'tool')
  const stale_tool_ids = new Set<string>()
  if (worn_tool?.category === category) {
    // The roster can still show the old tool after a concurrent auto-equip returned it to the kiosk.
    // Ownership is cheap to verify and prevents gathering on a stale slot projection (MoveAbort 2203).
    const live = await verify_equip_ownership(ctx, character.id, [], [{ slot: 'tool', item_id: worn_tool.id }])
    if (live.ok) return true
    if (live.stale_unequip.includes(worn_tool.id)) {
      stale_tool_ids.add(worn_tool.id)
      recent_tool_swaps.delete(character.id)
      log_warn('gather', `${character.name}: tool slot projection is stale (${worn_tool.id.slice(0, 8)}); reconciling before harvest`)
    } else {
      log_warn('gather', `${character.name}: cannot verify the equipped ${category} tool (${live.reason ?? 'ownership unavailable'}); delaying harvest`)
      mark_equip_settling(character.id)
      return false
    }
  }
  // The projection trails our own receipts: a tool we swapped in moments ago is worn on chain even
  // though the row still shows the old one. Trust the recent swap instead of re-sending it (the
  // re-send would try to unequip the OLD tool, which is already back in the kiosk).
  const recent = recent_tool_swaps.get(character.id)
  if (recent && Date.now() - recent.at_ms < EQUIP_SETTLE_MS) {
    if (recent.category === category) return true
  }
  if (equip_settling(character.id)) return false
  const available = new Set(unavailable)
  for (const id of stale_tool_ids) available.delete(id)
  const tool = ctx.state().inventory.find((item) => item.category === category && !available.has(item.id))
  if (!tool) return false
  const current = character.equipment.find((worn) => worn.slot === 'tool')
  const to_equip = [{ slot: 'tool', item_id: tool.id }] as const
  const to_unequip = current ? [{ slot: 'tool', item_id: current.id }] : []
  const verdict = await verify_equip_ownership(ctx, character.id, to_equip, to_unequip)
  if (verdict.already_worn.includes(tool.id)) {
    recent_tool_swaps.set(character.id, { category, item_id: tool.id, at_ms: Date.now() })
    return true
  }
  if (!verdict.ok) {
    log_warn('gather', `${character.name}: skipping stale ${category} swap (${verdict.reason}); retrying once the projection settles`)
    mark_equip_settling(character.id)
    return false
  }
  try {
    await ctx.sdk.character.equip({
      character_id: ctx.character_id,
      to_equip: [...to_equip],
      to_unequip,
      custody: custody_of(character),
    })
    recent_tool_swaps.set(character.id, { category, item_id: tool.id, at_ms: Date.now() })
    mark_equip_settling(character.id)
  } catch (error) {
    if (is_version_assert_error(error)) {
      log_warn('gather', `could not equip ${category} (${tool.id}) — MoveAbort 601 (package version mismatch or paused version gate)`)
      return false
    }
    log_warn(
      'gather',
      `could not equip ${category} (${tool.id}): ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
  log_info('gather', `equipped ${category}`)
  return true
}

export const gather_once = async (
  ctx: ActionContext,
  mover: Mover,
  /** when set, harvest ONLY packs of this gathering job (the party's per-character specialty) */
  job?: GatheringJob,
  /** when set, ignore packs farther than this many blocks (keeps a party member near the group so
   *  a rendezvous stays cheap instead of chasing a node two zones away) */
  max_distance?: number,
  /** when set, a pack whose item the crafting rotation still needs is picked BEFORE any higher-tier
   *  pack the window happens to hold (recipe-driven gathering — without it the gatherers climb the
   *  tier ladder to ivory_shrooms and never feed the wheat/quartz the stalled trades craft from) */
  demand?: ReadonlyMap<string, number>
): Promise<GatherOutcome> => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return skipped('character not in roster yet')
  if (!character.world) return skipped('character has not joined a world')
  const world = character.world
  if (character.ambush) return skipped('a protector verdict is pending')

  const jobs = character.jobs ?? {}
  const pose = mover.pose()
  const held = state.inventory
  const unavailable = unavailable_item_ids(state)
  const stock_by_type = new Map<string, number>()
  for (const item of held) {
    if (unavailable.has(item.id)) continue
    stock_by_type.set(item.item_type, (stock_by_type.get(item.item_type) ?? 0) + Number(item.amount))
  }
  // Tally WHY a pack was dropped so a barren run says whether the window held nothing, the job did
  // not match, the tier was locked, or the tool was missing -- a generic message hid a dead gather
  // pipeline for a whole night (every chore skipped with no hint of which filter was biting). The
  // counts are INDEPENDENT (a pack can fail several) and the window's item histogram is included, so
  // one line names both the requested specialty and what the local window actually grows.
  const window_packs = select_window_resource_packs(state).filter(({ zone }) => zone.world === world)
  const pick = (wanted: GatheringJob | undefined) => {
    let job_out = 0
    let tier_out = 0
    let tool_out = 0
    let surplus_out = 0
    let stale_out = 0
    const item_counts = new Map<string, number>()
    const candidates = rank_gather_candidates(
      window_packs
        .flatMap(({ zone, pack }) => {
          const gatherable = gatherable_of(pack.item_type)
          if (!gatherable) return []
          item_counts.set(pack.item_type, (item_counts.get(pack.item_type) ?? 0) + 1)
          const key = resource_pack_key(world, zone.zx, zone.zz, pack.index, pack.item_type)
          const stale_until = stale_resource_packs.get(key) ?? 0
          if (stale_until > Date.now()) {
            stale_out += 1
            return []
          }
          if (stale_until > 0) stale_resource_packs.delete(key)
          const job_ok = wanted === undefined || gatherable.job === wanted
          const tier_ok = tier_unlock_level(gatherable.tier) <= job_level_from_xp(Number(jobs[gatherable.job] ?? 0))
          const tool_ok = tool_ready(character, held, gatherable.job, unavailable)
          // Demand ranking must not silently become an unlimited stock farm: once an item reaches
          // the same reserve target used by the recipe planner, leave it to another pack/job.
          const surplus = !demand?.has(pack.item_type) && (stock_by_type.get(pack.item_type) ?? 0) >= GATHER_DEMAND_STOCK
          if (!job_ok) job_out += 1
          if (!tier_ok) tier_out += 1
          if (!tool_ok) tool_out += 1
          if (surplus) surplus_out += 1
          if (!job_ok || !tier_ok || !tool_ok || surplus) return []
          return [{ pack, gatherable }]
        })
        .filter(({ pack }) => max_distance === undefined || distance_to(pose, pack.x, pack.z) <= max_distance),
      demand,
      pose
    )
    return { candidates, job_out, tier_out, tool_out, surplus_out, stale_out, item_counts }
  }

  let picked = pick(job)
  // The specialty has nothing harvestable HERE (every pack of that job is above its tier, or its
  // tool is missing): harvest whatever this character CAN work in the window instead of idling.
  // The xp still lands on a gathering job, and the excursion planner keeps relocating the party
  // toward the specialty's own tier-1 packs.
  if (!picked.candidates[0] && job !== undefined) {
    const fallback = pick(undefined)
    // prefer a job whose tool is already on, so the fallback does not churn tool swaps every pass
    const worn_tool = character.equipment.find((worn) => worn.slot === 'tool')?.category
    const same_tool = fallback.candidates.filter(({ gatherable }) => tool_category_of_job(gatherable.job) === worn_tool)
    if (same_tool.length) fallback.candidates = same_tool
    if (fallback.candidates[0]) {
      log_info(
        'gather',
        `${character.name}: no workable ${job} pack here (${job} lvl ${job_level_from_xp(Number(jobs[job] ?? 0))}, tier-locked=${picked.tier_out} no-tool=${picked.tool_out}); harvesting ${fallback.candidates[0].gatherable.job} meanwhile`
      )
      picked = fallback
    }
  }
  const { candidates, job_out, tier_out, tool_out, surplus_out, stale_out, item_counts } = picked

  const target = candidates[0]
  if (!target) {
    const holds = [...item_counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([item, n]) => `${item}×${n}`)
      .join(' ')
    const levels = job ? ` ${job}=lvl${job_level_from_xp(Number(jobs[job] ?? 0))}` : ''
    return skipped(
      `no tool-ready unlocked live packs in the tracked window (want=${job ?? 'any'}${levels} window=${window_packs.length} job≠${job_out} tier-locked=${tier_out} no-tool=${tool_out} overstock=${surplus_out} stale-pack=${stale_out} holds[${holds}])`
    )
  }

  const ready_to_gather = await ctx.equipment_queue.run(async () => {
    const latest_state = ctx.state()
    const latest_character = select_character(latest_state, ctx.character_id)
    return latest_character
      ? ensure_tool(ctx, latest_character, target.gatherable.job, unavailable_item_ids(latest_state))
      : false
  })
  if (!ready_to_gather) {
    log_warn('gather', `could not ready a ${target.gatherable.job} tool; skipping ${target.pack.item_type} until the equipment projection settles`)
    return skipped(`no ${target.gatherable.job} tool`)
  }

  const { zx, zz } = zone_of(target.pack.x, target.pack.z)
  const travel_from = mover.pose()
  try {
    await mover.travel_to(target.pack.x, target.pack.z)
  } catch (error) {
    const pose = mover.pose()
    if (pose.x !== travel_from.x || pose.z !== travel_from.z) {
      try {
        // Every streamed step was individually reachable. Commit that partial progress so the next
        // gather pass starts with a fresh travel bank instead of stalling at the same final blocks.
        await mover.ensure_zone(false)
      } catch (anchor_error) {
        log_warn('gather', `${character.name}: partial travel re-anchor failed: ${anchor_error instanceof Error ? anchor_error.message : String(anchor_error)}`)
      }
    }
    log_warn(
      'gather',
      `${character.name}: travel to ${target.pack.x},${target.pack.z} paused at ${pose.x},${pose.z} — ${error instanceof Error ? error.message : String(error)}`
    )
    return skipped('travel leg paused; will resume from the current position')
  }
  if (!(await mover.prove_ready(target.pack.x, target.pack.z))) return skipped('the chain cannot yet prove this leg')
  await mover.ensure_zone(false)

  let receipt
  try {
    receipt = await ctx.equipment_queue.run(async () => {
      // Auto-equip can run while this character walks to the node. Re-read its projection and
      // re-assert the required tool inside the same lock as the gather transaction, so a concurrent
      // slot swap cannot turn into MoveAbort 2203 after a long trip.
      const latest_state = ctx.state()
      const latest_character = select_character(latest_state, ctx.character_id)
      if (!latest_character || !(await ensure_tool(
        ctx,
        latest_character,
        target.gatherable.job,
        unavailable_item_ids(latest_state)
      ))) return null
      const live_unavailable = unavailable_item_ids(ctx.state())
      const inventory = ctx.state().inventory
      return ctx.sdk.character.gather({
        character_id: ctx.character_id,
        world,
        zone_x: zx,
        zone_z: zz,
        pack_index: target.pack.index,
        item_type: target.pack.item_type,
        rare_item_type: target.gatherable.rare_item_type,
        existing: find_held(inventory, target.pack.item_type, live_unavailable)?.id ?? null,
        existing_rare: find_held(inventory, target.gatherable.rare_item_type, live_unavailable)?.id ?? null,
        custody: custody_of(latest_character),
      })
    })
    if (!receipt) return skipped('gathering tool changed while travelling; waiting for equipment to settle')
  } catch (error) {
    if (is_version_assert_error(error)) {
      log_warn('gather', `${target.pack.item_type} at ${zx}:${zz} — MoveAbort 601 (package version mismatch or paused version gate)`)
      return Object.freeze({ kind: 'skipped', reason: 'versions stale' })
    }
    if (gather_template_mismatch(error)) {
      const key = resource_pack_key(world, zx, zz, target.pack.index, target.pack.item_type)
      stale_resource_packs.set(key, Date.now() + STALE_RESOURCE_PACK_MS)
      log_warn(
        'gather',
        `${character.name}: pack template mismatch 2202 at ${zx}:${zz}#${target.pack.index} (projection=${target.pack.item_type}); suppressing this pack for ${Math.round(STALE_RESOURCE_PACK_MS / 60_000)}m and refreshing the zone`
      )
      try {
        await mover.ensure_zone(false)
      } catch (refresh_error) {
        log_warn('gather', `${character.name}: zone refresh after 2202 failed: ${refresh_error instanceof Error ? refresh_error.message : String(refresh_error)}`)
      }
      return skipped('resource pack template mismatch; refreshed and temporarily suppressed')
    }
    if (gather_tool_not_equipped(error)) {
      recent_tool_swaps.delete(character.id)
      mark_equip_settling(character.id)
      log_warn(
        'gather',
        `${character.name}: chain rejected gather with MoveAbort 2203 (required tool is not in the tool slot); invalidated the cached tool and will re-plan after the projection settles`
      )
      return skipped('required gathering tool was not equipped on chain; reconciling equipment before retry')
    }
    throw error
  }

  ctx.ledger.append({
    kind: 'gather',
    digest: receipt.digest,
    detail: {
      item_type: target.pack.item_type,
      quantity: receipt.quantity,
      zone: `${zx}:${zz}`,
      pack: target.pack.index,
      ambushed: receipt.ambushed,
    },
  })
  log_info('gather', `${target.pack.item_type} ×${receipt.quantity} at ${zx}:${zz}`)

  // The harvest ROOTS the character on chain for `gather_time` beyond now, so the checkpoint the
  // next leg proves against is future-dated. Tell the mover, or it keeps the pre-harvest bank and
  // the following search_zone/gather refuses with `world::prove_move` (ETravelTooFar 305).
  const job_level = job_level_from_xp(Number(jobs[target.gatherable.job] ?? 0))
  mover.note_rooted(gather_time_ms(job_level))

  if (!receipt.ambushed) return Object.freeze({ kind: 'gathered', item_type: target.pack.item_type, quantity: receipt.quantity, protector: null })

  await resolve_protector(ctx, character, target.gatherable.protector, {
    resource: target.pack.item_type,
    x: target.pack.x,
    z: target.pack.z,
  })
  return Object.freeze({
    kind: 'gathered',
    item_type: target.pack.item_type,
    quantity: receipt.quantity,
    protector: target.gatherable.protector,
  })
}
