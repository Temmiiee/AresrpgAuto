// zone_map tests — the distance dial must stay a faithful port of zone_math, because the roam
// trusts it to predict what the chain will spawn. A silent drift here sends the bot to the wrong
// ring (the Old bot's trivial-prey death spiral).
import { describe, expect, it } from 'bun:test'

import {
  MAX_ROAM_DISTANCE,
  MIN_ROAM_DISTANCE,
  city_of,
  distance_blocks,
  fight_world_for_level,
  gather_world_for_level,
  mob_group_size_bounds,
  mob_level_scalar_bounds,
  resource_nodes_bounds,
  roster_band,
  target_distance,
  world_has_mobs,
  zone_at,
  zone_at_distance,
} from '../src/content/zone_map.ts'
import { worlds_by_id } from '../src/content/catalog.ts'

const nauvis = worlds_by_id['nauvis']!

describe('zone_map distance_blocks', () => {
  it('is the Chebyshev distance from the world centre to the zone CENTRE', () => {
    // Thebes zone 98:97 → centre (50432, 49920) → max(432, 80).
    expect(distance_blocks(98, 97)).toBe(432)
    expect(distance_blocks(97, 97)).toBe(80)
    // A symmetric far zone is its own Chebyshev distance on both axes.
    expect(distance_blocks(100, 100)).toBe(1_456)
  })
})

describe('zone_map ramps (zone_math twin)', () => {
  it('mob level scalar band ramps 0..75/100 over 20,000 blocks', () => {
    expect(mob_level_scalar_bounds(0)).toEqual([0, 0])
    expect(mob_level_scalar_bounds(10_000)).toEqual([37, 50])
    expect(mob_level_scalar_bounds(20_000)).toEqual([75, 100])
    expect(mob_level_scalar_bounds(50_000)).toEqual([75, 100])
  })

  it('group size band ramps 1..6 (high edge later)', () => {
    expect(mob_group_size_bounds(0)).toEqual([1, 1])
    expect(mob_group_size_bounds(3_000)).toEqual([2, 5])
    expect(mob_group_size_bounds(10_000)).toEqual([6, 6])
  })

  it('resource node band ramps 2..16 / 4..22 over 20,000 blocks', () => {
    expect(resource_nodes_bounds(0)).toEqual([2, 4])
    expect(resource_nodes_bounds(20_000)).toEqual([16, 22])
  })
})

describe('zone_map cities', () => {
  it('recognises city influence within one zone', () => {
    expect(city_of(nauvis, 98, 97)?.city).toBe('thebes')
    expect(city_of(nauvis, 97, 98)?.city).toBe('thebes')
    expect(city_of(nauvis, 136, 97)).toBeNull()
  })
})

describe('zone_map worlds', () => {
  it('picks the highest-entry world that actually has mobs', () => {
    expect(world_has_mobs(worlds_by_id['yakutia']!)).toBe(false)
    expect(fight_world_for_level(1)?.world).toBe('nauvis')
    expect(fight_world_for_level(20)?.world).toBe('nauvis')
    expect(gather_world_for_level(1)?.world).toBe('nauvis')
    expect(gather_world_for_level(20)?.world).toBe('yakutia')
  })
})

describe('zone_map target distance', () => {
  it('reads the median family band of the roster', () => {
    expect(roster_band(nauvis)).toEqual([3, 14])
  })

  it('never camps the centre and never walks past the ramp', () => {
    expect(target_distance(1, nauvis)).toBe(MIN_ROAM_DISTANCE)
    expect(target_distance(12, nauvis)).toBe(MIN_ROAM_DISTANCE)
    expect(target_distance(200, nauvis)).toBe(MAX_ROAM_DISTANCE)
  })

  it('increases with a higher level', () => {
    expect(target_distance(20, nauvis)).toBeGreaterThan(target_distance(15, nauvis))
    expect(target_distance(30, nauvis)).toBeGreaterThanOrEqual(target_distance(20, nauvis))
  })
})

describe('zone_map zone_at_distance', () => {
  it('lands on the outward ray and clears the city', () => {
    const from = { x: 50_512, z: 50_000 } // standing in thebes
    const target = zone_at_distance(nauvis, from, 20_000)
    expect(target.zx).toBe(136)
    expect(target.zz).toBe(97)
    expect(city_of(nauvis, target.zx, target.zz)).toBeNull()
  })

  it('recovers a zone for the centre-only pose', () => {
    const target = zone_at_distance(nauvis, { x: 50_000, z: 50_000 }, 4_000)
    expect(zone_at(target.x, target.z)).toEqual({ zx: target.zx, zz: target.zz })
    expect(city_of(nauvis, target.zx, target.zz)).toBeNull()
  })

  it('places an off-axis ring at the Chebyshev distance, not the Euclidean one', () => {
    // Zone 98:98 centre (50,432, 50,432) is a 45° ray: a Euclidean 20,000 ring would land at
    // Chebyshev ~14,142, but the difficulty dial is Chebyshev, so it must sit near 20,000.
    const target = zone_at_distance(nauvis, { x: 50_432, z: 50_432 }, 20_000)
    const landed = distance_blocks(target.zx, target.zz)
    expect(landed).toBeGreaterThan(19_000)
    expect(landed).toBeLessThanOrEqual(MAX_ROAM_DISTANCE)
  })

  it('does not stall: re-deriving from the landed centre returns the same zone', () => {
    const first = zone_at_distance(nauvis, { x: 50_432, z: 50_432 }, 20_000)
    const again = zone_at_distance(nauvis, { x: first.x, z: first.z }, 20_000)
    expect(again.zx).toBe(first.zx)
    expect(again.zz).toBe(first.zz)
  })
})
