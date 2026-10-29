// Auto-progression — spend unspent STAT capital and SPELL points the moment a level-up grants them.
//
// Chain rules (aresrpg `character.move::raise_stat`, `progression.move::raise_spell`):
//   - stats: `raise_stat(stat, points)` spends EXACT capital; the class ladder
//     (`characteristic_ladders`) decides how much natural stat one click buys at the current value.
//   - spells: a spell is learned (level 1) once the character reaches its `unlock_level`; raising
//     n → n+1 costs n spell points; the top level is the template's level count.
//
// Policy — "the correct stats and spells" for a bot that only casts damage:
//   1. SPELLS: the character's damage ELEMENT is read off the spells it can actually cast (unlocked,
//      weighted by how hard they hit at their CURRENT level). Spell raises are chosen greedily by
//      expected-damage-per-AP gained per spell point, so the main nuke is pushed first and cheap
//      level-2 bumps on good secondaries come next. When the best raise is not yet affordable the
//      points are SAVED for it instead of being frittered on a weak spell.
//   2. STATS: capital goes, click by click, to the stat with the best weight × gain / cost — the
//      element(s) the kit deals (by share), with vitality as the survival stat. As an element's
//      ladder gets expensive (100 → 2 capital per point, …) vitality or a secondary element takes over.
import {
  characteristic_cost_step,
  characteristic_names,
  characteristic_spending_quote,
  type CharacteristicName,
  type ClassName,
} from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'
import type { SeedSpell } from '@aresrpg/sdk/seed'

import { spells } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'

import { custody_of, type ActionContext } from './context.ts'

type Element = 'earth' | 'fire' | 'water' | 'air'
const ELEMENTS: readonly Element[] = ['earth', 'fire', 'water', 'air']
const STAT_OF_ELEMENT: Readonly<Record<Element, CharacteristicName>> = Object.freeze({
  earth: 'strength',
  fire: 'intelligence',
  water: 'chance',
  air: 'agility',
})

// effect kinds (fight `EFFECT_KINDS`): direct damage, %life damage, and life steal hit the enemy.
const DAMAGE_KINDS: ReadonlySet<number> = new Set([0, 1, 6])
/** Neutral damage is amplified by strength in the fight engine. */
const element_of = (raw: string): Element | null =>
  raw === 'neutral' ? 'earth' : (ELEMENTS as readonly string[]).includes(raw) ? (raw as Element) : null

/** Survival weight of one natural vitality point vs one point of the main element (share 1.0). */
const VITALITY_WEIGHT = 0.3
/** Wisdom only speeds XP; worth a little, never ahead of damage/survival at 3 capital per point. */
const WISDOM_WEIGHT = 0.15

type SpellLevel = SeedSpell['levels'][number]

const class_spells = (classe: string): readonly SeedSpell[] => spells.filter((spell) => spell.classe === classe)

/** Expected damage per AP of one spell level, per element (crit folded in at its rate). */
const level_damage = (level: SpellLevel): Readonly<Record<Element, number>> => {
  const out: Record<Element, number> = { earth: 0, fire: 0, water: 0, air: 0 }
  const ap = Math.max(1, Number(level.ap_cost ?? 1))
  const crit = level.crit_1_in && level.crit_1_in > 0 ? 1 / level.crit_1_in : 0
  const add = (effects: SpellLevel['effects'], share: number) => {
    for (const effect of effects ?? []) {
      if (!DAMAGE_KINDS.has(Number(effect.kind))) continue
      const element = element_of(String(effect.element))
      if (!element) continue
      const avg = (Number(effect.value) + Math.max(Number(effect.value), Number(effect.value_max))) / 2
      const chance = effect.chance_bp == null ? 1 : Number(effect.chance_bp) / 10_000
      if (avg > 0) out[element] += (avg * chance * share) / ap
    }
  }
  add(level.effects, 1 - crit)
  add(level.crit_effects, crit)
  // a cooldown spell is cast less often than a spammable one
  const cooldown = Math.max(0, Number(level.cooldown_turns ?? 0))
  if (cooldown > 0) for (const element of ELEMENTS) out[element] /= 1 + cooldown
  return out
}

