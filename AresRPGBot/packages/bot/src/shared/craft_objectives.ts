// Craft objectives & craft-value gating (2026-09-17).
//
// Gives the farm engine a notion of "the player wants THIS item crafted" so the harvest+craft
// pass can (1) farm the ingredients a target recipe needs and (2) STOP spending those same
// ingredients on other, low-value crafts while the objective is pending. Without this, a party
// holding 20 gnawed_branch burns them on old_hoe / wheatbound_branch compounds while a
// quartzbound_pickaxe (20 gnawed_branch + 10 quartz_honed_beak) never gets made — the exact
// waste the user reported (lorito_hat__molted-style junk consumed the mats + SUI).
//
// Config lives in craft_objectives.local.json at the bot package root (same local_store
// convention as item_prices.json / train_checkpoint.local.json):
//   {
//     "objectives": [
//       { "output_type": "quartzbound_pickaxe", "quantity": 1 },
//       { "output_type": "key_of_gilded_lorito", "quantity": 2 }
//     ],
//     "min_craft_value_sui": 0.15,        // gear below this est. value is never crafted
//     "job_priority": ["TAILOR", ...]      // optional: order craft-job passes by this list
//   }
// Everything here is PURE (no chain calls, no I/O except the config read) so the decision logic
// is unit-testable against the seed recipes — mirrors craft_supply.ts's own split.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from '../state/local_store.ts'

export type CraftObjective = { output_type: string; quantity?: number }

export type CraftObjectivesConfig = {
  objectives?: CraftObjective[]
  /** Gear recipes whose estimated output value is below this (SUI) are treated as junk and
   *  never craft-selected. Estimated via get_item_price, which falls back on level^0.6 scaling
   *  for gear with no market history — so the floor doubles as a "don't bother" level gate. */
  min_craft_value_sui?: number
  /** Optional ordered list of craft jobs; the engine runs craft passes in this order, so a
   *  higher-priority job spends shared ingredients first. Jobs absent from the list run after
   *  all listed ones, in the default alphabetic order. */
  job_priority?: string[]
}

const store = create_local_json_store<CraftObjectivesConfig>(
  fileURLToPath(new URL('../../craft_objectives.local.json', import.meta.url)),
  {}
)

export const read_craft_objectives_config = (): CraftObjectivesConfig => store.read()

export const DEFAULT_MIN_CRAFT_VALUE_SUI = 0.15

export const min_craft_value_sui = (config: CraftObjectivesConfig): number =>
  typeof config.min_craft_value_sui === 'number' ? config.min_craft_value_sui : DEFAULT_MIN_CRAFT_VALUE_SUI

/** The bits of a recipe the objective machinery reads — recipes spread their real `job`/levels
 *  at the call site, but only output + inputs matter here. */
export type RecipeLike = { output_type: string; inputs: Record<string, number> }

export const recipe_of_list = (recipes: readonly RecipeLike[], output_type: string): RecipeLike | undefined =>
  recipes.find((r) => r.output_type === output_type)

const objective_needed = (objective: CraftObjective): number => objective.quantity ?? 1

/** Objectives still unmet — the party owns fewer of the output than the objective asks for.
 *  `owned_by_type` is the party's total owned quantity per item_type (kiosk stacks summed, plus
 *  one per equipped instance for non-stackables). */
export const pending_objectives = (
  objectives: readonly CraftObjective[] | undefined,
  owned_by_type: ReadonlyMap<string, number>
): CraftObjective[] =>
  (objectives ?? []).filter((o) => (owned_by_type.get(o.output_type) ?? 0) < objective_needed(o))

/** Every ingredient type consumed by the recipes of PENDING objectives. While any objective is
 *  unmet, these resources are reserved: other recipes that consume them are excluded from craft
 *  selection so they can't eat the objective's mats. */
export const reserved_resources = (
  recipes: readonly RecipeLike[],
  pending: readonly CraftObjective[],
  owned_by_type: ReadonlyMap<string, number>
): Set<string> => {
  const reserved = new Set<string>()
  for (const objective of pending) {
    // Already-need-reserved: the still-missing amount is what we must protect. If the party
    // already holds enough for the objective (but e.g. the craft hasn't succeeded a roll yet),
    // there's nothing left to protect.
    const needed = objective_needed(objective)
    if ((owned_by_type.get(objective.output_type) ?? 0) >= needed) continue
    const recipe = recipe_of_list(recipes, objective.output_type)
    if (!recipe) continue // objective names a recipe we don't know — leave its mats unreserved
    for (const ingredient of Object.keys(recipe.inputs)) reserved.add(ingredient)
  }
  return reserved
}

