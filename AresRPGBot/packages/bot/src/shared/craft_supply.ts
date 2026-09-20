// Supply-run planning: when a craft pass is blocked for want of ingredients, most of the
// missing items are NOT gatherable — they are mob drops locked to a specific city (e.g.
// gnawed_branch/rabbit_sinew/lorito_feather only drop from the thebes band, so the frontier
// roaming party stopped seeing them). This module maps a set of missing ingredient types to the
// city whose drop table covers them best, so the roamer can make a bounded detour there, fight a
// few groups (the in-city groups are low level, well inside the discovery window), and return.
// Pure seed reads — no chain calls. Walk cost reuses the exact travel gate (travel_time_ms).
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import type { Position } from '../fight/fight_state.ts'
import { travel_time_ms } from './zone_relocation.ts'

// src/shared sits 4 levels below the repo root, same as src/farm (see farm_engine.ts).
const MOBS_PATH = fileURLToPath(new URL('../../../../seed/content/mobs.json', import.meta.url))
const WORLDS_PATH = fileURLToPath(new URL('../../../../seed/content/worlds.json', import.meta.url))

type DropEntry = { item_type: string; chance_bp: number; min_qty: number; max_qty: number }
type SeedMob = { mob_type: string; level_min: number; level_max: number; loot?: DropEntry[] }
type WorldCity = { city: string; x: number; z: number }
type WorldMob = { mob_type: string; weight_bp: number; biomes: string[]; cities?: string[] }

export type SupplyPlan = {
  city: string
  target: Position
  /** item_type -> best drop chance (0..1) of a mob from that city dropping it */
  coverage: Map<string, number>
  round_trip_ms: number
}

const seed_cities = (): Map<string, WorldCity> => {
  const worlds = JSON.parse(readFileSync(WORLDS_PATH, 'utf8')) as { cities: WorldCity[] }[]
  return new Map((worlds[0]?.cities ?? []).map((c) => [c.city, c]))
}

// item_type -> city -> best drop chance bp (e.g. tinker's 5820-bp gnawed_branch when the drop
// table carries several droppers for the same item in the same city — the most likely one wins).
let drop_cache: Map<string, Map<string, number>> | null = null
const drop_chances_by_city = (): Map<string, Map<string, number>> => {
  if (drop_cache) return drop_cache
  const mobs = JSON.parse(readFileSync(MOBS_PATH, 'utf8')) as SeedMob[]
  const worlds = JSON.parse(readFileSync(WORLDS_PATH, 'utf8')) as { mobs: WorldMob[] }[]
  const cities_of_mob = new Map<string, string[]>()
  for (const mob of worlds[0]?.mobs ?? []) {
    if (mob.cities && mob.cities.length > 0) cities_of_mob.set(mob.mob_type, mob.cities)
  }
  const by_item = new Map<string, Map<string, number>>()
  for (const mob of mobs) {
    const cities = cities_of_mob.get(mob.mob_type)
    if (!cities) continue // no city-locked spawn band — not a candidate for a supply detour
    for (const drop of mob.loot ?? []) {
      let by_city = by_item.get(drop.item_type)
      if (!by_city) {
        by_city = new Map()
        by_item.set(drop.item_type, by_city)
      }
      for (const city of cities) {
        by_city.set(city, Math.max(by_city.get(city) ?? 0, drop.chance_bp))
      }
    }
  }
  drop_cache = by_item
  return by_item
}

/** Pick the city that covers the most missing items (weighted by each item's best drop chance
 *  there), tie-broken by proximity, and verify the round trip stays within max_travel_ms.
 *  Returns null when nothing missing is mob-droppable in any city, or the only covers lie too far. */
export const plan_supply_run = (
  position: Position,
  missing: ReadonlyMap<string, number>,
  max_travel_ms: number
): SupplyPlan | null => {
  if (missing.size === 0) return null
  const covers = drop_chances_by_city()
  const city_pos = seed_cities()

  const city_score = new Map<string, { score: number }>()
  const coverage_by_city = new Map<string, Map<string, number>>()
  for (const item of missing.keys()) {
    const by_city = covers.get(item)
    if (!by_city) continue // gathered via resource packs instead — the farm phase already does this
    for (const [city, chance_bp] of by_city) {
      const entry = city_score.get(city) ?? { score: 0 }
      entry.score += chance_bp / 10_000
      city_score.set(city, entry)
      const cov = coverage_by_city.get(city) ?? new Map<string, number>()
      cov.set(item, chance_bp / 10_000)
      coverage_by_city.set(city, cov)
    }
  }
  if (city_score.size === 0) return null

  const ranked = [...city_score.entries()]
    .map(([city, { score }]): { city: string; score: number } => ({ city, score }))
    .sort((a, b) => b.score - a.score)
  const best_score = ranked[0]!.score
  const nearest_of_best = ranked
    .filter((r) => r.score === best_score)
    .map((r) => {
      const pos = city_pos.get(r.city)
      return { city: r.city, position: pos ? { x: pos.x, z: pos.z } : position }
    })
    .sort((a, b) => {
      const da = Math.hypot(a.position.x - position.x, a.position.z - position.z)
      const db = Math.hypot(b.position.x - position.x, b.position.z - position.z)
      return da - db
    })[0]!

  const round_trip_ms = 2 * travel_time_ms(position, nearest_of_best.position)
  if (round_trip_ms > max_travel_ms) return null

  return {
    city: nearest_of_best.city,
    target: nearest_of_best.position,
    coverage: coverage_by_city.get(nearest_of_best.city) ?? new Map<string, number>(),
    round_trip_ms,
  }
}

// Exposed for tests: which items drop in which city (best chance bp).
export const item_drop_cities = (item_type: string): Map<string, number> =>
  drop_chances_by_city().get(item_type) ?? new Map<string, number>()