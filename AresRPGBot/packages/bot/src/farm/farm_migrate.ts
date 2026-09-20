// Region migration for a drained farm — the job-farm CLI's answer to "every resource type is
// drained": when all producing jobs have nothing farmable anywhere in reach, the engine relocates
// the farm to the NEXT city region (the nearest one the farm has not visited yet), walking a
// bounded leg per migrate and claiming a first-discovery landing zone on the way. Pure seed reads
// plus the same travel gate (world_map.move budget) relocation uses; the chain writes live in
// farm_engine.ts.
//
// Why city regions at all: the higher-tier packs older characters can now gather (amber/ivory_
// shrooms around the_ruins, wheat_malt/jade around fuwage) are seeded in the biomes around those
// cities — a farm that re-searches the SAME thebes neighbourhood on a 2h reseed forever never
// leaves tier-1 (wheat/quartz/mushroom …) behind. Region rotation (thebes → the_ruins → fuwage →
// …) both reaches those packs and claims fresh first-discoveries on every leg.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Position } from '../fight/fight_state.ts'
import {
  PET_TRAVEL_SPEED_BUDGET,
  TRAVEL_SPEED_BUDGET,
  TRAVEL_SPEED_SCALE,
  TRAVEL_WAIT_MARGIN_MS,
  travel_time_ms,
} from '../shared/zone_relocation.ts'

// src/farm sits 4 levels below the repo root (same depth as farm_engine.ts's seed reads).
const WORLDS_PATH = fileURLToPath(new URL('../../../../seed/content/worlds.json', import.meta.url))

const ZONE_SIZE = 512
const WORLD_EDGE = 100_000
// One migration leg: a longer walk (e.g. thebes → fuwage ≈ 66 min) is chunked into a ~25 min leg,
// and the NEXT drained farm continues the remaining distance from the landing zone.
export const FARM_MIGRATE_MAX_TRAVEL_MS = 25 * 60_000

export type CityRegion = { city: string; x: number; z: number }

/** The city regions (anchor positions) the nauvis farm can rotate between — from seed worlds.json
 *  (the same file craft_supply.ts reads for its city mapping). */
export const farm_regions = (): readonly CityRegion[] => {
  const worlds = JSON.parse(readFileSync(WORLDS_PATH, 'utf8')) as { cities: CityRegion[] }[]
  return worlds[0]?.cities ?? []
}

/** The region a position sits nearest to — "where is the farm right now". Deterministic stable
 *  tie-break (nearest first, seed order on an exact tie), so a migration never flip-flops between
 *  two equidistant regions. */
export const nearest_region = (position: Position, regions: readonly CityRegion[]): CityRegion | null =>
  [...regions].sort(
    (a, b) =>
      Math.hypot(a.x - position.x, a.z - position.z) - Math.hypot(b.x - position.x, b.z - position.z)
  )[0] ?? null

/** The next migration target: the nearest region the farm has NOT visited yet (the current one is
 *  never a target — the farm is already there). When every other region was visited the rotation
 *  restarts (cycled: true), so a 24/7 farm keeps fresh ground forever instead of grinding a single
 *  region. Null when there are no regions at all. */
export const next_region = (
  from: Position,
  regions: readonly CityRegion[],
  visited: ReadonlySet<string>
): { region: CityRegion; cycled: boolean } | null => {
  const current = nearest_region(from, regions)
  if (!current) return null
  let unvisited = regions.filter((r) => r.city !== current.city && !visited.has(r.city))
  const cycled = unvisited.length === 0
  if (cycled) unvisited = regions.filter((r) => r.city !== current.city)
  if (unvisited.length === 0) return null
  const region = [...unvisited].sort(
    (a, b) => travel_time_ms(from, { x: a.x, z: a.z }) - travel_time_ms(from, { x: b.x, z: b.z })
  )[0]!
  return { region, cycled }
}

/** Where a migration leg lands. When the straight walk fits max_travel_ms the target city centre
 *  is returned unchanged; otherwise the leg stops at the furthest zone centre (the farm's own
 *  discovery unit) along the ray that stays inside the travel budget — a long inter-city walk is
 *  chunked, and the next drained farm continues from the landing. `mounted` plans the leg at the
 *  ×1.5 pet budget (the mover folds read_pet_mounted's both-end truth before calling). Pure. */
export const chunked_landing = (from: Position, to: Position, max_travel_ms: number, mounted = false): Position => {
  if (travel_time_ms(from, to, mounted) <= max_travel_ms) return { x: to.x, z: to.z }
  const speed = mounted ? PET_TRAVEL_SPEED_BUDGET : TRAVEL_SPEED_BUDGET
  const block_budget = Math.max(1, Math.floor(((max_travel_ms - TRAVEL_WAIT_MARGIN_MS) * speed) / TRAVEL_SPEED_SCALE))
  const distance = Math.hypot(to.x - from.x, to.z - from.z)
  const fraction = Math.min(1, block_budget / Math.max(1, distance))
  const x = from.x + (to.x - from.x) * fraction
  const z = from.z + (to.z - from.z) * fraction
  const zx = Math.floor(x / ZONE_SIZE)
  const zz = Math.floor(z / ZONE_SIZE)
  return { x: Math.min(WORLD_EDGE, zx * ZONE_SIZE + ZONE_SIZE / 2), z: Math.min(WORLD_EDGE, zz * ZONE_SIZE + ZONE_SIZE / 2) }
}