// Zone-selection math — a faithful port of the server's zone_math difficulty dial
// (aresrpg/packages/server/src/zone_spawns.ts) plus the world roster the bot may farm.
//
// The server draws a zone's population purely from its DISTANCE to the world centre
// (50,000, 50,000): farther zones spawn bigger mob groups and higher level scalars, and draw
// bigger resource packs. A zone's biome decides WHICH families appear and is engine-only (the
// biome grid never reaches the bot without vendoring `@aresrpg/engine`), so the bot targets the
// one dial it can compute — a distance — and lets the live fight preview choose the real group
// from the spawns the server actually sends.
//
// This module is pure: it reads the seed roster and does integer math. No timers, no I/O, no
// engine. The ramps mirror zone_math exactly so a target distance means the same thing here as
// it does on chain (the same twin law the fight preview follows for combat).
import { ZONE_SIZE, zone_of } from '@aresrpg/protocol'

import { mobs_by_type, worlds, type SeedWorld } from './catalog.ts'

/** The chain's world is a fixed 100,000-block square centred on (50,000, 50,000). */
export const WORLD_CENTER = 50_000
export const WORLD_SIZE = 100_000

/** The scalar ramp saturates here: past it the chain clamps, so travel beyond buys no difficulty. */
export const LEVEL_RAMP_AT = 20_000
/** Never camp the world centre (the spawn ring is trivial) nor drift past the ramp. */
export const MIN_ROAM_DISTANCE = 2_500
export const MAX_ROAM_DISTANCE = LEVEL_RAMP_AT

const GROUP_SIZE_FULL_AT = 10_000
/** The high group-size edge ramps to full later: uniform 2..4 has the authored average of three.
 *  Truncated like the chain's bigint division (`(2_000n * 5n) / 3n`). */
const GROUP_SIZE_HIGH_FULL_AT = Math.trunc((2_000 * 5) / 3)
const NODES_RAMP_AT = 20_000
const LEVEL_LOW_CAP = 75
const LEVEL_HIGH_CAP = 100

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : Math.trunc(value)

/** zone_math::ramp — integer, truncated exactly like the chain's bigint division. */
const ramp = (distance: number, full_at: number, from: number, to: number): number => {
  const capped = distance > full_at ? full_at : distance
  return from + Math.trunc(((to - from) * capped) / full_at)
}

/** zone_math::distance_blocks — Chebyshev distance from the world centre to a zone's CENTRE. */
export const distance_blocks = (zx: number, zz: number): number => {
  const px = zx * ZONE_SIZE + ZONE_SIZE / 2
  const pz = zz * ZONE_SIZE + ZONE_SIZE / 2
  return Math.max(Math.abs(px - WORLD_CENTER), Math.abs(pz - WORLD_CENTER))
}

/** zone_math::mob_level_scalar_bounds — the scalar band a zone's groups draw from. */
export const mob_level_scalar_bounds = (distance: number): readonly [number, number] => [
  ramp(distance, LEVEL_RAMP_AT, 0, LEVEL_LOW_CAP),
  ramp(distance, LEVEL_RAMP_AT, 0, LEVEL_HIGH_CAP),
]

/** zone_math::mob_group_size_bounds — the group-size band a zone's groups draw from. */
export const mob_group_size_bounds = (distance: number): readonly [number, number] => {
  const low = ramp(distance, GROUP_SIZE_FULL_AT, 1, 6)
  const high = ramp(distance, GROUP_SIZE_HIGH_FULL_AT, 1, 6)
  return [low, high < low ? low : high]
}

/** zone_math::resource_packs — the node-count band a zone's resource packs draw from. */
export const resource_nodes_bounds = (distance: number): readonly [number, number] => [
  ramp(distance, NODES_RAMP_AT, 2, 16),
  ramp(distance, NODES_RAMP_AT, 4, 22),
]

/** The zone whose centre sits at the given block point. */
export const zone_at = (x: number, z: number): Readonly<{ zx: number; zz: number }> =>
  Object.freeze(zone_of(x, z))

/** The centre block of a zone — the point a search proves travel to. */
export const zone_center = (zx: number, zz: number): Readonly<{ x: number; z: number }> =>
  Object.freeze({ x: zx * ZONE_SIZE + ZONE_SIZE / 2, z: zz * ZONE_SIZE + ZONE_SIZE / 2 })

/** A city influencing a zone: any city within one zone on both axes (zone_math::city_index_at).
 *  A city forces its own authored roster, which for every nauvis city is the low-level starter
 *  set — so the roam steers clear of city influence when it wants stronger prey. */