/** Is this recipe the very objective it's helping satisfy? The objective's own recipe is ALLOWED
 *  to touch reserved resources (that's the whole point); every other recipe is not. */
export const is_objective_recipe = (
  objective: CraftObjective,
  recipe: RecipeLike
): boolean => recipe.output_type === objective.output_type

// --- craft-recipe selection (the do_craft_pass decision, pure so it's unit-testable) ----------

export type RecipeCandidate = RecipeLike & { required_level: number }

export type CraftSelectionArgs = {
  /** Craft job this pass is running for — restricts which pending objective applies. */
  job: string
  /** Recipes doable RIGHT NOW: required_level <= the character's job level and every ingredient
   *  present (>=1 instance) in the kiosk. */
  candidates: readonly RecipeCandidate[]
  /** The pending objective assigned to this job, if any (reserved_resources handles the
   *  ingredient-side; this hands the output-side goal to the picker). */
  objective: CraftObjective | undefined
  /** Ingredient types reserved by PENDING objectives across ALL jobs. */
  reserved: ReadonlySet<string>
  value_floor_sui: number
  party_max_level: number
  gear_categories: ReadonlySet<string>
  category_of: (output_type: string) => string | undefined
  output_level_of: (output_type: string) => number
  unit_price_sui_of: (output_type: string) => number
}

/** Picks the single recipe a craft pass should run right now, in priority order:
 *  1. the pending objective's own recipe, once doable (even below the value floor — it's the
 *     player's explicit target);
 *  2. the most valuable equippable gear / key (gear capped at the party level, everything floored
 *     at value_floor_sui so junk like lorito_hat__molted is never selected);
 *  3. the highest-XP powder/compound grind — but NEVER junk gear and NEVER a recipe that would
 *     burn a pending-fetch material flagged in `reserved`.
 * Returns undefined when nothing is worth the materials (all gear junk, no powder doable) — the
 * pass then sits out instead of crafting trash. */
export const select_craft_recipe = (args: CraftSelectionArgs): RecipeCandidate | undefined => {
  const objective_output = args.objective?.output_type
  const is_goal = (r: RecipeCandidate): boolean => r.output_type === objective_output
  const steals_reserved = (r: RecipeCandidate): boolean =>
    !is_goal(r) && [...Object.keys(r.inputs)].some((ingredient) => args.reserved.has(ingredient))

  const goal = args.candidates.find((r) => is_goal(r))
  if (goal) return goal

  const valuable = args.candidates
    .filter((r) => {
      const category = args.category_of(r.output_type)
      const is_gear = category !== undefined && (args.gear_categories.has(category) || category === 'key')
      if (!is_gear) return false
      if (args.gear_categories.has(category) && args.output_level_of(r.output_type) > args.party_max_level) return false
      if (args.unit_price_sui_of(r.output_type) < args.value_floor_sui) return false
      if (steals_reserved(r)) return false
      return true
    })
    .sort(
      (a, b) =>
        args.unit_price_sui_of(b.output_type) - args.unit_price_sui_of(a.output_type) ||
        b.required_level - a.required_level
    )
  if (valuable[0]) return valuable[0]

  return args.candidates
    .filter((r) => {
      const category = args.category_of(r.output_type)
      if (category !== undefined && (args.gear_categories.has(category) || category === 'key')) return false
      return !steals_reserved(r)
    })
    .sort((a, b) => b.required_level - a.required_level)[0]
}

/** Orders craft jobs so a configured priority list runs first (in list order, then the rest
 *  sorted alphabetically). */
export const order_craft_jobs = (jobs: readonly string[], priority: readonly string[] | undefined): string[] => {
  if (!priority || priority.length === 0) return [...jobs].sort()
  const by_priority = priority.filter((job) => jobs.includes(job))
  const rest = [...jobs].filter((job) => !priority.includes(job)).sort()
  return [...by_priority, ...rest]
}