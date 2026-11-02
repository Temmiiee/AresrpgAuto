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
  craft_required_level,
  equipment_slot_accepts,
  item_stat_center,
  job_level_from_xp,
  stat_names,
  weapon_categories,
  type CharacterEquipmentSlot,
} from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'
import type { SeedItem } from '@aresrpg/sdk/seed'

import { items, items_by_type, loot_sources_by_item, recipe_job, recipes, recipes_by_output } from '../content/catalog.ts'
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

/** Wearables with an authored mob-drop source. Some also have recipes: those are valid fallback
 *  routes when the team has not unlocked the craft yet, or the drop is a better reachable upgrade.
 *  Tools, pets and relics are deliberately handled elsewhere. `job` is empty because a drop has no
 *  crafting gate. */
export const gear_drop_candidates: readonly GearCandidate[] = Object.freeze(
  items.flatMap((seed_item) => {
    if (!GEAR_CATEGORIES.has(seed_item.category)) return []
    if ((loot_sources_by_item.get(seed_item.item_type)?.length ?? 0) === 0) return []
    return [
      Object.freeze({
        output_type: seed_item.item_type,
        job: '',
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
  candidates: readonly GearCandidate[] = gear_candidates,
  loot_team_size = 1
): GearGoal | null => {
  const affinity = character_affinity(character)
  const base_chance = Math.max(0, Number(character.chance ?? 0))
  const current_score = current ? item_power(current, affinity, base_chance, loot_team_size) : Number.NEGATIVE_INFINITY
  let best: GearCandidate | null = null
  let best_score = current_score
  for (const candidate of candidates) {
    if (candidate.level > character.level) continue
    if (!equipment_slot_accepts(slot, candidate.category)) continue
    // Keeping the piece already worn is always allowed, so re-proposing it is not a goal.
    if (current && candidate.item.item_type === current.item_type) continue
    const score = item_power(candidate.item, affinity, base_chance, loot_team_size)
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
 *  craftable item actually beats what that character could wear today.
 *
 *  Held equipment is allocated in the same leader-first order as {@link auto_equip_party}: once one
 *  character claims a kiosk item, the next character plans without it. Merely holding an output type
 *  is NOT enough to suppress a goal. A bad roll may lose to the currently worn piece, and one good
 *  copy cannot equip two characters; both cases still need another craft. */
export const plan_gear_goals = (
  characters: readonly CharacterRow[],
  state: GameState,
  candidates: readonly GearCandidate[] = gear_candidates
): readonly GearGoal[] => {
  const goals: GearGoal[] = []
  const claimed = new Set<string>()
  const loot_team_size = Math.max(1, characters.length)
  for (const character of characters) {
    const loadout = plan_loadout(character, state, { claimed, loot_team_size })
    for (const item of loadout.values()) claimed.add(item.id)
    for (const slot of GEAR_GOAL_SLOTS) {
      const goal = plan_slot_goal(character, slot, loadout.get(slot) ?? null, candidates, loot_team_size)
      if (!goal) continue
      goals.push(goal)
    }
  }
  return Object.freeze(goals.sort((left, right) => right.gain - left.gain))
}

/** A staged gear route: first return every upgrade whose recipe job is already leveled somewhere
 *  in the team; then expose only the closest job-unlock step. A much stronger but distant recipe
 *  cannot monopolize craft training while nearer upgrades are available. */
export const plan_gear_craft_steps = (
  characters: readonly CharacterRow[],
  state: GameState
): readonly GearGoal[] => {
  if (characters.length === 0) return []
  const job_level = (job: string): number =>
    Math.max(0, ...characters.map((character) => job_level_from_xp(Number(character.jobs?.[job] ?? '0'))))
  const required = (candidate: GearCandidate): number => {
    const recipe = recipes_by_output[candidate.output_type]
    return recipe ? craft_required_level(Object.keys(recipe.inputs).length) : Number.POSITIVE_INFINITY
  }
  const available = gear_candidates.filter((candidate) => job_level(candidate.job) >= required(candidate))
  const ready = plan_gear_goals(characters, state, available)
  const ready_slots = new Set(ready.map((goal) => `${goal.character_id}\u0000${goal.slot}`))
  const next: { goal: GearGoal; gap: number }[] = []
  for (const character of characters) {
    const loadout = plan_loadout(character, state, { loot_team_size: characters.length })
    for (const slot of GEAR_GOAL_SLOTS) {
      if (ready_slots.has(`${character.id}\u0000${slot}`)) continue
      const current = loadout.get(slot) ?? null
      const legal = gear_candidates.filter(
        (candidate) => candidate.level <= character.level && equipment_slot_accepts(slot, candidate.category)
      )
      const gaps = [...new Set(
        legal.map((candidate) => Math.max(0, required(candidate) - job_level(candidate.job)))
      )].filter((gap) => gap > 0).sort((left, right) => left - right)
      for (const gap of gaps) {
        const step_candidates = legal.filter(
          (candidate) => Math.max(0, required(candidate) - job_level(candidate.job)) === gap
        )
        const goal = plan_slot_goal(character, slot, current, step_candidates, characters.length)
        if (goal) {
          next.push({ goal, gap })
          break
        }
      }
    }
  }
  next.sort((left, right) => left.gap - right.gap || right.goal.gain - left.goal.gain)
  const staged = [...ready]
  if (next[0]) staged.push(next[0].goal)
  return Object.freeze(staged)
}

/** The deduped, gain-ordered output types the craft planner should try FIRST. This is the whole
 *  consumer surface for the play loop; the per-character detail stays here. */
export const gear_goal_outputs = (
  characters: readonly CharacterRow[],
  state: GameState,
  candidates: readonly GearCandidate[] = gear_candidates
): readonly string[] =>
  Object.freeze(
    [...new Set(
      (candidates === gear_candidates ? plan_gear_craft_steps(characters, state) : plan_gear_goals(characters, state, candidates))
        .map((goal) => goal.output_type)
    )]
  )
