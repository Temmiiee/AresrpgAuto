// Splits newly-available stat points between vitality (survivability) and the class's primary
// damage stat, instead of dumping everything into vitality. fight.move's damage formula is
// `base × (100 + primary) / 100 + raw_damage` (aresrpg_math::fight_math::amplify_damage) where
// `primary` is looked up by the spell's element — earth→strength, fire→intelligence,
// water→chance, air→agility (fight_math::primary_stat). A character who has never spent a
// point there deals exactly base-roll damage forever, a flat 0% bonus, however high their level
// climbs — which is a real, compounding cause of long/lost fights, not just low HP.
import { characteristic_cost_step, type CharacteristicName, type ClassName } from '@aresrpg/immutable'

// The element with the highest total damage-weighted magnitude across each class's spell kit
// (computed from seed/content/spells.json: sum (value+value_max)/2 of every direct-damage
// effect across each class's full spell list, grouped by the effect's element, take the
// element with the largest total). Extended to all 12 classes (2026-09-04, previously only
// covered the 4 in this bot's own party_config.ts) — the other 8 fell back to
// split_stat_spending's `{vitality: available_points}` default, meaning any composition
// simulation involving them would have spent every point on vitality and NEVER gained the
// caster_damage_multiplier bonus below, an unfair handicap that would have skewed a
// composition sweep against them regardless of how good their spells actually are.
//
// Recomputing this same methodology against the real data ALSO caught a pre-existing error:
// `mori`'s spell kit is air-dominant (46 vs earth's 30), not earth -- corrected strength -> agility.
export const PRIMARY_STAT_BY_CLASS: Readonly<Record<string, CharacteristicName>> = {
  asobi: 'strength',
  ikari: 'strength',
  iyashi: 'strength',
  mori: 'agility', // was 'strength' -- air (46) beats earth (30) in the class's actual spell kit
  rojin: 'chance',
  senshi: 'strength',
  shugo: 'intelligence',
  shusen: 'agility',
  tokei: 'strength',
  tomoda: 'intelligence',
  yajin: 'strength',
  yogan: 'intelligence',
}

export type LiveStats = Readonly<{ strength: number; intelligence: number; chance: number; agility: number }>

// aresrpg_math::fight_math::primary_stat's exact element -> stat lookup — the SAME mapping the
// comment above already describes, made into real data so spell selection can use it too (see
// caster_damage_multiplier below), not just this file's own stat-spending choice. Typed to
// LiveStats's own 4 keys (not the full 6-way CharacteristicName vitality/wisdom belong to) since
// primary_stat's Move implementation only ever returns one of these four.
const STAT_BY_ELEMENT: Readonly<Record<string, keyof LiveStats>> = {
  earth: 'strength',
  fire: 'intelligence',
  water: 'chance',
  air: 'agility',
}

/** The EXACT in-game multiplier (fight_math::amplify_damage: `base × (100 + primary) / 100 +
 *  raw_damage`) a spell of this element gets from the character's CURRENT live stats — 1.0 (no
 *  bonus at all) for an element the character has never put a point toward, regardless of how
 *  good the spell's authored numbers look on paper. Measured live 2026-09-03: a pure-strength
 *  senshi's top-scored known spell by spell_catalog.ts's raw score alone was an AIR spell (0
 *  agility invested) — real multiplier 1.0x — while a lower-raw-score EARTH spell they also knew
 *  would have hit for 1.42x. Scoring by raw authored damage alone, with no caster-side
 *  amplification, systematically favors whichever spell happens to look best on paper over
 *  whichever the character can actually deal real damage with. */
export const caster_damage_multiplier = (element: string | null, stats: LiveStats): number => {
  if (!element) return 1
  const stat = STAT_BY_ELEMENT[element]
  return (100 + (stat ? stats[stat] : 0)) / 100
}

// cli_tune.ts's search (2026-08-31, 2 matchups x 16 grid cells) put the RAW best score at
// share=1.0 (all-offense, zero new vitality) — but that's a corner value from a small matchup
// sample, and losing ALL new HP margin on the strength of two test fights felt like overfitting.
// 0.7 scored within noise of 1.0 (129.53 vs 130.49) and, notably, scored IDENTICALLY across
// every priority_decay value tested — a share the search wasn't sensitive to is a safer bet than
// the single best cell. Re-run cli_tune.ts against a wider matchup set before pushing toward 1.0.
export const DEFAULT_PRIMARY_STAT_SHARE = 0.7

export type StatSpending = Readonly<Partial<Record<CharacteristicName, number>>>

/** How many `available_points` to put into vitality vs. the class's primary damage stat. The
 *  primary stat's cost ladder can have thresholds past low values (unlike vitality, which is
 *  always a flat 1 point : 1 gain forever) — this walks the ladder step by step from the
 *  character's CURRENT value so the spend is always exactly payable, and any remainder that
 *  can't buy a whole step there falls back to vitality, which always can. */
export const split_stat_spending = (
  classe: string,
  available_points: number,
  current_primary_value: number,
  primary_share: number = DEFAULT_PRIMARY_STAT_SHARE
): StatSpending => {
  if (available_points <= 0) return {}
  const primary = PRIMARY_STAT_BY_CLASS[classe]
  if (!primary) return { vitality: available_points }

  const primary_budget = Math.floor(available_points * primary_share)
  let spent = 0
  let value = current_primary_value
  while (spent < primary_budget) {
    const step = characteristic_cost_step(classe as ClassName, primary, value)
    if (spent + step.cost > primary_budget) break
    spent += step.cost
    value += step.gain
  }

  const vitality_points = available_points - spent
  const spending: Record<string, number> = {}
  if (spent > 0) spending[primary] = spent
  if (vitality_points > 0) spending.vitality = vitality_points
  return spending
}
