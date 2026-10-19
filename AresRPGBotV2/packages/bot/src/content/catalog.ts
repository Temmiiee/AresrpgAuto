// Seed-derived content projection. The seed ships in the repo (seed/content/*.json); this module
// is the bot's ONE place that reads it and hangs the derived lookups the actions need off it.
//
// The worlds seed lists each resource as just an identity plus where it grows; the job, tier,
// protector, and rare link are authored facts of @aresrpg/immutable's gatherable catalog. We merge
// them here exactly as the frontend does, so a gather can always be composed (the wire never
// carries the protector or the rare link).
import {
  craft_batch_limit,
  craft_job_of,
  craft_xp_from_ingredient_count,
  gatherable_of,
  item_is_stackable,
  tier_unlock_level,
  type Gatherable,
  type GatheringJob,
  type JobSlug,
} from '@aresrpg/immutable'
import type { SeedDungeon, SeedItem, SeedMob, SeedRecipe, SeedSpell } from '@aresrpg/sdk/seed'

import dungeons_source from '../../../../seed/content/dungeons.json'
import items_source from '../../../../seed/content/items.json'
import mobs_source from '../../../../seed/content/mobs.json'
import recipes_source from '../../../../seed/content/recipes.json'
import spells_source from '../../../../seed/content/spells.json'
import worlds_source from '../../../../seed/content/worlds.json'

export { craft_xp_from_ingredient_count, gatherable_of, item_is_stackable, tier_unlock_level }
export type { Gatherable, GatheringJob, JobSlug }

export type WorldResource = Readonly<{
  item_type: string
  job: GatheringJob
  tier: number
  protector: string
  rare_item_type: string
  biomes: readonly string[]
  cities: readonly string[]
}>

export type WorldMob = Readonly<{
  mob_type: string
  weight_bp: number
  biomes: readonly string[]
  cities: readonly string[]
}>

export type SeedWorld = Readonly<{
  world: string
  entry_level: number
  mobs: readonly WorldMob[]
  resources: readonly WorldResource[]
  cities: readonly Readonly<{ city: string; x: number; z: number; dungeon: string }>[]
}>

type RawSeedWorld = Omit<SeedWorld, 'mobs' | 'resources'> &
  Readonly<{
    mobs:
      | readonly Readonly<{
          mob_type: string
          weight_bp: number
          biomes: readonly string[]
          cities?: readonly string[]
        }>[]
      | Readonly<Record<string, number>>
    resources: readonly Readonly<{
      item_type: string
      biomes?: readonly string[]
      cities?: readonly string[]
    }>[]
  }>

const fill_world = (world: RawSeedWorld): SeedWorld =>
  Object.freeze({
    world: world.world,
    entry_level: world.entry_level,
    cities: Object.freeze(world.cities.map((city) => Object.freeze({ ...city }))),
    mobs: Object.freeze(
      Array.isArray(world.mobs)
        ? world.mobs.map((mob) =>
            Object.freeze({
              mob_type: mob.mob_type,
              weight_bp: mob.weight_bp,
              biomes: Object.freeze(mob.biomes),
              cities: Object.freeze(mob.cities ?? []),
            })
          )
        : Object.entries(world.mobs).map(([mob_type, weight_bp]) =>
            Object.freeze({ mob_type, weight_bp, biomes: Object.freeze([]), cities: Object.freeze([]) })
          )
    ),
    resources: Object.freeze(
      world.resources.map((resource) => {
        const gatherable = gatherable_of(resource.item_type)
        if (!gatherable) throw new Error(`Unknown gatherable ${resource.item_type} in ${world.world}`)
        return Object.freeze({
          ...gatherable,
          biomes: Object.freeze(resource.biomes ?? []),
          cities: Object.freeze(resource.cities ?? []),
        })
      })
    ),
  })

