// Converts the raw seed content (plain-number JSON) into the bigint-typed shapes
// @aresrpg/fight's create_mob_snapshot/create_fight_state expect. Mob templates specifically
// need REAL bigints (not just bigint-coercible numbers) because create_mob_snapshot does bigint
// arithmetic on them directly, before create_fight_state's own normalize_checkpoint pass — so
// unlike character/spell construction (which normalizes on the way in), this can't get away
// with passing plain numbers through.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { MobLoot, MobTemplateSource, SpellEffect, SpellLevel, SpellSource } from '@aresrpg/fight'

const MOBS_PATH = fileURLToPath(new URL('../../../../seed/content/mobs.json', import.meta.url))
const SPELLS_PATH = fileURLToPath(new URL('../../../../seed/content/spells.json', import.meta.url))

type RawEffect = {
  kind: number
  element: string
  value: number
  value_max: number
  area_shape: number
  area_size: number
  target_filter: number
  chance_bp: number
  turns: number
  stat: number
}
type RawSpellLevel = {
  ap_cost: number
  range_min: number
  range_max: number
  modifiable_range: boolean
  line_of_sight: boolean
  line_launch: boolean
  free_cell: boolean
  casts_per_turn: number
  casts_per_target: number
  cooldown_turns: number
  crit_1_in: number
  effects: RawEffect[]
  crit_effects: RawEffect[]
}
type RawSpell = { name: string; classe: string; unlock_level: number; levels: RawSpellLevel[] }
type RawMob = {
  mob_type: string
  family: string
  level_min: number
  level_max: number
  hp: number
  ap: number
  mp: number
  agility: number
  wisdom: number
  resistances: { earth: number; fire: number; water: number; air: number }
  spells: { name: string; levels: RawSpellLevel[] }[]
  loot: { item_type: string; chance_bp: number; min_qty: number; max_qty: number }[]
  xp: number
}

const ALL_MOBS = JSON.parse(readFileSync(MOBS_PATH, 'utf8')) as RawMob[]
const ALL_SPELLS = JSON.parse(readFileSync(SPELLS_PATH, 'utf8')) as RawSpell[]

const to_effect = (e: RawEffect): SpellEffect => ({
  kind: BigInt(e.kind),
  element: e.element,
  value: BigInt(e.value),
  value_max: BigInt(e.value_max),
  area_shape: BigInt(e.area_shape),
  area_size: BigInt(e.area_size),
  target_filter: BigInt(e.target_filter),
  chance_bp: BigInt(e.chance_bp),
  turns: BigInt(e.turns),
  stat: BigInt(e.stat),
})

const to_level = (l: RawSpellLevel): SpellLevel => ({
  ap_cost: BigInt(l.ap_cost),
  range_min: BigInt(l.range_min),
  range_max: BigInt(l.range_max),
  modifiable_range: l.modifiable_range,
  line_of_sight: l.line_of_sight,
  line_launch: l.line_launch,
  free_cell: l.free_cell,
  casts_per_turn: BigInt(l.casts_per_turn),
  casts_per_target: BigInt(l.casts_per_target),
  cooldown_turns: BigInt(l.cooldown_turns),
  crit_1_in: BigInt(l.crit_1_in),
  effects: l.effects.map(to_effect),
  crit_effects: l.crit_effects.map(to_effect),
})

const to_loot = (l: RawMob['loot'][number]): MobLoot => ({
  item_type: l.item_type,
  chance_bp: BigInt(l.chance_bp),
  min_qty: BigInt(l.min_qty),
  max_qty: BigInt(l.max_qty),
})

/** The mob's FIRST authored spell level only — matches spell_catalog.ts's own "level 1 is the
 *  self-learned default" convention; mobs don't raise spell levels the way players do. */
export const find_mob_template = (mob_type: string): MobTemplateSource => {
  const raw = ALL_MOBS.find((m) => m.mob_type === mob_type)
  if (!raw) throw new Error(`unknown mob_type "${mob_type}" (not in seed/content/mobs.json)`)
  return {
    mob_type: raw.mob_type,
    level_min: BigInt(raw.level_min),
    level_max: BigInt(raw.level_max),
    hp: BigInt(raw.hp),
    ap: BigInt(raw.ap),
    mp: BigInt(raw.mp),
    agility: BigInt(raw.agility),
    wisdom: BigInt(raw.wisdom),
    earth_res: BigInt(raw.resistances.earth),
    fire_res: BigInt(raw.resistances.fire),
    water_res: BigInt(raw.resistances.water),
    air_res: BigInt(raw.resistances.air),
    spells: raw.spells.map((s) => ({ name: s.name, level: to_level(s.levels[0]!) })),
    loot: raw.loot.map(to_loot),
    xp: BigInt(raw.xp),
  }
}

export const all_mob_types = (): readonly string[] => ALL_MOBS.map((m) => m.mob_type)
export const all_mob_rows = (): readonly { mob_type: string; family: string; level_min: number; level_max: number }[] =>
  ALL_MOBS.map((m) => ({ mob_type: m.mob_type, family: m.family, level_min: m.level_min, level_max: m.level_max }))

/** Every spell in the game, keyed by name — the `spells` table create_fight_state needs so
 *  cast_spell actions can resolve by name regardless of which classes are in this fight. */
export const all_spell_sources = (): Record<string, SpellSource> =>
  Object.fromEntries(
    ALL_SPELLS.map((s) => [
      s.name,
      { classe: s.classe, unlock_level: BigInt(s.unlock_level), levels: s.levels.map(to_level) },
    ])
  )
