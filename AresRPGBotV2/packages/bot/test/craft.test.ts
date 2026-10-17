// craft tests – the recipe planner owns craftability; a plan is built only from held facts.
import { item_is_stackable, job_xp_for_level } from '@aresrpg/immutable'

import { craft_once, craft_gather_demand, plan_recipe, drive_craft, select_craft_target } from '../src/actions/craft.ts'
import { rank_gather_candidates } from '../src/actions/gather.ts'
import { gatherable_demand, items_by_type, recipe_detail, recipes_by_output } from '../src/content/catalog.ts'

describe('craft actions type check', () => {
  it('exposes the planner and the craft doors', () => {
    expect(typeof plan_recipe).toBe('function')
    expect(typeof craft_once).toBe('function')
    expect(typeof drive_craft).toBe('function')
  })
})

const character_for = (job: string): never =>
  ({ id: 'c', jobs: { [job]: String(job_xp_for_level(15) ?? 0) } }) as never

const inventory_for = (detail: ReturnType<typeof recipe_detail>, held_output: boolean): readonly any[] => {
  const rows: any[] = []
  if (held_output)
    rows.push({
      id: 'held-output',
      item_type: detail.output_type,
      amount: 3,
      category: items_by_type[detail.output_type]?.category ?? '',
    })
  detail.ingredients.forEach((ingredient, index) =>
    rows.push({ id: `in-${index}`, item_type: ingredient.item_type, amount: ingredient.quantity * 5, category: 'resource' })
  )
  return rows
}

describe('plan_recipe output target', () => {
  it('never offers an output target for a non-stackable output (regression: abort 2323)', () => {
    const detail = recipe_detail(recipes_by_output['rootshivs']!)
    expect(item_is_stackable(items_by_type[detail.output_type]?.category ?? '')).toBe(false)
    const plan = plan_recipe(character_for(detail.job), detail, inventory_for(detail, true), new Set())
    expect(plan).not.toBeNull()
    expect(plan!.attempts).toBe(1)
    expect(plan!.existing).toBeNull()
  })

  it('merges into the held stack for a stackable output', () => {
    const recipe = Object.values(recipes_by_output).find(
      (row) => item_is_stackable(items_by_type[row.output_type]?.category ?? '') && Object.keys(row.inputs).length <= 3
    )
    expect(recipe).toBeDefined()
    const detail = recipe_detail(recipe!)
    const plan = plan_recipe(character_for(detail.job), detail, inventory_for(detail, true), new Set())
    expect(plan).not.toBeNull()
    expect(plan!.existing).toBe('held-output')
  })
})

describe('craft drive_craft', () => {
  it('reports nothing craftable when the roster is empty', async () => {
    const ctx: any = {
      state: () => ({ characters: [], inventory: [] }),
      character_id: 'test-char',
    }
    const result = await drive_craft(ctx)
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('nothing_craftable')
  })
})

// recipe-driven gathering — the loop the bot was missing. `plan_recipe` can only propose what the
// inventory already holds, so a trade with nothing held fell through the rotation forever; these
// pin the demand derivation that closes the gap from the other side.
describe('gatherable_demand', () => {
  it('expands a craft through its intermediates down to the gatherable leaves', () => {
    // quartz_set_trinket <- shiny_trinket (a mob drop, never gathered) + quartz_powder + barley_flour;
    // quartz_powder <- quartz x2, barley_flour <- wheat_barley x2 + wheat x2.
    const demand = gatherable_demand('quartz_set_trinket')
    expect(demand.get('quartz')).toBe(2)
    expect(demand.get('wheat_barley')).toBe(2)
    expect(demand.get('wheat')).toBe(2)
    expect(demand.has('shiny_trinket')).toBe(false)
    expect(demand.has('water')).toBe(false)
  })

  it('counts the multiplied quantity of a deeper chain', () => {
    // rootglass_token <- mushroom_lacquer + quartz_powder x10 -> quartz x20, green_mushroom x2
    const demand = gatherable_demand('rootglass_token')
    expect(demand.get('quartz')).toBe(20)
    expect(demand.get('green_mushroom')).toBe(2)
  })

  it('reports no leaves for a leaf and for a pure mob drop', () => {
    expect(gatherable_demand('wheat').size).toBe(0)
    expect(gatherable_demand('shiny_trinket').size).toBe(0)
  })

  it('walks each output once', () => {
    expect(gatherable_demand('quartz_set_trinket')).toBe(gatherable_demand('quartz_set_trinket'))
  })

  it('resolves a dungeon key down to its gatherable leaves', () => {
    expect([...gatherable_demand('key_of_gilded_lorito').keys()].sort()).toEqual([
      'amber',
      'quartz',
      'wheat',
      'wheat_barley',
    ])
  })
})