export const items: readonly SeedItem[] = Object.freeze(items_source as unknown as readonly SeedItem[])
export const mobs: readonly SeedMob[] = Object.freeze(mobs_source as unknown as readonly SeedMob[])
export const dungeons: readonly SeedDungeon[] = Object.freeze(dungeons_source as unknown as readonly SeedDungeon[])
export const recipes: readonly SeedRecipe[] = Object.freeze(recipes_source as unknown as readonly SeedRecipe[])
export const spells: readonly SeedSpell[] = Object.freeze(spells_source as unknown as readonly SeedSpell[])
export const worlds: readonly SeedWorld[] = Object.freeze(
  (worlds_source as unknown as readonly RawSeedWorld[]).map(fill_world)
)

const keyed = <T>(rows: readonly T[], key: (row: T) => string): Readonly<Record<string, T>> =>
  Object.freeze(Object.fromEntries(rows.map((row) => [key(row), row])))

export const items_by_type = keyed(items, ({ item_type }) => item_type)
export const mobs_by_type = keyed(mobs, ({ mob_type }) => mob_type)
export const recipes_by_output = keyed(recipes, ({ output_type }) => output_type)
export const worlds_by_id = keyed(worlds, ({ world }) => world)
export const dungeons_by_id = keyed(dungeons, ({ dungeon }) => dungeon)

/** item_type -> the mob types whose loot table carries it. The strategy uses it to annotate a gear
 *  route with the families that also DROP a craftable piece, and to find the best gear the seed
 *  offers ONLY as loot (no recipe). Built once at module load. */
export const loot_sources_by_item: ReadonlyMap<string, readonly string[]> = (() => {
  const by_item = new Map<string, string[]>()
  for (const mob of mobs)
    for (const drop of mob.loot) {
      const bucket = by_item.get(drop.item_type)
      if (bucket) bucket.push(mob.mob_type)
      else by_item.set(drop.item_type, [mob.mob_type])
    }
  return by_item
})()

/** The ordered room compositions of a dungeon; each room is a list of the mobs it stages. */
export const dungeon_rooms = (dungeon: string): readonly (readonly Readonly<{ mob_type: string }>[])[] =>
  dungeons_by_id[dungeon]?.rooms ?? []

/** The authored city portal of a dungeon inside a world, or null when that world has no such city. */
export const dungeon_city = (
  world: SeedWorld,
  dungeon: string
): Readonly<{ city: string; x: number; z: number; dungeon: string }> | null =>
  world.cities.find((city) => city.dungeon === dungeon) ?? null

/** The job a recipe belongs to: the output's authored craft category first, then the recipe row. */
export const recipe_job = (recipe: SeedRecipe): string =>
  craft_job_of(items_by_type[recipe.output_type]?.category ?? '') ?? recipe.job ?? ''

export type Ingredient = Readonly<{ item_type: string; quantity: number; item: SeedItem | null }>

export type RecipeDetail = Readonly<{
  output_type: string
  job: string
  craft_xp: number
  ingredients: readonly Ingredient[]
}>

/** A recipe as the craft action consumes it: job, the XP one attempt grants, and the ingredient
 *  list with each input's authored row (null when the seed has no such item). */
export const recipe_detail = (recipe: SeedRecipe): RecipeDetail =>
  Object.freeze({
    output_type: recipe.output_type,
    job: recipe_job(recipe),
    craft_xp: craft_xp_from_ingredient_count(Object.keys(recipe.inputs).length),
    ingredients: Object.freeze(
      Object.entries(recipe.inputs).map(([item_type, quantity]) =>
        Object.freeze({ item_type, quantity, item: items_by_type[item_type] ?? null })
      )
    ),
  })

/** Recipes grouped by their job slug — the craft planner walks one job's list at a time. */
const grouped_by_job = (() => {
  const grouped = new Map<string, RecipeDetail[]>()
  for (const recipe of recipes) {
    const detail = recipe_detail(recipe)
    const bucket = grouped.get(detail.job)
    if (bucket) bucket.push(detail)
    else grouped.set(detail.job, [detail])
  }
  return Object.freeze(
    Object.fromEntries([...grouped].map(([job, rows]) => [job, Object.freeze(rows) as readonly RecipeDetail[]]))
  )
})()

export const recipes_by_job = (): Readonly<Record<string, readonly RecipeDetail[]>> => grouped_by_job

