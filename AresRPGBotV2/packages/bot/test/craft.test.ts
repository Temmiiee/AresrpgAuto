// craft tests – the recipe planner owns craftability; a plan is built only from held facts.
import { item_is_stackable, job_xp_for_level } from '@aresrpg/immutable'

import { craft_once, plan_recipe, drive_craft } from '../src/actions/craft.ts'
import { items_by_type, recipe_detail, recipes_by_output } from '../src/content/catalog.ts'

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
