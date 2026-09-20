import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

import { craft_job_of, craft_required_level } from '@aresrpg/immutable'

import { get_item_price } from '../src/market/item_valuation.ts'
import { item_drop_cities } from '../src/shared/craft_supply.ts'
import {
  order_craft_jobs,
  pending_objectives,
  read_craft_objectives_config,
  recipe_of_list,
  reserved_resources,
  select_craft_recipe,
  type RecipeLike,
} from '../src/shared/craft_objectives.ts'

// Craft-objective + craft-value gating. Two layers are tested: the pure decision logic (with
// inline fixtures) and the committed configuration against the REAL seed (the pickup whose mats
// the whole feature exists to protect: quartzbound_pickaxe consuming gnawed_branch).

const seed_recipes = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../seed/content/recipes.json', import.meta.url)), 'utf8')
) as { output_type: string; inputs: Record<string, number>; job: string | null }[]

const seed_items = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../seed/content/items.json', import.meta.url)), 'utf8')
) as { item_type: string; category: string; level: number }[]

const item_category = new Map(seed_items.map((i) => [i.item_type, i.category]))
const item_level = new Map(seed_items.map((i) => [i.item_type, i.level]))
const recipe_job = (output_type: string): string | undefined => {
  const recipe = seed_recipes.find((r) => r.output_type === output_type)
  if (!recipe) return undefined
  return craft_job_of(item_category.get(output_type) ?? '') ?? recipe.job ?? undefined
}

const VALUABLE_GEAR = new Set<string>(['hat', 'cloak', 'belt', 'boots', 'amulet', 'ring', 'daggers', 'spear', 'bow', 'axe', 'sword'])

const category_of = (t: string): string | undefined => item_category.get(t)
const output_level_of = (t: string): number => item_level.get(t) ?? 0
const unit_price_sui_of = (t: string): number => get_item_price(t).unit_price_sui

describe('pending_objectives', () => {
  test('an objective is pending until the party owns the target quantity', () => {
    const owned = new Map<string, number>([['quartzbound_pickaxe', 0]])
    const pending = pending_objectives([{ output_type: 'quartzbound_pickaxe', quantity: 1 }], owned)
    expect(pending).toHaveLength(1)
    owned.set('quartzbound_pickaxe', 1)
    expect(pending_objectives([{ output_type: 'quartzbound_pickaxe', quantity: 1 }], owned)).toHaveLength(0)
  })

  test('undefined objectives (config absent) is an empty `pending` set', () => {
    expect(pending_objectives(undefined, new Map())).toHaveLength(0)
  })
})

describe('reserved_resources', () => {
  const recipes: RecipeLike[] = [
    { output_type: 'quartzbound_pickaxe', inputs: { gnawed_branch: 20, quartz_honed_beak: 10 } },
    { output_type: 'old_hoe', inputs: { gnawed_branch: 5, salvaged_scrap: 5 } },
    { output_type: 'wheat_flour', inputs: { wheat: 2, water: 1 } },
  ]

  test('reserves every ingredient of a pending objective recipe', () => {
    const owned = new Map<string, number>([['quartzbound_pickaxe', 0]])
    const reserved = reserved_resources(recipes, [{ output_type: 'quartzbound_pickaxe', quantity: 1 }], owned)
    expect([...reserved].sort()).toEqual(['gnawed_branch', 'quartz_honed_beak'])
  })

  test('nothing is reserved once the party owns the objective output', () => {
    const owned = new Map<string, number>([['quartzbound_pickaxe', 1]])
    expect(reserved_resources(recipes, [{ output_type: 'quartzbound_pickaxe', quantity: 1 }], owned).size).toBe(0)
  })
})

describe('order_craft_jobs', () => {
  const jobs = ['MINER', 'FARMER', 'TAILOR', 'HERBALIST'] as const

  test('configured priority runs first, unlisted jobs after in alphabetical order', () => {
    expect(order_craft_jobs([...jobs], ['TAILOR', 'FARMER'])).toEqual(['TAILOR', 'FARMER', 'HERBALIST', 'MINER'])
  })

  test('no priority list keeps the default alphabetical order', () => {
    expect(order_craft_jobs([...jobs], undefined)).toEqual(['FARMER', 'HERBALIST', 'MINER', 'TAILOR'])
  })
})