/** The job tool category a gather of the given job requires equipped. */
const TOOL_BY_JOB: Readonly<Record<GatheringJob, string>> = Object.freeze({
  FARMER: 'tool_farmer',
  HERBALIST: 'tool_herbalist',
  MINER: 'tool_miner',
})

export const tool_category_of_job = (job: GatheringJob): string => TOOL_BY_JOB[job]

/** Every recipe craftable for one job at a level — the input cap is enforced by the chain; we
 *  only surface the authored list so the planner can filter by held ingredients. */
export const job_recipes = (job: string): readonly RecipeDetail[] =>
  recipes_by_job()[job] ?? Object.freeze([])

const demand_memo = new Map<string, ReadonlyMap<string, number>>()
const demand_visiting = new Set<string>()
const no_demand: ReadonlyMap<string, number> = new Map()

/** How much ONE craft of `output_type` consumes of each gatherable input, walked down the craft DAG.
 *  An ingredient a world grows is a leaf; an ingredient that is itself craftable expands (its own
 *  per-craft quantity multiplied through); an ingredient that only drops from a mob is skipped —
 *  nothing the gather action can aim at. This is the missing edge of the loop: `plan_recipe` knows
 *  what is held, but nothing else ever said what must be harvested to make it. Memoised because the
 *  demand derivation asks every job's recipes, and cycle-guarded so a self-referential seed cannot
 *  hang a pass. Read-only. */
export const gatherable_demand = (output_type: string): ReadonlyMap<string, number> => {
  const cached = demand_memo.get(output_type)
  if (cached) return cached
  if (demand_visiting.has(output_type)) return no_demand
  demand_visiting.add(output_type)

  const result = new Map<string, number>()
  const recipe = recipes_by_output[output_type]
  if (recipe)
    for (const ingredient of recipe_detail(recipe).ingredients) {
      if (gatherable_of(ingredient.item_type)) {
        result.set(ingredient.item_type, (result.get(ingredient.item_type) ?? 0) + ingredient.quantity)
        continue
      }
      for (const [leaf, quantity] of gatherable_demand(ingredient.item_type))
        result.set(leaf, (result.get(leaf) ?? 0) + ingredient.quantity * quantity)
    }

  demand_visiting.delete(output_type)
  demand_memo.set(output_type, result)
  return result
}

const loot_memo = new Map<string, ReadonlyMap<string, number>>()
const loot_visiting = new Set<string>()
const no_loot: ReadonlyMap<string, number> = new Map()

/** How much ONE craft of `output_type` consumes of each MOB-DROP input, walked down the craft DAG.
 *  The exact mirror of {@link gatherable_demand}: an ingredient a world grows is skipped (the gather
 *  action supplies it), an ingredient that is itself craftable expands, and an ingredient with no
 *  recipe that is not gatherable is a leaf — it can only come from a mob's loot table. The engage
 *  reads these leaves to bias toward the families carrying the materials a chain is missing.
 *
 *  This closes the loop the gather demand cannot: EVERY refinement in the dungeon-key DAG eats
 *  `water`, a mob-only drop authored on no world, so a key chain fed by gathering alone never fills.
 *  Memoised + cycle-guarded like the gatherable walk. Read-only. */
export const loot_demand = (output_type: string): ReadonlyMap<string, number> => {
  const cached = loot_memo.get(output_type)
  if (cached) return cached
  if (loot_visiting.has(output_type)) return no_loot
  loot_visiting.add(output_type)

  const result = new Map<string, number>()
  const recipe = recipes_by_output[output_type]
  if (recipe)
    for (const ingredient of recipe_detail(recipe).ingredients) {
      const item_type = ingredient.item_type
      if (gatherable_of(item_type)) continue
      if (recipes_by_output[item_type]) {
        for (const [leaf, quantity] of loot_demand(item_type))
          result.set(leaf, (result.get(leaf) ?? 0) + ingredient.quantity * quantity)
        continue
      }
      result.set(item_type, (result.get(item_type) ?? 0) + ingredient.quantity)
    }

  loot_visiting.delete(output_type)
  loot_memo.set(output_type, result)
  return result
}

export { craft_batch_limit }