describe('craft_gather_demand', () => {
  const crafter = (jobs: Record<string, number>): any =>
    ({
      id: 'c',
      name: 'c',
      jobs: Object.fromEntries(Object.entries(jobs).map(([job, level]) => [job, String(job_xp_for_level(level))])),
    }) as any

  it('demands the tier-1 staples the stalled trades were missing', () => {
    // omori as shipped: FAR:1 HER:60 MIN:1 JEW:1 BAK:3 HAN:4 — none of those could craft, because
    // nothing ever gathered the staples their recipes resolve to.
    const omori = crafter({ FARMER: 1, HERBALIST: 60, MINER: 1, JEWELER: 1, BAKER: 3, HANDYMAN: 4 })
    const demand = craft_gather_demand(omori, [], new Set())
    expect(demand.has('wheat')).toBe(true) // FARMER flour chain, and the BAKER flour it feeds
    expect(demand.has('quartz')).toBe(true) // MINER powders, and the JEWELER settings they feed
    expect(demand.has('green_mushroom')).toBe(true) // HERBALIST powder
    expect(demand.has('water')).toBe(false) // drops from mobs; not something a gather can aim at
    expect(demand.has('shiny_trinket')).toBe(false)
  })

  it('ranks the universal staple above the narrow one, not by tier', () => {
    const omori = crafter({ FARMER: 1, HERBALIST: 60, MINER: 1, JEWELER: 1, BAKER: 3, HANDYMAN: 4 })
    const demand = craft_gather_demand(omori, [], new Set())
    // wheat feeds the flour chain AND a dozen low-tier TAILOR/JEWELER recipes; wheat_barley only the
    // chain. Tier alone would send a FARMER to the T2 barley and starve the T1 wheat again.
    expect(demand.get('wheat')!).toBeGreaterThan(demand.get('wheat_barley')!)
  })

  it('hands priority back once the stock reaches the line', () => {
    const omori = crafter({ FARMER: 1, MINER: 1 })
    const stocked = [{ id: 'w', item_type: 'wheat', amount: 200, category: 'resource' }] as any[]
    const demand = craft_gather_demand(omori, stocked, new Set())
    expect(demand.has('wheat')).toBe(false)
    expect(demand.has('quartz')).toBe(true)
  })

  it('treats a worn (unavailable) stack as not held', () => {
    const omori = crafter({ FARMER: 1 })
    const worn = [{ id: 'w', item_type: 'wheat', amount: 200, category: 'resource' }] as any[]
    expect(craft_gather_demand(omori, worn, new Set()).has('wheat')).toBe(false)
    expect(craft_gather_demand(omori, worn, new Set(['w'])).has('wheat')).toBe(true)
  })

  it('folds dungeon-key materials into the demand', () => {
    const omori = crafter({ FARMER: 1, MINER: 1, HANDYMAN: 4 })
    const without_keys = craft_gather_demand(omori, [], new Set())
    const with_keys = craft_gather_demand(omori, [], new Set(), ['key_of_gilded_lorito'])
    // the key chain needs amber (through amber_powder), so its leverage rises while it is demanded
    expect(with_keys.get('amber')!).toBeGreaterThan(without_keys.get('amber')!)
  })
})

