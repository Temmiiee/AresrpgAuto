// Gear-craft goals — the craft loop's answer to "what should we MAKE next", for equipment.
//
// The xp rotation in `craft.ts` picks the highest-XP affordable recipe, so it mints whatever levels the
// trades fastest and only incidentally produces wearable pieces, with no idea which of a sword / dagger
// / axe / earth-hat is an UPGRADE for a given character. Nothing ever asked that question. This module
// does, and it scores candidates with the SAME rune-weight math auto-equip uses (`equip.ts`), so the
// two halves of the loop agree on what "best" means. That closes the loop:
//
//   gather (recipe demand, `craft.ts`) → craft (these goals win the pass) → auto-equip (`equip.ts`)
//
// It is PURE and read-only: it reads the seed catalog + the live projection and returns target output
// types. The craft planner tries those first; the xp rotation remains the fallback, so the bot still
// levels its trades when no upgrade is within reach.
import {
  equipment_slot_accepts,
  item_stat_center,
  stat_names,
  weapon_categories,
  type CharacterEquipmentSlot,
} from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'
import type { SeedItem } from '@aresrpg/sdk/seed'

import { items_by_type, recipe_job, recipes } from '../content/catalog.ts'
import { unavailable_item_ids } from '../state/selectors.ts'
import type { GameState } from '../state/store.ts'

import { character_affinity, item_power, plan_loadout, type GearItem } from './equip.ts'

/** The slots a gear goal may fill. Weapons share one slot; the two ring slots are scored separately so
 *  the WEAKER hand is the one upgraded. Tools are a gathering concern (`gather.ensure_tool`), cosmetics
 *  are presentation, and relics/titles/pets have no authored recipe in the seed — none of them belong
 *  in a craft goal. */
const GEAR_GOAL_SLOTS: readonly CharacterEquipmentSlot[] = Object.freeze([
  'weapon',
  'hat',
  'cloak',
  'belt',
  'boots',
  'amulet',
  'left_ring',
  'right_ring',
] as const)

/** Every equipment category the party can CRAFT a wearable from. */
const GEAR_CATEGORIES: ReadonlySet<string> = new Set<string>([
  ...weapon_categories,
  'hat',
  'cloak',
  'belt',
  'boots',
  'amulet',
  'ring',
])

/** The minimum score a craftable target must beat the current piece by to be worth the materials.
 *  One rune-weight point is the smallest meaningful unit; anything less is a sidegrade. */
const GEAR_MIN_GAIN = 1

/** A seed item's expected roll as a scoreable `GearItem`: the chain stores raw centered u16 stats
 *  (`item_stat_center` = neutral) while the seed authors a SIGNED min/max offset per stat, so the
 *  expected encoded value is the midpoint of the authored range (+ center). Weapon damage lines are
 *  already absolute. Used only to RANK craftable targets — the real item scores itself once minted. */
export const expected_gear = (item: SeedItem): GearItem => {
  const stats = item.stats
    ? (Object.fromEntries(
        stat_names.map((stat) => [stat, item_stat_center + (item.stats!.min[stat] + item.stats!.max[stat]) / 2])
      ) as Record<string, number>)
    : undefined
  return {
    id: item.item_type,
    item_type: item.item_type,
    category: item.category,
    level: item.level,
    stats,
    damages: item.damages as GearItem['damages'],
    pet_power: undefined,
  }
}

export type GearCandidate = Readonly<{
  output_type: string
  job: string
  category: string
  level: number
  item: GearItem
}>

/** Every craftable wearable in the seed, ready to score. Built once at module load. */
export const gear_candidates: readonly GearCandidate[] = Object.freeze(
  recipes.flatMap((recipe) => {
    const seed_item = items_by_type[recipe.output_type]
    if (!seed_item || !GEAR_CATEGORIES.has(seed_item.category)) return []
    return [
      Object.freeze({
        output_type: recipe.output_type,
        job: recipe_job(recipe),
        category: seed_item.category,
        level: seed_item.level,
        item: expected_gear(seed_item),
      }),
    ]
  })
)

export type GearGoal = Readonly<{
  output_type: string
  job: string
  slot: CharacterEquipmentSlot
  level: number
  /** the expected rune-weight score of the craftable target for this character */
  score: number
  /** how far it beats what the character could wear today (the whole expected score when bare) */
  gain: number
  character_id: string
  character_name: string
}>

/** The best CRAFTABLE item for one slot that beats what this character could wear today, or null.
 *  `current` is the character's best available piece for the slot (worn or held); `candidates` defaults
 *  to the whole seed but is injectable so the selection is unit-testable without touching the catalog. */
export const plan_slot_goal = (
  character: CharacterRow,
  slot: CharacterEquipmentSlot,
  current: GearItem | null,
  candidates: readonly GearCandidate[] = gear_candidates
): GearGoal | null => {
  const affinity = character_affinity(character)
  const current_score = current ? item_power(current, affinity) : Number.NEGATIVE_INFINITY
  let best: GearCandidate | null = null
  let best_score = current_score
  for (const candidate of candidates) {
    if (candidate.level > character.level) continue
    if (!equipment_slot_accepts(slot, candidate.category)) continue
    // Keeping the piece already worn is always allowed, so re-proposing it is not a goal.
    if (current && candidate.item.item_type === current.item_type) continue
    const score = item_power(candidate.item, affinity)
    if (score > best_score) {
      best = candidate
      best_score = score
    }
  }
  if (!best || best_score < current_score + GEAR_MIN_GAIN) return null
  return Object.freeze({
    output_type: best.output_type,
    job: best.job,
    slot,
    level: best.level,
    score: best_score,
    gain: Number.isFinite(current_score) ? best_score - current_score : best_score,
    character_id: character.id,
    character_name: character.name,
  })
}

/** The party's craftable gear upgrades, biggest gain first. One goal per (character, slot) where a
 *  craftable item actually beats what that character could wear today. Output types the party already
 *  holds UN-EQUIPPED are dropped: auto-equip places those, so a second craft is pure waste. */
export const plan_gear_goals = (
  characters: readonly CharacterRow[],
  state: GameState,
  candidates: readonly GearCandidate[] = gear_candidates
): readonly GearGoal[] => {
  const unavailable = unavailable_item_ids(state)
  const held_available = new Set<string>()
  for (const item of state.inventory) if (!unavailable.has(item.id)) held_available.add(item.item_type)

  const goals: GearGoal[] = []
  for (const character of characters) {
    const loadout = plan_loadout(character, state)
    for (const slot of GEAR_GOAL_SLOTS) {
      const goal = plan_slot_goal(character, slot, loadout.get(slot) ?? null, candidates)
      if (!goal || held_available.has(goal.output_type)) continue
      goals.push(goal)
    }
  }
  return Object.freeze(goals.sort((left, right) => right.gain - left.gain))
}

/** The deduped, gain-ordered output types the craft planner should try FIRST. This is the whole
 *  consumer surface for the play loop; the per-character detail stays here. */
export const gear_goal_outputs = (
  characters: readonly CharacterRow[],
  state: GameState,
  candidates: readonly GearCandidate[] = gear_candidates
): readonly string[] =>
  Object.freeze([...new Set(plan_gear_goals(characters, state, candidates).map((goal) => goal.output_type))])
