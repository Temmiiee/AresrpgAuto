// The gather action: pick the highest-tier live resource pack the character's job level can
// harvest, walk to it, discover the zone, harvest one node, and face a fired protector.
//
// The wire pack row carries only identity + position (`item_type`, x/z, remaining nodes); the job,
// tier, protector, and rare link are authored facts the seed already holds, merged by the content
// projection. A gather can only be composed with those, so they are read here, never guessed.
import { zone_of, type CharacterRow, type ItemRow } from '@aresrpg/protocol'
import { job_level_from_xp } from '@aresrpg/immutable'

import { gatherable_of, tool_category_of_job, tier_unlock_level, type Gatherable, type GatheringJob } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { select_character, select_window_resource_packs, unavailable_item_ids } from '../state/selectors.ts'
import { custody_of, type ActionContext } from './context.ts'
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
const ensure_tool = async (
  ctx: ActionContext,
  character: CharacterRow,
  job: Gatherable['job'],
  unavailable: ReadonlySet<string>
): Promise<boolean> => {
  const category = tool_category_of_job(job)
  if (character.equipment.some((worn) => worn.category === category)) return true
  const tool = ctx.state().inventory.find((item) => item.category === category && !unavailable.has(item.id))
  if (!tool) return false
  const current = character.equipment.find((worn) => worn.slot === 'tool')
  try {
    await ctx.sdk.character.equip({
      character_id: ctx.character_id,
      to_equip: [{ slot: 'tool', item_id: tool.id }],
      to_unequip: current ? [{ slot: 'tool', item_id: current.id }] : [],
      custody: custody_of(character),
    })
  } catch (error) {
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
  max_distance?: number
): Promise<GatherOutcome> => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return skipped('character not in roster yet')
  if (character.world !== ctx.world) return skipped(`character is in ${character.world ?? 'no world'}`)
  if (character.ambush) return skipped('a protector verdict is pending')

  const jobs = character.jobs ?? {}
  const pose = mover.pose()
  const held = state.inventory
  const unavailable = unavailable_item_ids(state)
  const candidates = select_window_resource_packs(state)
    .flatMap(({ pack }) => {
      const gatherable = gatherable_of(pack.item_type)
      if (!gatherable) return []
      if (job !== undefined && gatherable.job !== job) return []
      if (tier_unlock_level(gatherable.tier) > job_level_from_xp(Number(jobs[gatherable.job] ?? 0))) return []
      if (!tool_ready(character, held, gatherable.job, unavailable)) return []
      return [{ pack, gatherable }]
    })
    .filter(({ pack }) => max_distance === undefined || distance_to(pose, pack.x, pack.z) <= max_distance)
    .sort(
      (left, right) =>
        right.gatherable.tier - left.gatherable.tier ||
        distance_to(pose, left.pack.x, left.pack.z) - distance_to(pose, right.pack.x, right.pack.z)
    )

  const target = candidates[0]
  if (!target) return skipped('no tool-ready unlocked live packs in the tracked window')

  if (!(await ensure_tool(ctx, character, target.gatherable.job, unavailable))) {
    log_warn('gather', `no ${target.gatherable.job} tool owned; skipping ${target.pack.item_type}`)
    return skipped(`no ${target.gatherable.job} tool`)
  }

  const { zx, zz } = zone_of(target.pack.x, target.pack.z)
  await mover.travel_to(target.pack.x, target.pack.z)
  if (!(await mover.prove_ready(target.pack.x, target.pack.z))) return skipped('the chain cannot yet prove this leg')
  await mover.ensure_zone(false)

  const inventory = ctx.state().inventory
  const receipt = await ctx.sdk.character.gather({
    character_id: ctx.character_id,
    world: ctx.world,
    zone_x: zx,
    zone_z: zz,
    pack_index: target.pack.index,
    item_type: target.pack.item_type,
    rare_item_type: target.gatherable.rare_item_type,
    existing: find_held(inventory, target.pack.item_type, unavailable)?.id ?? null,
    existing_rare: find_held(inventory, target.gatherable.rare_item_type, unavailable)?.id ?? null,
    custody: custody_of(character),
  })

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

  if (!receipt.ambushed) return Object.freeze({ kind: 'gathered', item_type: target.pack.item_type, quantity: receipt.quantity, protector: null })

  const fight = await ctx.sdk.character.resolve_ambush({
    character_id: ctx.character_id,
    protector_mob_type: target.gatherable.protector,
    custody: custody_of(character),
  })
  ctx.ledger.append({
    kind: 'ambush',
    digest: fight.digest,
    detail: { fight: fight.fight, protector: target.gatherable.protector },
  })
  log_info('gather', `ambushed by ${target.gatherable.protector} → fight ${fight.fight}`)
  return Object.freeze({
    kind: 'gathered',
    item_type: target.pack.item_type,
    quantity: receipt.quantity,
    protector: target.gatherable.protector,
  })
}
