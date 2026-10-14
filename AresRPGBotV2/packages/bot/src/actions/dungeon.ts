// Dungeon runner: craft keys → start runs → repeat.
// Thebes (gilded_lorito) is the entry dungeon at distance ~480 from centre — low level, farmable.
import { job_recipes, recipe_detail, recipes_by_output, type RecipeDetail } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { select_character, unavailable_item_ids } from '../state/selectors.ts'
import { custody_of, type ActionContext } from './context.ts'
import { plan_recipe, craft_once, type CraftPlan } from './craft.ts'
import type { CharacterRow } from '@aresrpg/protocol'
import type { ItemRow } from '@aresrpg/protocol'

/** Dungeon key recipes we care about. Each has: output item, ingredients, source city. */
export interface DungeonKeyConfig {
  key: string
  dungeon: string
  city: string
  city_zone: { zx: number; zz: number }
  ingredients: Record<string, number>
  job: string
  difficulty: number
}

export const DUNGEON_KEYS: readonly DungeonKeyConfig[] = Object.freeze([
  {
    key: 'key_of_gilded_lorito',
    dungeon: 'gilded_lorito',
    city: 'thebes',
    city_zone: { zx: 1578, zz: 1562 },
    ingredients: { stone_lorito_plume: 2, quartz_set_trinket: 2 } as Record<string, number>,
    job: 'JEWELER',
    difficulty: 1,
  },
  {
    key: 'key_of_tangled_aftermath',
    dungeon: 'tangled_aftermath',
    city: 'the_ruins',
    city_zone: { zx: 1127, zz: 1521 },
    ingredients: { aragne_fang: 3, aragne_carapace: 2, embertide_webbing: 1 } as Record<string, number>,
    job: 'CARVER',
    difficulty: 2,
  },
  {
    key: 'key_of_ivory_rampart',
    dungeon: 'ivory_rampart',
    city: 'fuwage',
    city_zone: { zx: 445, zz: 709 },
    ingredients: { fuwa_horn: 1, fuwa_eye: 1, fuwa_fleece: 1, nifuwa_fleece: 1 } as Record<string, number>,
    job: 'TAILOR',
    difficulty: 3,
  },
])

/** Find the RecipeDetail for a dungeon key. */
export const dungeon_key_detail = (key: string): RecipeDetail | null => {
  const raw = recipes_by_output[key]
  if (!raw) return null
  return recipe_detail(raw)
}

/** Check if we can craft a dungeon key (all ingredients held). */
export const can_craft_key = (key: string, inventory: readonly ItemRow[], unavailable: ReadonlySet<string>): boolean => {
  const detail = dungeon_key_detail(key)
  if (!detail) return false
  for (const ing of detail.ingredients) {
    const held = inventory.find((item) => item.item_type === ing.item_type && !unavailable.has(item.id))
    if (!held || held.amount < ing.quantity) return false
  }
  return true
}

/** Plan and craft a dungeon key if ingredients are available. Returns true if crafted. */
export const maybe_craft_dungeon_key = async (ctx: ActionContext): Promise<boolean> => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character) return false
  const inventory = state.inventory
  const unavailable = unavailable_item_ids(state)
  // Shared blacklist from dungeon runner (keys previewed as unwinnable)
  const blacklist = (ctx as any).dungeon_blacklist ?? new Set<string>()

  for (const dk of DUNGEON_KEYS) {
    if (blacklist.has(dk.key)) continue
    const canCraft = can_craft_key(dk.key, inventory, unavailable)
    if (canCraft) {
      const detail = dungeon_key_detail(dk.key)!
      const plan = plan_recipe(character, detail, inventory, unavailable)
      if (!plan) {
        log_warn('dungeon', `${character.name}: plan_recipe failed for ${dk.key}`)
        return false
      }
      const result = await craft_once(ctx, plan)
      if (result.success) {
        log_info('dungeon', `crafted ${dk.key} for ${dk.dungeon}`)
        return true
      } else {
        log_warn('dungeon', `${character.name}: craft_once failed for ${dk.key}: ${result.outcome}`)
      }
    }
  }
  return false
}

/** Check if we hold any dungeon key. */
export const held_dungeon_key = (inventory: readonly ItemRow[], unavailable: ReadonlySet<string>): string | null => {
  for (const dk of DUNGEON_KEYS) {
    const held = inventory.find((item) => item.item_type === dk.key && !unavailable.has(item.id))
    if (held) return dk.key
  }
  return null
}

/** Check if a character should run dungeons (has appropriate job level). */
export const should_run_dungeons = (character: CharacterRow): boolean => {
  // omori runs all dungeons as part of crafting rotation
  return character.name.toLowerCase() === 'omori'
}