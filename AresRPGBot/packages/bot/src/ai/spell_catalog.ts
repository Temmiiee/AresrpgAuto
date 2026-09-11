// Reads the authored spell catalog straight from seed/content — a class's spell is castable
// the moment the character reaches its unlock_level (progression.move: "spells learn
// themselves, the Dofus law"), so no per-character learned-spell state needs to be read.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Effect = {
  kind: number
  value: number
  value_max: number
  stat: number
  turns: number
  target_filter: number
  element: string
}
type SpellLevel = {
  ap_cost: number
  range_min: number
  range_max: number
  line_of_sight: boolean
  effects: Effect[]
}
type SpellRow = { name: string; classe: string; unlock_level: number; levels: SpellLevel[] }

const SPELLS_PATH = fileURLToPath(new URL('../../../../seed/content/spells.json', import.meta.url))
const ALL_SPELLS = JSON.parse(readFileSync(SPELLS_PATH, 'utf8')) as SpellRow[]

// aresrpg_math::spell_effect kind discriminants (DECISIONS.md's sealed list):
// 0 damage · 1 percent_life_damage · 3 punishment_damage · 4 add · 6 steal · 12(stat) hp
// target_filter: 0 none · 1 not_team(enemy only) · 2 not_self · 3 not_enemy(ally/self) · 4 only_caster
const HP_STAT = 12

// A damage-over-time effect: aresrpg_math::spell_effect.move's `remove` kind (5) applied to the
// hp channel (12) with turns >= 1 — confirmed against that file directly (kind 4/5/6 = add/
// remove/steal; instant life-steal is kind 6 with turns 0, this is its OVER-TIME sibling).
// Previously fell through to role: 'other' and was never even offered as a candidate action —
// real poison/bleed spells (e.g. Poisoned Arrow, Chimeric Venom in the real content) were
// invisible to the bot despite being straightforward damage, just spread over turns instead of
// instant. `value`/`value_max` are PER-TURN magnitude for a timed effect (unlike the instant
// kinds, where they're already the total), so damage_amount below scales by `turns`.
const is_dot = (e: Effect): boolean => e.kind === 5 && e.stat === HP_STAT && e.turns >= 1

// has_direct_damage — the three damage-formula kinds, instant life-steal, and DOTs.
const is_direct_damage = (e: Effect): boolean =>
  e.kind === 0 || e.kind === 1 || e.kind === 3 || (e.kind === 6 && e.stat === HP_STAT && e.turns === 0) || is_dot(e)
const damage_amount = (level: SpellLevel): number =>
  level.effects
    .filter(is_direct_damage)
    .reduce((sum, e) => sum + ((e.value + e.value_max) / 2) * (is_dot(e) ? e.turns : 1), 0)
// The element of the single BIGGEST damage effect — spells are practically always
// mono-elemental, and this is only used to weigh a target's resistance/weakness to it
// (fight_math::primary_stat / apply_centered_resistance), not to model mixed-element rows.
const dominant_element = (level: SpellLevel): string | null =>
  [...level.effects.filter(is_direct_damage)].sort((a, b) => b.value_max - a.value_max)[0]?.element || null

// A beneficial add() aimed at something that isn't strictly the enemy — a buff or a heal.
const is_support = (e: Effect): boolean => e.kind === 4 && (e.target_filter === 3 || e.target_filter === 4)
const is_heal = (e: Effect): boolean => is_support(e) && e.stat === HP_STAT
const support_amount = (level: SpellLevel): number =>
  level.effects.filter(is_support).reduce((sum, e) => sum + (e.value + e.value_max) / 2, 0)

export type SpellRole = 'damage' | 'support' | 'other'
export type CastableSpell = {
  name: string
  ap_cost: number
  range_min: number
  range_max: number
  line_of_sight: boolean
  role: SpellRole
  is_heal: boolean
  /** null for non-damage spells (support/other) — nothing to match a resistance against. */
  element: string | null
  /** Expected effect per AP spent — damage/AP for damage spells, magnitude/AP for support. */
  score: number
}

/** Every spell this class knows at this level. `role` splits damage (aimed at the enemy),
 *  support (a buff/heal aimed at an ally or self), and everything else (traps, displacement,
 *  utility) that the current turn logic doesn't know how to use well and treats as low priority. */
export const castable_spells = (classe: string, level: number): CastableSpell[] =>
  ALL_SPELLS.filter((spell) => spell.classe === classe && spell.unlock_level <= level).map((spell) => {
    const first = spell.levels[0]! // invested level 1 — the self-learned default
    const dmg = damage_amount(first)
    const support = support_amount(first)
    const role: SpellRole = dmg > 0 ? 'damage' : support > 0 ? 'support' : 'other'
    const magnitude = role === 'damage' ? dmg : role === 'support' ? support : 0
    return {
      name: spell.name,
      ap_cost: Math.max(1, first.ap_cost),
      range_min: first.range_min,
      range_max: first.range_max,
      line_of_sight: first.line_of_sight,
      role,
      is_heal: first.effects.some(is_heal),
      element: role === 'damage' ? dominant_element(first) : null,
      score: magnitude / Math.max(1, first.ap_cost), // effect per AP — favors efficient spells over one big expensive one
    }
  })
