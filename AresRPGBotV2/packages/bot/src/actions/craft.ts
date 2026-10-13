// craft actions — the recipe planner and the one-batch craft door.
//
// A craft composes ONLY from facts the projection already carries: the recipe's authored
// ingredients, the output's held stack, and the character's held ingredient stacks. The chain
// re-validates everything (job-level gate, ingredient amounts, the batch cap); this module just
// refuses to build a transaction the chain would obviously reject.
//
// A batch is always sized to the affordable ceiling, never a fixed count: one transaction carries
// the whole batch, so the most XP rides the fewest (and cheapest) transactions.
import {
  craft_batch_limit,
  craft_required_level,
  craft_xp_at_level,
  item_is_stackable,
  job_kind_of,
  job_level_from_xp,
  job_slugs,
} from '@aresrpg/immutable'
import type { CharacterRow, ItemRow } from '@aresrpg/protocol'

import { items_by_type, job_recipes, type RecipeDetail } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { select_character, unavailable_item_ids } from '../state/selectors.ts'
import { custody_of, type ActionContext } from './context.ts'

export type CraftPlan = Readonly<{
  output_type: string
  job: string
  attempts: number
  input_item_ids: readonly string[]
  existing: string | null
}>

const held = (
  inventory: readonly ItemRow[],
  item_type: string,
  unavailable: ReadonlySet<string>
): ItemRow | undefined => inventory.find((item) => item.item_type === item_type && !unavailable.has(item.id))

/** How many attempts the held ingredients + the batch cap allow (0 = cannot craft). */
const affordable_attempts = (
  detail: RecipeDetail,
  inventory: readonly ItemRow[],
  unavailable: ReadonlySet<string>
): number => {
  const per_ingredient = detail.ingredients.reduce<number>((max, ingredient) => {
    const stack = held(inventory, ingredient.item_type, unavailable)
    if (!stack || ingredient.quantity <= 0) return 0
    return Math.min(max, Math.floor(stack.amount / ingredient.quantity))
  }, Number.MAX_SAFE_INTEGER)
  const cap = craft_batch_limit(items_by_type[detail.output_type]?.category ?? '')
  return Math.max(0, Math.min(per_ingredient, cap))
}

/** One craftable batch for a recipe, or null when the character cannot craft it right now. */
export const plan_recipe = (
  character: CharacterRow,
  detail: RecipeDetail,
  inventory: readonly ItemRow[],
  unavailable: ReadonlySet<string>
): CraftPlan | null => {
  const level = job_level_from_xp(Number(character.jobs?.[detail.job] ?? '0'))
  if (level < craft_required_level(detail.ingredients.length)) return null
  if (craft_xp_at_level(detail.ingredients.length, level) <= 0) return null

  const input_item_ids = detail.ingredients.map((ingredient) => held(inventory, ingredient.item_type, unavailable)?.id)
  if (input_item_ids.some((id) => id === undefined)) return null

  const attempts = affordable_attempts(detail, inventory, unavailable)
  if (attempts < 1) return null

  // A NON-stackable output (equipment: daggers, armour, tools) mints one fresh object per success and
  // the chain FORBIDS an output target for it — `craft_batch::assert_output_target` requires a unique
  // craft to pass `attempts == 1` and NO target. Handing a held stack as `existing` aborts
  // EOutputTarget (2323), so only a stackable output merges into the stack already held.
  const stackable = item_is_stackable(items_by_type[detail.output_type]?.category ?? '')
  return Object.freeze({
    output_type: detail.output_type,
    job: detail.job,
    attempts,
    input_item_ids: input_item_ids as readonly string[],
    existing: stackable ? (held(inventory, detail.output_type, unavailable)?.id ?? null) : null,
  })
}

/** Every job slug whose authored kind is a crafting trade (FORGER, CARVER, TAILOR, JEWELER, TANNER,
 *  HANDYMAN, ALCHEMIST, BAKER) — the trades the crafting rotation must level. */
const crafting_jobs: readonly string[] = Object.freeze(
  job_slugs.filter((job) => job_kind_of(job) !== 'gathering')
)

/** The crafting trades this character should train, least-trained first, so a pass trains the
 *  lowest job and crafting rotates across every profession instead of farming one. */
const rotation_order = (character: CharacterRow): readonly string[] => {
  const jobs = character.jobs ?? {}
  return [...crafting_jobs].sort(
    (left, right) =>
      job_level_from_xp(Number(jobs[left] ?? '0')) - job_level_from_xp(Number(jobs[right] ?? '0'))
  )
}

/** The best recipe the character can craft right now. The character rotates through every crafting
 *  job (least-trained first); within a job the highest-XP affordable recipe wins. Returns null when
 *  no ingredient set is held for any trade. */
export const select_craft_target = (ctx: ActionContext): CraftPlan | null => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return null
  const unavailable = unavailable_item_ids(state)
  for (const job of rotation_order(character)) {
    const recipes = [...job_recipes(job)].sort((left, right) => right.craft_xp - left.craft_xp)
    for (const detail of recipes) {
      const plan = plan_recipe(character, detail, state.inventory, unavailable)
      if (plan) return plan
    }
  }
  return null
}

export type CraftResult = Readonly<{
  success: boolean
  outcome: string
  output_type: string
  successes: number
}>

/** Submit one craft batch. The plan already encodes the held ingredient ids + output stack. */
export const craft_once = async (ctx: ActionContext, plan: CraftPlan): Promise<CraftResult> => {
  const character = select_character(ctx.state(), ctx.character_id)
  if (!character)
    return { success: false, outcome: 'character_not_found', output_type: plan.output_type, successes: 0 }
  try {
    const receipt = await ctx.sdk.character.craft({
      character_id: ctx.character_id,
      output_type: plan.output_type,
      input_item_ids: plan.input_item_ids,
      existing: plan.existing,
      attempts: plan.attempts,
      custody: custody_of(character),
    })
    ctx.ledger.append({
      kind: 'craft',
      digest: receipt.digest,
      detail: {
        output_type: plan.output_type,
        job: plan.job,
        attempts: receipt.attempts,
        successes: receipt.successes,
        xp: receipt.job_xp_gained,
      },
    })
    log_info('craft', `crafted ${plan.output_type} ${receipt.successes}/${receipt.attempts} (+${receipt.job_xp_gained} xp)`)
    return { success: true, outcome: `crafted:${plan.output_type}`, output_type: plan.output_type, successes: receipt.successes }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log_warn('craft', `craft ${plan.output_type} failed: ${msg}`)
    return { success: false, outcome: `craft_error:${msg.slice(0, 60)}`, output_type: plan.output_type, successes: 0 }
  }
}

/** Plan and submit the best available craft, or report that nothing is craftable. */
export const drive_craft = async (ctx: ActionContext): Promise<CraftResult> => {
  const plan = select_craft_target(ctx)
  if (!plan) return { success: false, outcome: 'nothing_craftable', output_type: '', successes: 0 }
  return await craft_once(ctx, plan)
}
