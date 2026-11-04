// Daily pet maintenance. Move permits one feed per pet per UTC day and caps power at 60. The
// planner reads only the live projection; the effect uses the SDK's atomic worn-pet composition so
// automatic equipment never observes a temporarily naked slot.
import { pet_max_feeds } from '@aresrpg/immutable'
import type { CharacterRow, ItemRow } from '@aresrpg/protocol'

import { items_by_type, recipes_by_output, worlds } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { chain_now, freshness, select_character, unavailable_item_ids } from '../state/selectors.ts'
import type { GameState } from '../state/store.ts'
import { custody_of, type ActionContext } from './context.ts'
import { verify_equip_ownership } from './equip_guard.ts'

const DAY_MS = 86_400_000

/** Only resources authored into a shipped world can roll their gathering rare. The immutable
 *  catalog already contains future tiers 7..11, but worlds.json currently stops at tier 6. */
const available_rare_sources: ReadonlyMap<string, string> = (() => {
  const sources = new Map<string, string>()
  for (const world of worlds)
    for (const resource of world.resources)
      if (resource.rare_item_type) sources.set(resource.rare_item_type, resource.item_type)
  return sources
})()

const food_types = (pet: Readonly<Pick<ItemRow, 'item_type'>>): readonly string[] =>
  items_by_type[pet.item_type]?.pet_foods ?? []

const held_amount = (state: GameState, item_type: string): number => {
  const unavailable = unavailable_item_ids(state)
  return state.inventory.reduce(
    (total, item) => total + (item.item_type === item_type && !unavailable.has(item.id) ? Number(item.amount) : 0),
    0
  )
}

/** True only when every ingredient can still be supplied: either it is already held or its base
 *  resource really exists in a shipped world. Pet-food recipes are exact three-rare triads. */
export const pet_food_is_supplyable = (state: GameState, food_type: string): boolean => {
  const recipe = recipes_by_output[food_type]
  if (!recipe) return false
  return Object.entries(recipe.inputs).every(
    ([ingredient, quantity]) => held_amount(state, ingredient) >= quantity || available_rare_sources.has(ingredient)
  )
}

/** Food recipes still useful to the owned, not-fully-fed pets. One unit per pet is enough stock:
 *  the daily chain limit prevents consuming a larger reserve in the same maintenance pass. */
export const pet_food_goals = (state: GameState): readonly string[] => {
  const need = new Map<string, number>()
  for (const pet of state.inventory) {
    if (pet.category !== 'pet' || (pet.pet_power ?? 0) >= pet_max_feeds) continue
    for (const food of food_types(pet)) need.set(food, (need.get(food) ?? 0) + 1)
  }
  return Object.freeze(
    [...need].flatMap(([food, count]) =>
      recipes_by_output[food] && held_amount(state, food) < count && pet_food_is_supplyable(state, food) ? [food] : []
    )
  )
}

/** Owned pet foods that cannot currently be farmed or crafted from the shipped worlds. Existing
 *  food is intentionally accepted: crates or legacy stock may still be consumed safely. */
export const unavailable_pet_foods = (state: GameState): readonly string[] => {
  const blocked = new Set<string>()
  for (const pet of state.inventory) {
    if (pet.category !== 'pet' || (pet.pet_power ?? 0) >= pet_max_feeds) continue
    for (const food of food_types(pet))
      if (held_amount(state, food) === 0 && !pet_food_is_supplyable(state, food)) blocked.add(food)
  }
  return Object.freeze([...blocked].sort())
}

/** Translate a missing rare pet-food ingredient back to the resource pack that rolls it. This is
 *  what makes gatherers actively chase moonfire/arcanite ingredients instead of waiting for a rare
 *  jackpot from unrelated harvesting. Normal tier/tool gates still apply in gather_once. */
export const pet_food_gather_demand = (state: GameState): ReadonlyMap<string, number> => {
  const demand = new Map<string, number>()
  for (const food of pet_food_goals(state)) {
    const recipe = recipes_by_output[food]
    if (!recipe) continue
    for (const [ingredient, quantity] of Object.entries(recipe.inputs)) {
      if (held_amount(state, ingredient) >= quantity) continue
      const source = available_rare_sources.get(ingredient)
      if (source) demand.set(source, (demand.get(source) ?? 0) + quantity)
    }
  }
  return demand
}

