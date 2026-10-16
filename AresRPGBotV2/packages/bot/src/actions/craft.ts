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

import {
  gatherable_demand,
  items_by_type,
  job_recipes,
  recipe_detail,
  recipes_by_output,
  type RecipeDetail,
} from '../content/catalog.ts'
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

/** True when a recipe output is a dungeon key — the one output whose whole point is a farmable run. */
const is_key_output = (output_type: string): boolean => items_by_type[output_type]?.category === 'key'

/** Value of a recipe's output, best first, used ONLY to break an XP tie: a dungeon key, then an
 *  output the party does not already hold (crafting a duplicate tool is pure waste), then the
 *  higher-level item (a level-10 tool is a real upgrade over a level-1 one at the same XP). */
const output_value = (detail: RecipeDetail, holds: (item_type: string) => boolean): readonly number[] =>
  Object.freeze([
    is_key_output(detail.output_type) ? 1 : 0,
    holds(detail.output_type) ? 0 : 1,
    items_by_type[detail.output_type]?.level ?? 0,
  ])

/** Best recipe first: XP desc (more ingredient slots grant more XP), then {@link output_value}. */
const better_recipe =
  (holds: (item_type: string) => boolean) =>
  (left: RecipeDetail, right: RecipeDetail): number => {
    if (left.craft_xp !== right.craft_xp) return right.craft_xp - left.craft_xp
    const a = output_value(left, holds)
    const b = output_value(right, holds)
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return b[i]! - a[i]!
    return 0
  }

/** The best recipe the character can craft right now. The character rotates through every crafting
 *  job (least-trained first); within a job the highest-XP affordable recipe wins, with ties broken by
 *  output value so a dungeon key beats an old tool and an upgrade beats a duplicate at the same XP.
 *  Returns null when no ingredient set is held for any trade. */
export const select_craft_target = (ctx: ActionContext): CraftPlan | null => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return null
  const unavailable = unavailable_item_ids(state)
  const inventory = state.inventory
  const holds = (item_type: string): boolean =>
    inventory.some((row) => row.item_type === item_type && !unavailable.has(row.id))
  for (const job of rotation_order(character)) {
    const recipes = [...job_recipes(job)].sort(better_recipe(holds))
    for (const detail of recipes) {
      const plan = plan_recipe(character, detail, inventory, unavailable)
      if (plan) return plan
    }
  }
  return null
}

/** A gatherable input is demanded only while its held stock sits under this line: enough that the
 *  crafter's next batch never drains it straight to zero, low enough that a well-fed gatherer hands
 *  its priority back and climbs the tier ladder instead of pinning on one staple forever. */
const DEMAND_STOCK = 60

/** Recipe-driven gathering: the gatherable inputs the crafting rotation still OWES, ranked.
 *
 *  `plan_recipe` can only propose what the inventory already holds, so a trade with nothing held
 *  falls through the rotation forever — observed as JEWELER/BAKER/HANDYMAN stuck at level 1/3/4
 *  while the gatherers farmed the highest tier in the window (ivory_shrooms), never the tier-1
 *  staples their chains actually eat. The gatherers cannot see that gap on their own: only the
 *  crafter knows which recipes are one missing input away, so this derives the demand from the
 *  crafter's job levels and the gather action consumes it.
 *
 *  Every level-eligible recipe is walked down to its gatherable leaves (through any intermediate
 *  craft). The returned rank is the leaf's TOTAL one-craft requirement across those recipes, not
 *  its tier: wheat feeds the flour chain AND a dozen low-tier TAILOR/JEWELER recipes, so it must
 *  outrank the narrow wheat_barley beside it rather than lose to it on tier. A leaf drops out once
 *  its stock reaches {@link DEMAND_STOCK}. `extra_outputs` folds in recipes that are not part of the
 *  rotation but whose inputs the party must still stock: the dungeon keys. */
export const craft_gather_demand = (
  character: CharacterRow,
  inventory: readonly ItemRow[],
  unavailable: ReadonlySet<string>,
  extra_outputs: readonly string[] = []
): ReadonlyMap<string, number> => {
  const jobs = character.jobs ?? {}
  /** leaf -> summed one-craft requirement over every eligible recipe that resolves to it. */
  const leverage = new Map<string, number>()
  const note = (detail: RecipeDetail): void => {
    const level = job_level_from_xp(Number(jobs[detail.job] ?? '0'))
    if (level < craft_required_level(detail.ingredients.length)) return
    if (craft_xp_at_level(detail.ingredients.length, level) <= 0) return
    for (const [item_type, quantity] of gatherable_demand(detail.output_type))
      leverage.set(item_type, (leverage.get(item_type) ?? 0) + quantity)
  }

  for (const job of rotation_order(character)) for (const detail of job_recipes(job)) note(detail)
  for (const output_type of extra_outputs) {
    const recipe = recipes_by_output[output_type]
    if (recipe) note(recipe_detail(recipe))
  }

  const demand = new Map<string, number>()
  for (const [item_type, rank] of leverage) {
    const stack = inventory.find((row) => row.item_type === item_type && !unavailable.has(row.id))
    if ((stack?.amount ?? 0) < DEMAND_STOCK) demand.set(item_type, rank)
  }
  return demand
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