describe('select_craft_recipe — value gating and reservations', () => {
  const party_17 = {
    job: 'TAILOR',
    candidates: [] as ReturnType<typeof tmp_candidates>,
    objective: undefined,
    reserved: new Set<string>(),
    value_floor_sui: 0.15,
    party_max_level: 17,
    gear_categories: VALUABLE_GEAR,
    category_of,
    output_level_of,
    unit_price_sui_of,
  }
  // tiny helper so `candidates` keeps a stable shape between assertions
  function tmp_candidates(rs: { output_type: string; required_level?: number; inputs?: Record<string, number> }[]): { output_type: string; inputs: Record<string, number>; job: string; required_level: number }[] {
    return rs.map((r) => ({ output_type: r.output_type, inputs: r.inputs ?? {}, job: 'X', required_level: r.required_level ?? 1 }))
  }

  test('junk gear below the value floor is never selected (the lorito_hat case)', () => {
    const args = { ...party_17, candidates: tmp_candidates([{ output_type: 'lorito_hat__molted', required_level: 3 }]) }
    expect(unit_price_sui_of('lorito_hat__molted')).toBeLessThan(0.15)
    expect(select_craft_recipe(args)).toBeUndefined()
  })

  test('a powder/compound is preferred over junk gear when it is the only alternative', () => {
    const args = {
      ...party_17,
      candidates: tmp_candidates([{ output_type: 'lorito_hat__molted', required_level: 3 }, { output_type: 'wheat_flour', required_level: 2 }]),
    }
    expect(select_craft_recipe(args)?.output_type).toBe('wheat_flour')
  })

  test('equippable high-value gear is picked over the powder grind', () => {
    const args = {
      ...party_17,
      candidates: tmp_candidates([{ output_type: 'wheat_flour', required_level: 7 }, { output_type: 'lorito_hat__strength', required_level: 2 }]),
    }
    // lorito_hat__strength is a lv 8 hat over the 0.15 floor — gear wins over a 7-slot powder.
    expect(unit_price_sui_of('lorito_hat__strength')).toBeGreaterThanOrEqual(0.15)
    expect(select_craft_recipe(args)?.output_type).toBe('lorito_hat__strength')
  })

  test('a recipe eating a reserved ingredient is never picked by another (goal) objective', () => {
    const recipes: RecipeLike[] = [
      { output_type: 'quartzbound_pickaxe', inputs: { gnawed_branch: 20, quartz_honed_beak: 10 } },
      { output_type: 'basic_pickaxe', inputs: { gnawed_branch: 5, beak_shard: 5 } },
      { output_type: 'old_hoe', inputs: { gnawed_branch: 5, salvaged_scrap: 5 } },
      { output_type: 'wheat_flour', inputs: { wheat: 2, water: 1 } },
    ]
    const owned = new Map<string, number>([['quartzbound_pickaxe', 0], ['gnawed_branch', 3]])
    const reserved = reserved_resources(recipes, [{ output_type: 'quartzbound_pickaxe', quantity: 1 }], owned)
    const pick = select_craft_recipe({
      job: 'HANDYMAN',
      candidates: tmp_candidates([
        { output_type: 'basic_pickaxe', required_level: 2, inputs: { gnawed_branch: 5, beak_shard: 5 } },
        { output_type: 'wheat_flour', required_level: 1, inputs: { wheat: 2, water: 1 } },
      ]),
      objective: undefined,
      reserved,
      value_floor_sui: 0.15,
      party_max_level: 17,
      gear_categories: new Set<string>(),
      category_of,
      output_level_of,
      unit_price_sui_of,
    })
    expect(pick?.output_type).toBe('wheat_flour')
  })

  test('the pending objective itself is crafted first even though a higher-price gear is doable', () => {
    const recipes: RecipeLike[] = [{ output_type: 'quartzbound_pickaxe', inputs: { gnawed_branch: 20, quartz_honed_beak: 10 } }]
    const owned = new Map<string, number>([['quartzbound_pickaxe', 0]])
    const reserved = reserved_resources(recipes, [{ output_type: 'quartzbound_pickaxe', quantity: 1 }], owned)
    const pick = select_craft_recipe({
      job: 'HANDYMAN',
      candidates: tmp_candidates([
        { output_type: 'quartzbound_pickaxe', required_level: 3 },
        { output_type: 'lorito_hat__strength', required_level: 2 },
      ]),
      objective: { output_type: 'quartzbound_pickaxe', quantity: 1 },
      reserved,
      value_floor_sui: 0.15,
      party_max_level: 17,
      gear_categories: VALUABLE_GEAR,
      category_of,
      output_level_of,
      unit_price_sui_of,
    })
    expect(pick?.output_type).toBe('quartzbound_pickaxe')
  })

  test('gear above the party level is never crafted (nobody can equip it yet)', () => {
    const args = {
      ...party_17,
      candidates: tmp_candidates([{ output_type: 'coiffe_fuwa__black', required_level: 8 }, { output_type: 'wheat_flour', required_level: 1 }]),
      party_max_level: 5,
    }
    // coiffe_fuwa__black is a lv 15 hat above the price floor — only the party-level cap disqualifies it
    expect(unit_price_sui_of('coiffe_fuwa__black')).toBeGreaterThanOrEqual(0.15)
    expect(select_craft_recipe(args)?.output_type).toBe('wheat_flour')
  })
})

