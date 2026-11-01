// Auto-progression — spend unspent STAT capital and SPELL points the moment a level-up grants them.
//
// Chain rules (aresrpg `character.move::raise_stat`, `progression.move::raise_spell`):
//   - stats: `raise_stat(stat, points)` spends EXACT capital; the class ladder
//     (`characteristic_ladders`) decides how much natural stat one click buys at the current value.
//   - spells: a spell is learned (level 1) once the character reaches its `unlock_level`; raising
//     n → n+1 costs n spell points; the top level is the template's level count.
//
// Policy — score the whole spell kit and class role, not only raw spell damage:
//   1. SPELLS: the character's damage ELEMENT is read off the spells it can actually cast (unlocked,
//      spell raises compete by marginal per-turn value per spell point, with damage, healing, buffs,
//      control, area, range, cast limits, cooldowns and crit effects scored from the current seed.
//   2. STATS: each candidate natural point is simulated against that same kit; class ladder costs,
//      max HP, Wisdom's actual XP multiplier and class role weights decide how capital is spent.
import {
  characteristic_cost_step,
  characteristic_names,
  characteristic_spending_quote,
  max_level,
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
const is_damage_effect = (effect: SpellLevel['effects'][number]): boolean => {
  const kind = Number(effect.kind)
  return kind === 0 || kind === 1 || kind === 3 || ([5, 6, 14, 20].includes(kind) && Number(effect.stat) === 12)
}
/** Neutral damage is amplified by strength in the fight engine. */
const element_of = (raw: string): Element | null =>
  raw === 'neutral' ? 'earth' : (ELEMENTS as readonly string[]).includes(raw) ? (raw as Element) : null

type BuildProfile = Readonly<{ damage: number; healing: number; buff: number; control: number; zone: number; range: number; survival: number; xp: number }>
const BUILD_PROFILES: Readonly<Record<string, BuildProfile>> = Object.freeze({
  tomoda: Object.freeze({ damage: 0.82, healing: 1.65, buff: 1.55, control: 1.05, zone: 1.15, range: 0.9, survival: 1.3, xp: 0.9 }),
  mori: Object.freeze({ damage: 1.05, healing: 1.3, buff: 1.05, control: 1.45, zone: 1.35, range: 0.85, survival: 1.25, xp: 1.0 }),
  yogan: Object.freeze({ damage: 1.45, healing: 0.35, buff: 0.8, control: 1.05, zone: 1.25, range: 1.4, survival: 0.9, xp: 1.1 }),
})
const profile_of = (character: Pick<CharacterRow, 'classe'>): BuildProfile =>
  BUILD_PROFILES[character.classe.toLowerCase()] ?? { damage: 1, healing: 0.75, buff: 0.75, control: 0.75, zone: 0.9, range: 1, survival: 1, xp: 1 }
const effective_stat = (character: CharacterRow, stat: CharacteristicName | 'critical'): number =>
  Math.max(0, Number(stat === 'critical' ? 0 : character[stat] ?? 0) + Number(character.folded_stats?.[stat] ?? 0))

type SpellLevel = SeedSpell['levels'][number]

const class_spells = (classe: string): readonly SeedSpell[] => spells.filter((spell) => spell.classe === classe)

/** Expected damage per AP of one spell level, per element (crit folded in at its rate). */
const level_damage = (level: SpellLevel): Readonly<Record<Element, number>> => {
  const out: Record<Element, number> = { earth: 0, fire: 0, water: 0, air: 0 }
  const ap = Math.max(1, Number(level.ap_cost ?? 1))
  const crit = level.crit_1_in && level.crit_1_in > 0 ? 1 / level.crit_1_in : 0
  const add = (effects: SpellLevel['effects'], share: number) => {
    for (const effect of effects ?? []) {
      if (!is_damage_effect(effect)) continue
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

const kind = Object.freeze({ damage: 0, pct_life: 1, caster_damage: 2, punishment: 3, add: 4, remove: 5, steal: 6, chatiment: 7, push: 8, pull: 9, teleport: 10, swap: 11, trap: 12, glyph: 13, reduce: 14, reflect: 15, dispel: 16, invis: 17, return: 18, redirect: 19, fixed_remove: 20 })
const channel = Object.freeze({ strength: 0, intelligence: 1, chance: 2, agility: 3, wisdom: 4, range: 5, ap: 6, mp: 7, power: 8, raw_damage: 9, critical: 10, resistance: 11, hp: 12 })
const channel_weight = (stat: number): number =>
  stat === channel.ap ? 9 : stat === channel.mp ? 4 : stat === channel.range ? 2.5 :
    stat === channel.power || stat === channel.raw_damage ? 1.35 : stat === channel.critical ? 0.8 :
      stat === channel.resistance ? 0.75 : stat === channel.wisdom ? 0.45 : stat === channel.hp ? 0.1 : 0.3

const effect_score = (effect: SpellLevel['effects'][number], character: CharacterRow): number => {
  const profile = profile_of(character)
  const k = Number(effect.kind)
  const stat = Number(effect.stat)
  const value = Math.max(0, (Number(effect.value) + Math.max(Number(effect.value), Number(effect.value_max))) / 2)
  const chance = Math.max(0, Math.min(1, Number(effect.chance_bp ?? 10_000) / 10_000))
  const turns = Math.max(1, Math.min(4, Number(effect.turns ?? 0)))
  const area = Number(effect.area_shape) === 0 ? 1 : 1 + Math.min(1.5, Math.max(0, Number(effect.area_size)) * 0.2)
  let score = 0

  if (k === kind.damage || k === kind.pct_life || k === kind.punishment || ((k === kind.remove || k === kind.steal || k === kind.fixed_remove) && stat === channel.hp)) {
    const element = element_of(String(effect.element))
    const primary = element ? effective_stat(character, STAT_OF_ELEMENT[element]) : 0
    score = value * (k === kind.pct_life ? 1.5 : 1) * (1 + primary / 100) * profile.damage * (1 + (area - 1) * profile.zone * 0.6)
    if (turns > 1 && k !== kind.pct_life) score *= turns * 0.65
    if (k === kind.steal) score *= 1.25
  } else if (k === kind.caster_damage) {
    score = -value * 0.7
  } else if (k === kind.add && stat === channel.hp) {
    score = value * (1 + effective_stat(character, 'intelligence') / 100) * profile.healing * area * (Number(effect.turns) > 0 ? turns * 0.65 : 1)
  } else if (k === kind.add) {
    score = value * turns * channel_weight(stat) * profile.buff * area
  } else if ((k === kind.remove || k === kind.fixed_remove || k === kind.steal) && (stat === channel.ap || stat === channel.mp)) {
    score = value * (stat === channel.ap ? 5 : 2.5) * (k === kind.steal ? 1.35 : 1) * profile.control * Math.min(1, turns * 0.7)
    score *= 0.65 + Math.min(0.8, effective_stat(character, 'wisdom') / 100)
  } else if (k === kind.reduce) {
    score = value * turns * (stat === channel.hp ? 0.55 : stat <= channel.agility ? 0.65 : channel_weight(stat) * 0.35) * profile.control * area
  } else if (k === kind.dispel) {
    score = 5 * profile.control * area
  } else if (k === kind.push || k === kind.pull || k === kind.teleport || k === kind.swap) {
    score = (k === kind.push || k === kind.pull ? value * 1.6 : 4) * profile.control
  } else if (k === kind.trap || k === kind.glyph) {
    score = (3 + Number(effect.area_size) * 1.2) * profile.zone * turns
  } else if (k === kind.invis || k === kind.reflect || k === kind.redirect || k === kind.return || k === kind.chatiment) {
    score = Math.max(3, value * channel_weight(stat)) * turns * profile.buff * area
  }
  return score * chance
}

const spell_level_utility = (level: SpellLevel, character: CharacterRow): number => {
  const ap = Math.max(1, Number(level.ap_cost ?? 1))
  const casts_per_turn = Math.max(1, Math.floor(6 / ap))
  const casts = Math.min(casts_per_turn, Number(level.casts_per_turn) || casts_per_turn)
  const cooldown = 1 / (1 + Math.max(0, Number(level.cooldown_turns ?? 0)))
  const range = 1 + Math.max(-0.05, Math.min(0.18, (Number(level.range_max ?? 0) - 3) * 0.025 * profile_of(character).range))
  const crit_base = Math.max(0, Number(level.crit_1_in ?? 0))
  const crit_floor = Math.max(2, crit_base - effective_stat(character, 'critical'))
  const agility = effective_stat(character, 'agility')
  const crit_denominator = crit_base <= 2 ? crit_base : Math.max(2, Math.min(crit_floor, (crit_floor * 2.9901) / Math.log(agility + 12)))
  const crit = level.crit_effects.length === 0 || crit_base <= 0 ? 0 : Math.min(0.5, 1 / crit_denominator)
  const normal = level.effects.reduce((sum, effect) => sum + effect_score(effect, character), 0)
  const critical = level.crit_effects.reduce((sum, effect) => sum + effect_score(effect, character), 0)
  return (casts * range * cooldown * (normal * (1 - crit) + critical * crit)) / ap
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
      const now = spell_level_utility(spell.levels[level - 1]!, character)
      const next = spell_level_utility(spell.levels[level]!, character)
      const value = (next - now) / level
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
/** The game multiplies each mob-drop probability by (600 + party-average Chance) / 600.
 *  Approximate this small, shared reward in the same marginal utility units as the fight kit. */
const LOOT_CHANCE_SCALE = 600

export const stat_weights = (
  character: CharacterRow,
  loot_team_size = 1
): Readonly<Record<CharacteristicName, number>> => {
  const kit = class_spells(character.classe)
  const utility_of = (candidate: CharacterRow): number =>
    kit.reduce((sum, spell) => {
      const level = spell_level_of(candidate, spell)
      return sum + (level > 0 ? spell_level_utility(spell.levels[level - 1]!, candidate) : 0)
    }, 0)
  const current_utility = utility_of(character)
  const profile = profile_of(character)
  const weights = {} as Record<CharacteristicName, number>
  for (const stat of characteristic_names) {
    const value = Math.max(0, Number(character[stat] ?? 0))
    const boosted = { ...character, [stat]: value + 1 } as CharacterRow
    let marginal = Math.max(0, utility_of(boosted) - current_utility)
    // Chance is useful even for a non-water build: the game shares its drop bonus across winners.
    // Divide by the expected party size to reflect that one character contributes to the average.
    if (stat === 'chance')
      marginal += Math.max(0.01, current_utility / LOOT_CHANCE_SCALE) / Math.max(1, loot_team_size)
    // One natural vitality is one max HP in the Move progression rule.
    if (stat === 'vitality') marginal += Math.max(0.08, current_utility * 0.004 * profile.survival)
    // Move XP is multiplied by (100 + wisdom)/100. Its value fades at the level cap.
    if (stat === 'wisdom' && character.level < max_level)
      marginal += Math.max(0.05, current_utility * 0.01 * profile.xp * (1 - character.level / (max_level * 1.2)))
    weights[stat] = marginal
  }
  return Object.freeze(weights)
}

/** Exact capital spending per stat for the points available now (validated by the class ladder). */
export const plan_stat_spending = (
  character: CharacterRow,
  loot_team_size = 1
): Readonly<Partial<Record<CharacteristicName, number>>> | null => {
  let capital = Math.max(0, Math.floor(Number(character.available_points ?? 0)))
  if (capital <= 0) return null
  const classe = character.classe as ClassName
  const weights = stat_weights(character, loot_team_size)
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
  const spending = stat_points > 0 ? plan_stat_spending(character, ctx.party_state.members.length) : null
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
