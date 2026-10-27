// Auto-equip — every character picks the best gear it can actually wear, from the party's ONE
// shared kiosk inventory, and swaps it in with a single PTB. There is no per-class equipment
// restriction on chain (`equipment.move` only gates slot, character level and duplicate relics), so
// "best for its class and stats" is a SCORING question, not a legality one.
//
// The score is the game's OWN item-budget unit: `rune_unit_weights` — the exact per-stat weights the
// chain's forge/rune math prices a roll with (the classic Dofus equivalences: 1 raw damage ≈ 20
// primary points, 1 AP = 100, 1 MP = 90, 1 range = 50, 1 crit = 30). An item's "power" is therefore
// comparable across categories, and the stat trade-offs are the game's own, not invented here.
//
// The four elemental stats are then re-weighted by the character's affinity: a fire caster's
// intelligence is worth its full rune weight while strength/chance/agility are worth nothing. The
// affinity blends the CLASS's authored kit (the elements its seed spells deal) with the stats the
// character has actually ALLOCATED, so "best for their class and stats" is one number.
import {
  combat_equipment_slots,
  equipment_slot_accepts,
  is_equipment_category,
  item_stat_center,
  pet_max_feeds,
  rune_unit_weights,
  stat_names,
  type CharacterEquipmentSlot,
  type StatName,
} from '@aresrpg/immutable'
import type { CharacterRow, ItemRow } from '@aresrpg/protocol'

import { spells } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { freshness, select_character, unavailable_item_ids } from '../state/selectors.ts'
import type { GameState } from '../state/store.ts'

import { custody_of, type ActionContext } from './context.ts'

// ── the elemental model ──────────────────────────────────────────────

const COMBAT_ELEMENTS = Object.freeze(['earth', 'fire', 'water', 'air'] as const)
type CombatElement = (typeof COMBAT_ELEMENTS)[number]

const is_combat_element = (value: string): value is CombatElement =>
  (COMBAT_ELEMENTS as readonly string[]).includes(value)

/** The characteristic that amplifies each element — the fight engine's own map; here as the inverse,
 *  so a stat's elemental scale can be looked up while scoring. */
const ELEMENT_OF_STAT: Readonly<Partial<Record<StatName, CombatElement>>> = Object.freeze({
  strength: 'earth',
  intelligence: 'fire',
  chance: 'water',
  agility: 'air',
})

export type ElementAffinity = Readonly<Record<CombatElement, number>>

const UNIFORM_AFFINITY: ElementAffinity = Object.freeze({ earth: 0.25, fire: 0.25, water: 0.25, air: 0.25 })

/** Per-class authored elemental profile, derived from the seed's spell book: the share of every
 *  elemental effect value each class's whole kit deals. A class whose damage is all fire gets
 *  `{ fire: 1, … }`; a class with no elemental effects falls back to a uniform split. */
const class_affinity: Readonly<Record<string, ElementAffinity>> = (() => {
  const totals = new Map<string, Record<CombatElement, number>>()
  for (const spell of spells) {
    let bucket = totals.get(spell.classe)
    if (!bucket) {
      bucket = { earth: 0, fire: 0, water: 0, air: 0 }
      totals.set(spell.classe, bucket)
    }
    for (const level of spell.levels)
      for (const effect of [...level.effects, ...level.crit_effects]) {
        if (!is_combat_element(effect.element)) continue
        const magnitude = (effect.value + Math.max(effect.value, effect.value_max)) / 2
        if (magnitude > 0) bucket[effect.element] += magnitude
      }
  }
  const out: Record<string, ElementAffinity> = {}
  for (const [classe, bucket] of totals) {
    const total = COMBAT_ELEMENTS.reduce((sum, element) => sum + bucket[element], 0)
    out[classe] =
      total > 0
        ? Object.freeze(
            Object.fromEntries(
              COMBAT_ELEMENTS.map((element) => [element, bucket[element] / total])
            ) as Record<CombatElement, number>
          )
        : UNIFORM_AFFINITY
  }
  return Object.freeze(out)
})()

/** The character's elemental profile: its class's authored kit blended 50/50 with the stats it has
 *  actually allocated. A fresh (unallocated) character is pure class affinity — which is what the
 *  seed kit says it will cast; an allocated warrior's own points pull its gear toward the element it
 *  actually amplifies. */