const total = (row: Readonly<Record<Element, number>>) => ELEMENTS.reduce((sum, e) => sum + row[e], 0)

/** The level the chain reports for a spell: 0 before unlock, the book entry, else 1. */
export const spell_level_of = (character: Pick<CharacterRow, 'level' | 'spells'>, spell: SeedSpell): number => {
  if (character.level < spell.unlock_level) return 0
  const booked = character.spells?.[spell.name]
  return Number.isSafeInteger(booked) && (booked as number) >= 1 ? (booked as number) : 1
}

/** Element shares of the damage the character can deal RIGHT NOW (its unlocked kit at current levels). */
export const kit_element_shares = (
  character: Pick<CharacterRow, 'classe' | 'level' | 'spells'>
): Readonly<Record<Element, number>> => {
  const sum: Record<Element, number> = { earth: 0, fire: 0, water: 0, air: 0 }
  for (const spell of class_spells(character.classe)) {
    const level = spell_level_of(character, spell)
    if (level < 1) continue
    const row = spell.levels[Math.min(level, spell.levels.length) - 1]
    if (!row) continue
    const dmg = level_damage(row)
    for (const element of ELEMENTS) sum[element] += dmg[element]
  }
  const all = total(sum)
  if (all <= 0) return Object.freeze({ earth: 0.25, fire: 0.25, water: 0.25, air: 0.25 })
  return Object.freeze(Object.fromEntries(ELEMENTS.map((e) => [e, sum[e] / all])) as Record<Element, number>)
}

const spell_power = (spell: SeedSpell, level: number, character: CharacterRow): number => {
  const row = spell.levels[level - 1]
  if (!row) return 0
  const dmg = level_damage(row)
  // amplification by the character's own element stat (Dofus: +1% per point)
  return ELEMENTS.reduce((sum, e) => sum + dmg[e] * (1 + Math.max(0, Number(character[STAT_OF_ELEMENT[e]] ?? 0)) / 100), 0)
}

export type SpellRaise = Readonly<{ spell: string; from: number; cost: number; value: number }>

/** The ordered spell raises to make with the points available now. Greedy by damage gained per
 *  spell point; stops (saving points) when the best-value raise is not affordable yet. */
export const plan_spell_raises = (character: CharacterRow): readonly SpellRaise[] => {
  let points = Math.max(0, Math.floor(Number(character.available_spell_points ?? 0)))
  if (points <= 0) return []
  const levels = new Map<string, number>()
  const kit = class_spells(character.classe)
  for (const spell of kit) levels.set(spell.name, spell_level_of(character, spell))
  const out: SpellRaise[] = []
  for (let guard = 0; guard < 64 && points > 0; guard++) {
    let best: SpellRaise | null = null
    for (const spell of kit) {
      const level = levels.get(spell.name) ?? 0
      if (level < 1 || level >= spell.levels.length) continue
      const now = spell_power(spell, level, character)
      const next = spell_power(spell, level + 1, character)
      // a small tie-break toward the spells that already hit hardest (crit/range-only upgrades)
      const value = (Math.max(0, next - now) + 0.02 * next) / level
      if (!best || value > best.value) best = { spell: spell.name, from: level, cost: level, value }
    }
    if (!best || best.value <= 0 || best.cost > points) break
    out.push(best)
    points -= best.cost
    levels.set(best.spell, best.from + 1)
  }
  return out
}

/** Per-stat weight for this character: the kit's element shares, vitality as survival. */
export const stat_weights = (character: CharacterRow): Readonly<Record<CharacteristicName, number>> => {
  const shares = kit_element_shares(character)
  const weights: Record<CharacteristicName, number> = {
    vitality: VITALITY_WEIGHT,
    wisdom: WISDOM_WEIGHT,
    strength: 0,
    intelligence: 0,
    chance: 0,
    agility: 0,
  }
  for (const element of ELEMENTS) weights[STAT_OF_ELEMENT[element]] += shares[element]
  return Object.freeze(weights)
}