export const city_of = (world: SeedWorld, zx: number, zz: number): SeedWorld['cities'][number] | null =>
  world.cities.find(
    ({ x, z }) => Math.abs(zx - Math.floor(x / ZONE_SIZE)) <= 1 && Math.abs(zz - Math.floor(z / ZONE_SIZE)) <= 1
  ) ?? null

export const world_has_mobs = (world: SeedWorld): boolean => world.mobs.length > 0

const by_entry_desc = (left: SeedWorld, right: SeedWorld): number => right.entry_level - left.entry_level

/** The world the bot fights in: the highest-entry world that HAS roaming mobs and whose entry
 *  level the character meets. Today that is always `nauvis`; a future mob world slots in here. */
export const fight_world_for_level = (level: number): SeedWorld | null =>
  worlds.filter((world) => world_has_mobs(world) && world.entry_level <= level).sort(by_entry_desc)[0] ?? null

/** The world the bot gathers in: the highest-entry world with resources the level qualifies for. */
export const gather_world_for_level = (level: number): SeedWorld | null =>
  worlds.filter((world) => world.resources.length > 0 && world.entry_level <= level).sort(by_entry_desc)[0] ?? null

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return 0
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The median family level band of a world's roster — the reference the distance dial is tuned to.
 *  Biome filtering is unknowable here, so the median stands in for "a typical family". */
export const roster_band = (world: SeedWorld): readonly [number, number] => {
  const bands = world.mobs.flatMap(({ mob_type }) => {
    const mob = mobs_by_type[mob_type]
    return mob ? [[mob.level_min, mob.level_max] as const] : []
  })
  if (bands.length === 0) return [1, 1]
  return [median(bands.map(([low]) => low)), median(bands.map(([, high]) => high))]
}

/** The distance whose scalar band lifts the median family toward the player's level. Zero when the
 *  player is already at or above the family band; the roam's trivial-check then steps farther. */
export const target_distance = (level: number, world: SeedWorld): number => {
  const [low, high] = roster_band(world)
  const scalar = high <= low ? 0 : clamp((100 * (level - high)) / (high - low), 0, LEVEL_HIGH_CAP)
  return clamp((scalar * LEVEL_RAMP_AT) / LEVEL_HIGH_CAP, MIN_ROAM_DISTANCE, MAX_ROAM_DISTANCE)
}

/** Angular nudges (radians, decreasing priority) the roam tries to escape a city's zone influence. */
const CITY_CLEARANCE_RADII: readonly number[] = Object.freeze([0, 0.06, -0.06, 0.13, -0.13, 0.26, -0.26])

const in_bounds = (x: number, z: number): boolean =>
  x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE && Number.isFinite(x) && Number.isFinite(z)

/** A zone whose centre sits ~`distance` blocks from the world centre, on the outward ray through
 *  `from`, nudged tangentially off any city. Deterministic and side-effect free. */
export const zone_at_distance = (
  world: SeedWorld,
  from: Readonly<{ x: number; z: number }>,
  distance: number
): Readonly<{ zx: number; zz: number; x: number; z: number }> => {
  const dx = from.x - WORLD_CENTER
  const dz = from.z - WORLD_CENTER
  const angle = dx === 0 && dz === 0 ? 0 : Math.atan2(dz, dx)
  const ring = clamp(distance, MIN_ROAM_DISTANCE, MAX_ROAM_DISTANCE)
  /** The dial is Chebyshev (`distance_blocks`), so place the point at that ∞-distance, not the
   *  Euclidean one — off-axis a Euclidean ring lands short and the roam re-derives the same zone. */
  const on_ring = (a: number): Readonly<{ x: number; z: number }> => {
    const cx = Math.cos(a)
    const cz = Math.sin(a)
    const norm = Math.max(Math.abs(cx), Math.abs(cz))
    return Object.freeze({ x: WORLD_CENTER + (cx * ring) / norm, z: WORLD_CENTER + (cz * ring) / norm })
  }
  for (const offset of CITY_CLEARANCE_RADII) {
    const point = on_ring(angle + offset)
    if (!in_bounds(point.x, point.z)) continue
    const { zx, zz } = zone_at(point.x, point.z)
    if (city_of(world, zx, zz)) continue
    const center = zone_center(zx, zz)
    return Object.freeze({ zx, zz, x: center.x, z: center.z })
  }
  const fallback = on_ring(angle)
  const { zx, zz } = zone_at(fallback.x, fallback.z)
  const center = zone_center(zx, zz)
  return Object.freeze({ zx, zz, x: center.x, z: center.z })
}