export const character_affinity = (character: CharacterRow): ElementAffinity => {
  const base = class_affinity[character.classe] ?? UNIFORM_AFFINITY
  const allocated: Record<CombatElement, number> = {
    earth: Math.max(0, Number(character.strength ?? 0)),
    fire: Math.max(0, Number(character.intelligence ?? 0)),
    water: Math.max(0, Number(character.chance ?? 0)),
    air: Math.max(0, Number(character.agility ?? 0)),
  }
  const allocated_total = COMBAT_ELEMENTS.reduce((sum, element) => sum + allocated[element], 0)
  if (allocated_total <= 0) return base
  const blended = Object.fromEntries(
    COMBAT_ELEMENTS.map((element) => [element, base[element] + allocated[element] / allocated_total])
  ) as Record<CombatElement, number>
  const total = COMBAT_ELEMENTS.reduce((sum, element) => sum + blended[element], 0)
  return Object.freeze(
    Object.fromEntries(COMBAT_ELEMENTS.map((element) => [element, blended[element] / total])) as Record<
      CombatElement,
      number
    >
  )
}

// ── item scoring ─────────────────────────────────────────────────────

/** The subset of a projected item the scorer reads — an `ItemRow`, but also a worn `EquippedItem`
 *  (which drops `kiosk`), so the same object can be scored whether held or already equipped. */
export type GearItem = Pick<ItemRow, 'id' | 'item_type' | 'category' | 'level' | 'stats' | 'damages' | 'pet_power'>

const SHIFT = item_stat_center

/** One item's SIGNED contribution to one stat. RAW centered u16 (32768 = neutral), and a PET
 *  contributes its POWER-scaled block exactly as the chain folds it (`api.move pet::scaled_stats`). */
export const item_stat_offset = (
  item: Readonly<Pick<GearItem, 'category' | 'stats' | 'pet_power'>>,
  stat: StatName
): number => {
  const offset = (item.stats?.[stat] ?? SHIFT) - SHIFT
  if (item.category !== 'pet') return offset
  const power = Math.min(pet_max_feeds, Math.max(0, item.pet_power ?? 0))
  return offset >= 0 ? Math.floor((offset * power) / pet_max_feeds) : -Math.floor((-offset * power) / pet_max_feeds)
}

/** A weapon's damage is its own channel: the rune budget prices one point of `raw_damage` at 20, and
 *  a weapon's base damage is amplified by the SAME primary stat, so one average damage point is
 *  scored like one raw-damage point. The element only gates the amplification, so an off-element
 *  weapon keeps half its weight instead of vanishing. */
const WEAPON_DAMAGE_WEIGHT = 20

/** The item's stat "power" in the game's own rune-weight unit, with the four elemental stats scaled
 *  by the character's affinity. Higher is simply better for this character. */
export const item_power = (item: GearItem, affinity: ElementAffinity): number => {
  let score = 0
  for (const stat of stat_names) {
    const value = item_stat_offset(item, stat)
    if (value === 0) continue
    const element = ELEMENT_OF_STAT[stat]
    const element_scale = element ? affinity[element] : 1
    if (element_scale <= 0) continue
    score += value * rune_unit_weights[stat] * element_scale
  }
  for (const line of item.damages ?? []) {
    if (!is_combat_element(line.element)) continue
    const average = (line.from + line.to) / 2
    score += average * WEAPON_DAMAGE_WEIGHT * (0.5 + 0.5 * affinity[line.element])
  }
  return score
}

// ── loadout planning ─────────────────────────────────────────────────

export type GearLoadout = ReadonlyMap<CharacterEquipmentSlot, GearItem>

export type PlanOptions = Readonly<{
  /** item ids already assigned to another character in this pass — never handed out twice */
  claimed?: ReadonlySet<string>
  /** the tool category this character's gathering chore needs, so auto-equip does not pull the wrong
   *  job's tool and force the gather step to swap it back every beat */
  tool_category?: string
}>

/** The best gear `character` can actually wear right now, one item per slot. Pure: it reads the
 *  projection and returns a map, committing nothing. Rules enforced, one for one with
 *  `equipment.move`: the slot must accept the category (`equipment_slot_accepts`), the item's level
 *  must not exceed the character's, and two relic slots may not hold the same item TYPE
 *  (`ERelicDuplicate`). Items listed on the market or worn by ANOTHER character are excluded; the
 *  character's own worn items stay candidates so keeping the current piece is always allowed. */