describe('rank_gather_candidates', () => {
  const pack = (item_type: string, tier: number, x = 0, z = 0): any => ({
    pack: { item_type, x, z, index: 0 },
    gatherable: { item_type, job: 'FARMER', tier, protector: 'p', rare_item_type: 'r' },
  })

  it('sends a demanded tier-1 staple ahead of an undemanded tier-3 pack', () => {
    const ranked = rank_gather_candidates([pack('ivory_shrooms', 3), pack('wheat', 1)], new Map([['wheat', 5]]), {
      x: 0,
      z: 0,
    })
    expect(ranked[0]!.pack.item_type).toBe('wheat')
  })

  it('prefers the higher demand score, then the higher tier, then the nearer pack', () => {
    const pose = { x: 0, z: 0 }
    expect(
      rank_gather_candidates([pack('a', 1), pack('b', 1)], new Map([['a', 3], ['b', 9]]), pose)[0]!.pack.item_type
    ).toBe('b')
    expect(rank_gather_candidates([pack('a', 1), pack('b', 3)], undefined, pose)[0]!.pack.item_type).toBe('b')
    expect(rank_gather_candidates([pack('a', 2, 9, 0), pack('b', 2, 1, 0)], undefined, pose)[0]!.pack.item_type).toBe('b')
  })

  it('keeps the shipped tier order when nothing is demanded', () => {
    const ranked = rank_gather_candidates([pack('low', 1), pack('high', 4)], new Map(), { x: 0, z: 0 })
    expect(ranked.map((row) => row.pack.item_type)).toEqual(['high', 'low'])
  })
})

// The gap this closes: a trade whose recipes are built from intermediates (FARMER flour, MINER
// quartz_powder, HERBALIST green_mushroom_powder) never progressed, because the rotation only lists
// the crafting jobs and nothing ever made the intervening refinement. The planner must now walk the
// chain and craft the missing prerequisite first.
describe('select_craft_target prerequisites', () => {
  const ctx_for = (jobs: Record<string, number>, inventory: readonly (readonly [string, number])[]): any => {
    const state = {
      characters: [
        {
          id: 'c',
          jobs: Object.fromEntries(
            Object.entries(jobs).map(([job, level]) => [job, String(job_xp_for_level(level) ?? 0)])
          ),
          equipment: [],
        },
      ],
      inventory: inventory.map(([item_type, amount], index) => ({
        id: `i${index}`,
        item_type,
        amount,
        category: 'resource',
      })),
      listings: [],
    }
    return { state: () => state, character_id: 'c' }
  }

  it('refines an intermediate instead of reporting nothing craftable', () => {
    // No trade recipe can fire from raw staples alone, but their chains resolve to these leaves.
    const plan = select_craft_target(ctx_for({}, [['green_mushroom', 10], ['water', 10], ['quartz', 10]]))
    expect(plan).not.toBeNull()
    expect(['FARMER', 'HERBALIST', 'MINER']).toContain(plan!.job)
  })

  it('walks the chain: the powder first, then the intermediate that eats it', () => {
    const powder = select_craft_target(ctx_for({}, [['green_mushroom', 10], ['water', 10]]))
    expect(powder?.output_type).toBe('green_mushroom_powder')
    // Once the refinement is held, the very next step is the ALCHEMIST intermediate built from it.
    const lacquer = select_craft_target(
      ctx_for({}, [
        ['green_mushroom', 10],
        ['water', 10],
        ['green_mushroom_powder', 10],
        ['tree_resin', 10],
      ])
    )
    expect(lacquer?.output_type).toBe('mushroom_lacquer')
  })

  it('still crafts a directly affordable trade recipe first', () => {
    const plan = select_craft_target(ctx_for({}, [['gnawed_branch', 3], ['salvaged_scrap', 2]]))
    expect(plan?.output_type).toBe('old_hoe')
    expect(plan?.job).toBe('HANDYMAN')
  })

  it('drops a recipe whose stacks an earlier batch already burned this chore', () => {
    // The projection lags the confirmed craft, so without the burned set a second batch reuses the
    // same ingredient ids and aborts `kiosk::borrow`. Excluding them must fall through to nothing.
    const ctx = ctx_for({}, [['gnawed_branch', 3], ['salvaged_scrap', 2]])
    const plan = select_craft_target(ctx)
    expect(plan?.output_type).toBe('old_hoe')
    expect(select_craft_target(ctx, new Set(plan!.input_item_ids))).toBeNull()
  })
})