/** Exact capital spending per stat for the points available now (validated by the class ladder). */
export const plan_stat_spending = (
  character: CharacterRow
): Readonly<Partial<Record<CharacteristicName, number>>> | null => {
  let capital = Math.max(0, Math.floor(Number(character.available_points ?? 0)))
  if (capital <= 0) return null
  const classe = character.classe as ClassName
  const weights = stat_weights(character)
  const values = Object.fromEntries(
    characteristic_names.map((stat) => [stat, Math.max(0, Number(character[stat] ?? 0))])
  ) as Record<CharacteristicName, number>
  const spending: Partial<Record<CharacteristicName, number>> = {}
  for (let guard = 0; guard < 10_000 && capital > 0; guard++) {
    let pick: { stat: CharacteristicName; cost: number; gain: number; value: number } | null = null
    for (const stat of characteristic_names) {
      if (weights[stat] <= 0) continue
      let step
      try {
        step = characteristic_cost_step(classe, stat, values[stat])
      } catch {
        continue
      }
      if (!step || step.cost <= 0 || step.cost > capital) continue
      const value = (weights[stat] * step.gain) / step.cost
      if (!pick || value > pick.value) pick = { stat, cost: step.cost, gain: step.gain, value }
    }
    if (!pick) break
    spending[pick.stat] = (spending[pick.stat] ?? 0) + pick.cost
    values[pick.stat] += pick.gain
    capital -= pick.cost
  }
  if (!Object.keys(spending).length) return null
  const current = Object.fromEntries(
    characteristic_names.map((stat) => [stat, Math.max(0, Number(character[stat] ?? 0))])
  ) as Record<CharacteristicName, number>
  const quote = characteristic_spending_quote(classe, current, spending)
  if (!quote || quote.cost > Number(character.available_points ?? 0)) return null
  return Object.freeze(spending)
}

const RAISE_COOLDOWN_MS = 30_000
const FAILURE_BACKOFF_MS = 5 * 60_000
const next_try_ms = new Map<string, number>()

/** Spend whatever a level-up granted. Returns true when a transaction was submitted. */
export const maybe_progress = async (ctx: ActionContext, character: CharacterRow): Promise<boolean> => {
  const stat_points = Number(character.available_points ?? 0)
  const spell_points = Number(character.available_spell_points ?? 0)
  if (stat_points <= 0 && spell_points <= 0) return false
  if ((next_try_ms.get(character.id) ?? 0) > Date.now()) return false

  let acted = false
  const spending = stat_points > 0 ? plan_stat_spending(character) : null
  if (spending) {
    try {
      await ctx.sdk.character.raise_stats({ character_id: character.id, spending, custody: custody_of(character) })
      const summary = Object.entries(spending)
        .map(([stat, points]) => `${stat}+${points}`)
        .join(' ')
      log_info('progress', `${character.name}: spent ${stat_points} stat point(s): ${summary}`)
      ctx.notify(`${character.name} raised stats: ${summary}`)
      acted = true
    } catch (error) {
      log_warn('progress', `${character.name}: raise_stats failed: ${error instanceof Error ? error.message : String(error)}`)
      next_try_ms.set(character.id, Date.now() + FAILURE_BACKOFF_MS)
      return false
    }
  }

  for (const raise of plan_spell_raises(character)) {
    try {
      await ctx.sdk.character.raise_spell({ character_id: character.id, spell: raise.spell, custody: custody_of(character) })
      log_info('progress', `${character.name}: raised spell ${raise.spell} ${raise.from} → ${raise.from + 1} (${raise.cost} pt)`)
      ctx.notify(`${character.name} raised ${raise.spell} to level ${raise.from + 1}`)
      acted = true
    } catch (error) {
      log_warn('progress', `${character.name}: raise_spell ${raise.spell} failed: ${error instanceof Error ? error.message : String(error)}`)
      next_try_ms.set(character.id, Date.now() + FAILURE_BACKOFF_MS)
      return acted
    }
  }
  // the projection trails the receipt: don't re-plan from the stale row for a beat
  if (acted) next_try_ms.set(character.id, Date.now() + RAISE_COOLDOWN_MS)
  return acted
}
