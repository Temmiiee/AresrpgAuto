// Seed catalog → @aresrpg/fight source shapes. ONE home for the converters: the fight runtime's
// remote hydration door needs player sources (which ride the wire) and spell sources (which are
// seed content and never do).
import type { MobTemplateSource, SpellEffect, SpellLevel, SpellSource } from '@aresrpg/fight'
import type { SeedMob, SeedSpell, SeedSpellLevel } from '@aresrpg/sdk/seed'

import { mobs, spells } from './catalog.ts'

export const to_effect = (effect: SeedSpellLevel['effects'][number]): SpellEffect => ({
  kind: BigInt(effect.kind),
  element: effect.element,
  value: BigInt(effect.value),
  value_max: BigInt(effect.value_max),
  area_shape: BigInt(effect.area_shape),
  area_size: BigInt(effect.area_size),
  target_filter: BigInt(effect.target_filter),
  chance_bp: BigInt(effect.chance_bp),
  turns: BigInt(effect.turns),
  stat: BigInt(effect.stat),
})

export const to_spell_level = (level: SeedSpellLevel): SpellLevel => ({
  ap_cost: BigInt(level.ap_cost),
  range_min: BigInt(level.range_min),
  range_max: BigInt(level.range_max),
  modifiable_range: level.modifiable_range,
  line_of_sight: level.line_of_sight,
  line_launch: level.line_launch,
  free_cell: level.free_cell,
  casts_per_turn: BigInt(level.casts_per_turn),
  casts_per_target: BigInt(level.casts_per_target),
  cooldown_turns: BigInt(level.cooldown_turns),
  crit_1_in: BigInt(level.crit_1_in),
  effects: level.effects.map(to_effect),
  crit_effects: level.crit_effects.map(to_effect),
})

export const to_spell_source = (spell: SeedSpell): SpellSource => ({
  classe: spell.classe,
  unlock_level: BigInt(spell.unlock_level),
  levels: spell.levels.map(to_spell_level),
})

export const to_mob_template = (mob: SeedMob): MobTemplateSource => ({
  mob_type: mob.mob_type,
  level_min: BigInt(mob.level_min),
  level_max: BigInt(mob.level_max),
  hp: BigInt(mob.hp),
  ap: BigInt(mob.ap),
  mp: BigInt(mob.mp),
  agility: BigInt(mob.agility),
  wisdom: BigInt(mob.wisdom),
  earth_res: BigInt(mob.resistances.earth ?? 32_768),
  fire_res: BigInt(mob.resistances.fire ?? 32_768),
  water_res: BigInt(mob.resistances.water ?? 32_768),
  air_res: BigInt(mob.resistances.air ?? 32_768),
  spells: mob.spells.map((spell) => ({ name: spell.name, level: to_spell_level(spell.levels[0]!) })),
  loot: mob.loot.map((row) => ({
    item_type: row.item_type,
    chance_bp: BigInt(row.chance_bp),
    min_qty: BigInt(row.min_qty),
    max_qty: BigInt(row.max_qty),
  })),
  xp: BigInt(mob.xp),
})

/** The whole spell catalog as fight sources — computed once (seed content is immutable). */
const catalog_spells: Readonly<Record<string, SpellSource>> = Object.freeze(
  Object.fromEntries(spells.map((spell) => [spell.name, to_spell_source(spell)]))
)

export const catalog_spell_sources = (): Readonly<Record<string, SpellSource>> => catalog_spells

const mob_templates_by_type: Readonly<Record<string, MobTemplateSource>> = Object.freeze(
  Object.fromEntries(mobs.map((mob) => [mob.mob_type, to_mob_template(mob)]))
)

/** The authored template for a mob type, or null when the seed has no such mob. */
export const mob_template_of = (mob_type: string): MobTemplateSource | null => mob_templates_by_type[mob_type] ?? null