export type PetFeedOutcome = Readonly<{ fed: boolean; pet_type?: string; food_type?: string }>

/** Feed at most one pet. The session invokes this repeatedly while idle, so four pets become four
 *  serialized transactions without holding the play loop or reusing a stale food object. */
export const feed_pet_once = async (
  ctx: ActionContext,
  fed_today: Set<string>,
  food_spent: Map<string, number>
): Promise<PetFeedOutcome> => {
  const state = ctx.state()
  const now = chain_now(state.chain_clock, Date.now())
  if (now === null || !freshness(state, Date.now()).ok) return Object.freeze({ fed: false })
  const day = Math.floor(now / DAY_MS)
  const unavailable = unavailable_item_ids(state)
  const worn_by = new Map<string, CharacterRow>()
  for (const character of state.characters)
    for (const worn of character.equipment) if (worn.slot === 'pet') worn_by.set(worn.id, character)

  const candidates = state.inventory
    .filter((item) => item.category === 'pet')
    .filter((item) => (item.pet_power ?? 0) < pet_max_feeds)
    .filter((item) => (item.pet_last_day ?? -1) < day)
    .filter((item) => !fed_today.has(`${day}:${item.id}`))
    .sort((left, right) => (left.pet_power ?? 0) - (right.pet_power ?? 0) || left.id.localeCompare(right.id))

  for (const pet of candidates) {
    const food_type = food_types(pet).find((type) =>
      state.inventory.some((item) => {
        const snapshot = `${item.id}:${item.version ?? `amount-${item.amount}`}`
        return item.item_type === type && !unavailable.has(item.id) && Number(item.amount) > (food_spent.get(snapshot) ?? 0)
      })
    )
    if (!food_type) continue
    const food = state.inventory.find((item) => {
      const snapshot = `${item.id}:${item.version ?? `amount-${item.amount}`}`
      return item.item_type === food_type && !unavailable.has(item.id) && Number(item.amount) > (food_spent.get(snapshot) ?? 0)
    })
    if (!food) continue
    const wearer = worn_by.get(pet.id)
    const actor = wearer ?? select_character(state, ctx.character_id)
    if (!actor || actor.active_fight || actor.custody === 'fight') continue

    try {
      let receipt: Awaited<ReturnType<typeof ctx.sdk.character.feed_pet>>
      if (wearer) {
        const verdict = await verify_equip_ownership(ctx, wearer.id, [], [{ slot: 'pet', item_id: pet.id }])
        if (!verdict.ok) continue
        receipt = await ctx.sdk.character.feed_equipped_pet({
          character_id: wearer.id,
          pet_id: pet.id,
          pet_item_type: pet.item_type,
          food_id: food.id,
          custody: custody_of(wearer),
        })
      } else {
        receipt = await ctx.sdk.character.feed_pet({
          pet_id: pet.id,
          pet_item_type: pet.item_type,
          food_id: food.id,
          custody: custody_of(actor),
        })
      }
      fed_today.add(`${day}:${pet.id}`)
      const food_snapshot = `${food.id}:${food.version ?? `amount-${food.amount}`}`
      food_spent.set(food_snapshot, (food_spent.get(food_snapshot) ?? 0) + 1)
      ctx.ledger.append({
        kind: 'pet_feed',
        digest: receipt.digest,
        detail: { pet: pet.item_type, food: food_type, power: (pet.pet_power ?? 0) + 1, day },
      })
      log_info('pet', `fed ${pet.item_type} with ${food_type} (${(pet.pet_power ?? 0) + 1}/${pet_max_feeds})`)
      return Object.freeze({ fed: true, pet_type: pet.item_type, food_type })
    } catch (error) {
      log_warn('pet', `${pet.item_type}: ${error instanceof Error ? error.message : String(error)}`)
      return Object.freeze({ fed: false })
    }
  }
  return Object.freeze({ fed: false })
}
