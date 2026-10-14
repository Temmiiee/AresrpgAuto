// Vendored biome grid — the engine's `sample_biome_grid` reduced to "which biome is this zone?".
//
// The server places a zone's resource packs by filtering each world's authored resources by the
// zone's BIOME (`zone_spawns.ts` -> `world_map::biome_of_zone`), and that biome is a pure function
// of the world terrain seed (climate noise -> one of nine `BIOME_SLOTS`). The whole computation is
// a handful of functions over `simplex-noise`, so the bot vendors them here instead of describing a
// distance dial and hoping. This is a line-for-line port of `aresrpg/packages/engine/src/
// world_noise.ts` + `world_recipe.ts` + `biome_grid.ts`; the only dependency is `simplex-noise`.
//
// With this the bot can answer "which zone should I stand in to find <resource>?" — the missing
// half of the gather excursion (zone_map.ts can only answer "how far out", never "which family").
import { createNoise2D } from 'simplex-noise'

import { worlds, type SeedWorld } from './catalog.ts'
import worlds_source from '../../../../seed/content/worlds.json'

// ── world_noise.ts ───────────────────────────────────────────────────
const U64_MASK = (1n << 64n) - 1n
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n

export const derive_sub_seed = (seed: string, name: string): number => {
  let hash = 0xcbf29ce484222325n
  const input = `${seed}:${name}`
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash ^ BigInt(input.charCodeAt(index))) & U64_MASK
    hash = (hash * 0x100000001b3n) & U64_MASK
  }
  let mixed = (hash + GOLDEN_GAMMA) & U64_MASK
  mixed = ((mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK
  mixed = ((mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn) & U64_MASK
  mixed ^= mixed >> 31n
  return Number(mixed & 0xffffffffn) >>> 0
}

type Alea = (() => number) & { uint32: () => number }

const make_mash = (): ((data: string) => number) => {
  let n = 0xefc8249d
  return (data) => {
    for (let index = 0; index < data.length; index += 1) {
      n += data.charCodeAt(index)
      let h = 0.02519603282416938 * n
      n = h >>> 0
      h -= n
      h *= n
      n = h >>> 0
      h -= n
      n += h * 0x100000000
    }
    return (n >>> 0) * 2.3283064365386963e-10
  }
}

export const alea = (seed: number | string): Alea => {
  const mash = make_mash()
  let s0 = mash(' ')
  let s1 = mash(' ')
  let s2 = mash(' ')
  let carry = 1
  const key = String(seed)
  s0 -= mash(key)
  if (s0 < 0) s0 += 1
  s1 -= mash(key)
  if (s1 < 0) s1 += 1
  s2 -= mash(key)
  if (s2 < 0) s2 += 1
  const random = (() => {
    const value = 2091639 * s0 + carry * 2.3283064365386963e-10
    s0 = s1
    s1 = s2
    carry = value | 0
    s2 = value - carry
    return s2
  }) as Alea
  random.uint32 = () => random() * 0x100000000
  return random
}

const integer_power = (base: number, exponent: number): number => {
  let result = 1
  for (let index = 0; index < exponent; index += 1) result *= base
  return result
}

type NoiseField = Readonly<{ period: number; octaves: number; spread?: number; gain?: number }>

const create_octave_sampler = (
  seed: number,
  { period, octaves, spread = 2, gain = 0.5 }: NoiseField,
  shape: (noise: number) => number
): ((x: number, z: number) => number) => {
  const noise = createNoise2D(alea(seed))
  const frequencies = Array.from({ length: octaves }, (_, index) => integer_power(spread, index) / period)
  const amplitudes = Array.from({ length: octaves }, (_, index) => integer_power(gain, index))
  const amplitude_sum = amplitudes.reduce((sum, amplitude) => sum + amplitude, 0)
  return (x, z) => {
    let value = 0
    for (let index = 0; index < octaves; index += 1)
      value += shape(noise(x * frequencies[index]!, z * frequencies[index]!)) * amplitudes[index]!
    return Math.max(0, Math.min(1, value / amplitude_sum))
  }
}

const create_fbm_sampler = (seed: number, field: NoiseField): ((x: number, z: number) => number) =>
  create_octave_sampler(seed, field, (noise) => noise * 0.5 + 0.5)

// ── world_recipe.ts (climate + biome selection) ──────────────────────
const BIOME_SLOTS = [
  'low_low',
  'low_mid',
  'low_high',
  'mid_low',
  'mid_mid',
  'mid_high',
  'high_low',
  'high_mid',
  'high_high',
] as const
type ClimateBand = 'low' | 'mid' | 'high'

const CLIMATE_FIELDS: NoiseField = Object.freeze({ period: 8192, octaves: 6, spread: 2, gain: 0.5 })
const GROUND_FIELD: NoiseField = Object.freeze({ period: 2048, octaves: 6, spread: 2, gain: 0.52 })

const balance_climate = (value: number): number => Math.max(0, Math.min(1, (value - 0.5) * 1.5 + 0.5))

const climate_band_weights = (value: number): Readonly<Record<ClimateBand, number>> => {
  if (value <= 0.3) return { low: 1, mid: 0, high: 0 }
  if (value < 0.4) {
    const progress = (value - 0.3) / 0.1
    const mid = progress * progress * (3 - 2 * progress)
    return { low: 1 - mid, mid, high: 0 }
  }
  if (value <= 0.6) return { low: 0, mid: 1, high: 0 }
  if (value < 0.7) {
    const progress = (value - 0.6) / 0.1
    const high = progress * progress * (3 - 2 * progress)
    return { low: 0, mid: 1 - high, high }
  }
  return { low: 0, mid: 0, high: 1 }
}

/** Raw terrain row the server compiles: the published `seed/content/worlds.json` shape. */
type RawTerrain = Readonly<{
  seed: string
  biomes: readonly Readonly<{ name: string }>[]
  biome_slots: Readonly<Record<string, string>>
  ocean?: Readonly<{ biome: string; ground_max: number }>
}>

type CompiledBiome = Readonly<{
  biomeNames: readonly string[]
  /** slot name -> biome name (validated against `biomes`) */
  slots: Readonly<Record<string, string>>
  ocean: Readonly<{ biome: string; ground_max: number }> | null
  temperature: (x: number, z: number) => number
  humidity: (x: number, z: number) => number
  ground: (x: number, z: number) => number
}>

const compile_terrain = (terrain: RawTerrain): CompiledBiome => {
  const biomeNames = terrain.biomes.map((biome) => biome.name)
  const known = new Set(biomeNames)
  const slots: Record<string, string> = {}
  for (const slot of BIOME_SLOTS) {
    const name = terrain.biome_slots[slot]
    if (name === undefined) throw new Error(`terrain ${terrain.seed}: biome_slots.${slot} is missing`)
    if (!known.has(name)) throw new Error(`terrain ${terrain.seed}: slot ${slot} names unknown biome ${name}`)
    slots[slot] = name
  }
  const ocean = terrain.ocean
    ? Object.freeze({ biome: terrain.ocean.biome, ground_max: terrain.ocean.ground_max })
    : null
  if (ocean && !known.has(ocean.biome)) throw new Error(`terrain ${terrain.seed}: ocean names unknown biome`)
  return Object.freeze({
    biomeNames,
    slots: Object.freeze(slots),
    ocean,
    temperature: create_fbm_sampler(derive_sub_seed(terrain.seed, 'temperature'), CLIMATE_FIELDS),
    humidity: create_fbm_sampler(derive_sub_seed(terrain.seed, 'humidity'), CLIMATE_FIELDS),
    ground: create_fbm_sampler(derive_sub_seed(terrain.seed, 'ground'), GROUND_FIELD),
  })
}

/** The biome NAME at one world column — `sample_world_column(...).biome` without the terrain stack. */
const column_biome = (world: CompiledBiome, x: number, z: number): string => {
  const ground = Math.max(0, Math.min(1, (world.ground(x, z) - 0.5) * 2 ** 0.42 + 0.5))
  if (world.ocean && ground < world.ocean.ground_max) return world.ocean.biome
  const temperature = climate_band_weights(balance_climate(world.temperature(x, z)))
  const humidity = climate_band_weights(balance_climate(world.humidity(x, z)))
  const weights: Record<string, number> = {}
  for (const slot of BIOME_SLOTS) {
    const [temperature_band, humidity_band] = slot.split('_') as [ClimateBand, ClimateBand]
    const weight = temperature[temperature_band] * humidity[humidity_band]
    const name = world.slots[slot]!
    weights[name] = (weights[name] ?? 0) + weight
  }
  let selected = ''
  let selected_weight = -1
  for (const [name, weight] of Object.entries(weights)) {
    if (weight > selected_weight) {
      selected = name
      selected_weight = weight
    }
  }
  return selected
}

const CELL_SAMPLES_PER_AXIS = 4

/** `sample_biome_cell` — 4×4 plurality with the centre breaking ties, exactly as the engine (the
 *  reduce walks candidate indexes in order, so a tie always resolves to the lower index). */
const cell_biome = (world: CompiledBiome, column: number, row: number, cell_size: number, center: number): string => {
  const counts = new Map<string, number>()
  for (let sample = 0; sample < CELL_SAMPLES_PER_AXIS ** 2; sample += 1) {
    const sample_row = Math.floor(sample / CELL_SAMPLES_PER_AXIS)
    const sample_column = sample % CELL_SAMPLES_PER_AXIS
    const x = column * cell_size + ((sample_column + 0.5) * cell_size) / CELL_SAMPLES_PER_AXIS - center
    const z = row * cell_size + ((sample_row + 0.5) * cell_size) / CELL_SAMPLES_PER_AXIS - center
    const biome = column_biome(world, x, z)
    counts.set(biome, (counts.get(biome) ?? 0) + 1)
  }
  const center_biome = column_biome(world, column * cell_size + cell_size / 2 - center, row * cell_size + cell_size / 2 - center)
  let selected = center_biome
  let selected_count = counts.get(center_biome) ?? 0
  // Index order = biomeNames order in the engine; the engine's reduce resolves ties to the lower
  // INDEX. Re-walk the engine's own candidate order to keep the tie-break identical.
  for (const name of world.biomeNames) {
    const count = counts.get(name) ?? 0
    if (count > selected_count) {
      selected_count = count
      selected = name
    }
  }
  return selected
}

// ── public API ───────────────────────────────────────────────────────
/** The chain's world is a fixed 100,000-block square of 32-block zones centred on (50,000, 50,000). */
const ZONE_SIZE = 32
const WORLD_SIZE = 100_000
const WORLD_CENTER = 50_000
/** Published window side: `ceil(world_size / cell_size)` = 3,125 (exactly `world_size / zone`). */
export const BIOME_GRID_SIDE = Math.ceil(WORLD_SIZE / ZONE_SIZE)

const terrain_by_world: Readonly<Record<string, RawTerrain | null>> = (() => {
  const rows = worlds_source as unknown as readonly Readonly<{ world: string; terrain?: RawTerrain }>[]
  return Object.freeze(Object.fromEntries(rows.map((row) => [row.world, row.terrain ?? null])))
})()

const compiled = new Map<string, CompiledBiome | null>()

const terrain_of = (world: string): CompiledBiome | null => {
  if (!compiled.has(world)) {
    const terrain = terrain_by_world[world]
    compiled.set(world, terrain ? compile_terrain(terrain) : null)
  }
  return compiled.get(world) ?? null
}

const biome_cache = new Map<string, string>()

/** The biome NAME of a zone, or null when the world has no terrain. Pure and memoized. */
export const biome_of_zone = (world: string, zx: number, zz: number): string | null => {
  const key = `${world}:${zx}:${zz}`
  const cached = biome_cache.get(key)
  if (cached !== undefined) return cached
  const compiled_world = terrain_of(world)
  if (!compiled_world) return null
  const last = BIOME_GRID_SIDE - 1
  const cx = Math.min(Math.max(zx, 0), last)
  const cz = Math.min(Math.max(zz, 0), last)
  const biome = cell_biome(compiled_world, cx, cz, ZONE_SIZE, WORLD_CENTER)
  biome_cache.set(key, biome)
  return biome
}

const zone_center = (zx: number, zz: number): Readonly<{ x: number; z: number }> =>
  Object.freeze({ x: zx * ZONE_SIZE + ZONE_SIZE / 2, z: zz * ZONE_SIZE + ZONE_SIZE / 2 })

/** zone_math::city_index_at — any city within one zone on both axes forces its own roster. */
const city_name_of = (world: SeedWorld, zx: number, zz: number): string | null =>
  world.cities.find(
    ({ x, z }) => Math.abs(zx - Math.floor(x / ZONE_SIZE)) <= 1 && Math.abs(zz - Math.floor(z / ZONE_SIZE)) <= 1
  )?.city ?? null

/** Whether a world's resource can spawn in a zone: a city zone forces its own roster, every other
 *  zone draws by biome. */
export const resource_eligible_at = (world: SeedWorld, item_type: string, zx: number, zz: number): boolean => {
  const resource = world.resources.find((row) => row.item_type === item_type)
  if (!resource) return false
  const city = city_name_of(world, zx, zz)
  if (city) return resource.cities.includes(city)
  const biome = biome_of_zone(world.world, zx, zz)
  return biome !== null && resource.biomes.includes(biome)
}

export type ResourceZone = Readonly<{
  world: string
  zx: number
  zz: number
  x: number
  z: number
  biome: string
  kind: 'biome' | 'city'
}>

/** A resource's world, or null when no world places it (tiers 7-11 have no world). */
export const world_of_resource = (item_type: string): string | null =>
  worlds.find((world) => world.resources.some((resource) => resource.item_type === item_type))?.world ?? null

/** The nearest zone to `from` where `item_type` can spawn, scanning outward by Chebyshev ring and
 *  stopping at the first hit. `max_ring` bounds the search (each ring is one zone step = 32 blocks). */
export const find_resource_zone = (
  world: string,
  item_type: string,
  from_x: number,
  from_z: number,
  max_ring = 256
): ResourceZone | null => {
  const seed_world = worlds.find((row) => row.world === world)
  if (!seed_world) return null
  const resource = seed_world.resources.find((row) => row.item_type === item_type)
  if (!resource) return null
  const from = { zx: Math.floor(from_x / ZONE_SIZE), zz: Math.floor(from_z / ZONE_SIZE) }
  const hit = (zx: number, zz: number): ResourceZone | null => {
    if (zx < 0 || zz < 0 || zx >= BIOME_GRID_SIDE || zz >= BIOME_GRID_SIDE) return null
    if (!resource_eligible_at(seed_world, item_type, zx, zz)) return null
    const city = city_name_of(seed_world, zx, zz)
    const biome = biome_of_zone(world, zx, zz)
    if (biome === null) return null
    const center = zone_center(zx, zz)
    return Object.freeze({ world, zx, zz, x: center.x, z: center.z, biome, kind: city ? 'city' : 'biome' })
  }
  if (max_ring <= 0) return hit(from.zx, from.zz)
  for (let ring = 0; ring <= max_ring; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
        const found = hit(from.zx + dx, from.zz + dz)
        if (found) return found
      }
    }
  }
  return null
}