export const plan_loadout = (
  character: CharacterRow,
  state: GameState,
  options: PlanOptions = {}
): GearLoadout => {
  const claimed = options.claimed ?? new Set<string>()
  const affinity = character_affinity(character)

  const blocked = new Set(unavailable_item_ids(state))
  for (const worn of character.equipment) blocked.delete(worn.id)

  const pool: GearItem[] = []
  for (const item of state.inventory) {
    if (blocked.has(item.id) || claimed.has(item.id)) continue
    if (!is_equipment_category(item.category)) continue
    if (item.level > character.level) continue
    pool.push(item)
  }
  // The flat `packet/inventory` carries worn items, but a stale indexer row must never make the bot
  // strip gear it can no longer re-see: the current piece is always in the running.
  for (const worn of character.equipment)
    if (!pool.some((item) => item.id === worn.id)) pool.push(worn)

  const used = new Set<string>()
  const relic_types = new Set(
    character.equipment.filter((worn) => worn.slot.startsWith('relic_')).map((worn) => worn.item_type)
  )
  const loadout = new Map<CharacterEquipmentSlot, GearItem>()
  for (const slot of combat_equipment_slots) {
    let best: GearItem | null = null
    let best_score = Number.NEGATIVE_INFINITY
    for (const item of pool) {
      if (used.has(item.id)) continue
      if (!equipment_slot_accepts(slot, item.category)) continue
      if (slot === 'tool' && options.tool_category !== undefined && item.category !== options.tool_category)
        continue
      if (slot.startsWith('relic_') && relic_types.has(item.item_type)) continue
      const score = item_power(item, affinity)
      if (score > best_score) {
        best = item
        best_score = score
      }
    }
    if (best) {
      loadout.set(slot, best)
      used.add(best.id)
      if (slot.startsWith('relic_')) relic_types.add(best.item_type)
    }
  }
  return loadout
}

export type EquipChange = Readonly<{ slot: string; item_id: string }>
export type EquipPlan = Readonly<{ to_equip: readonly EquipChange[]; to_unequip: readonly EquipChange[] }>

/** The minimal diff between what the character wears and the planned loadout: the slots whose best
 *  item is not the one already on. The SDK's `equip` submits both halves in ONE PTB, unequipping
 *  before equipping, so a same-slot swap never trips `ESlotTaken`. */
export const equip_plan = (character: CharacterRow, loadout: GearLoadout): EquipPlan => {
  const worn = new Map(character.equipment.map((item) => [item.slot, item]))
  const to_equip: EquipChange[] = []
  const to_unequip: EquipChange[] = []
  for (const [slot, item] of loadout) {
    const current = worn.get(slot)
    if (current?.id === item.id) continue
    if (current) to_unequip.push(Object.freeze({ slot, item_id: current.id }))
    to_equip.push(Object.freeze({ slot, item_id: item.id }))
  }
  return Object.freeze({ to_equip: Object.freeze(to_equip), to_unequip: Object.freeze(to_unequip) })
}

// ── the effectful edge ───────────────────────────────────────────────

export type EquipTarget = Readonly<{ ctx: ActionContext; tool_category?: string }>

export type AutoEquipReport = Readonly<{
  /** how many items were actually equipped this pass */
  equipped: number
  /** characters that wanted a check but could not spend yet (seated in a fight, not fresh) — the
   *  caller retries, so a drop that lands mid-fight is still equipped once the party is out */
  blocked: number
}>

/** Gear every character in the party, leader first, across the party's ONE shared inventory. Each
 *  character's chosen items are CLAIMED before the next is planned, so two characters never reach
 *  for the same item id. A character that is not fresh or is seated in a fight (`custody: fight` —
 *  its object has left the kiosk, so `kiosk.borrow_mut` would abort) is reported `blocked` and left
 *  for the caller to retry. */
export const auto_equip_party = async (targets: readonly EquipTarget[]): Promise<AutoEquipReport> => {
  const claimed = new Set<string>()
  let equipped = 0
  let blocked = 0
  for (const { ctx, tool_category } of targets) {
    const state = ctx.state()
    const character = select_character(state, ctx.character_id)
    if (!character) continue
    if (character.active_fight || character.custody === 'fight' || !freshness(state, Date.now()).ok) {
      blocked += 1
      continue
    }

    const loadout = plan_loadout(character, state, { claimed, tool_category })
    const plan = equip_plan(character, loadout)
    if (!plan.to_equip.length) continue

    try {
      const receipt = await ctx.sdk.character.equip({
        character_id: character.id,
        to_equip: plan.to_equip,
        to_unequip: plan.to_unequip,
        custody: custody_of(character),
      })
      for (const change of plan.to_equip) claimed.add(change.item_id)
      equipped += plan.to_equip.length
      ctx.ledger.append({
        kind: 'equip',
        digest: receipt.digest,
        detail: { character: character.name, to_equip: plan.to_equip, to_unequip: plan.to_unequip },
      })
      log_info(
        'equip',
        `${character.name}: equipped ${plan.to_equip.length} — ${plan.to_equip
          .map((change) => `${change.slot}:${change.item_id.slice(0, 8)}`)
          .join(', ')}`
      )
    } catch (error) {
      log_warn('equip', `${character.name}: equip failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return Object.freeze({ equipped, blocked })
}