describe('committed config vs the real seed (quartzbound pickaxe objective)', () => {
  const config = read_craft_objectives_config()

  test('every configured objective names a real seed recipe', () => {
    expect(config.objectives?.length ?? 0).toBeGreaterThan(0)
    for (const objective of config.objectives ?? []) {
      expect(recipe_of_list(seed_recipes, objective.output_type)).toBeDefined()
    }
  })

  test('the pickaxe objective is HANDYMAN and reserves gnawed_branch + quartz_honed_beak', () => {
    const objective = config.objectives?.find((o) => o.output_type === 'quartzbound_pickaxe')
    expect(objective).toBeDefined()
    expect(recipe_job('quartzbound_pickaxe')).toBe('HANDYMAN')
    const owned = new Map<string, number>([['quartzbound_pickaxe', 0], ['gnawed_branch', 3]])
    const pending = pending_objectives([objective!], owned)
    const reserved = reserved_resources(seed_recipes, pending, owned)
    expect(reserved.has('gnawed_branch')).toBe(true)
    expect(reserved.has('quartz_honed_beak')).toBe(true)
  })

  test('the stale-mat trap is real: old_hoe and basic_pickaxe both eat gnawed_branch', () => {
    for (const thief of ['old_hoe', 'basic_pickaxe']) {
      const recipe = recipe_of_list(seed_recipes, thief)
      expect(recipe).toBeDefined()
      expect(recipe!.inputs).toHaveProperty('gnawed_branch')
      expect(recipe_job(thief)).toBe('HANDYMAN')
    }
    // the honed beak feeds the pickaxe and is craftable (CARVER) without touching the reserved mats
    const beak_recipe = recipe_of_list(seed_recipes, 'quartz_honed_beak')
    expect(recipe_job('quartz_honed_beak')).toBe('CARVER')
    expect(beak_recipe!.inputs).not.toHaveProperty('gnawed_branch')
    expect(beak_recipe!.inputs).toHaveProperty('quartz')
  })

  test('the beaks demanded by the pickaxe come from gathered quartz + a thebes drop (no extra farm)', () => {
    const beak_recipe = recipe_of_list(seed_recipes, 'quartz_honed_beak')!
    const required = craft_required_level(Object.keys(beak_recipe.inputs).length)
    expect(required).toBeGreaterThanOrEqual(1)
    // quartz + wheat (flour) are gatherable; beak_shard is a thebes lorito drop — the exact same
    // city detour the gnawed_branch objective already triggers, so the beaks never force a raid.
    expect(Object.keys(beak_recipe.inputs).sort()).toEqual(['beak_shard', 'quartz', 'wheat_flour'])
    expect([...item_drop_cities('beak_shard').keys()]).toContain('thebes')
  })
})