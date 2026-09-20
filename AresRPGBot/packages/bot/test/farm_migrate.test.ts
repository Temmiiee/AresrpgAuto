import { describe, expect, test } from 'bun:test'

import { chunked_landing, farm_regions, nearest_region, next_region } from '../src/farm/farm_migrate.ts'
import { travel_time_ms } from '../src/shared/zone_relocation.ts'

// Region migration picks the NEXT city region for a drained farm. Pure seed reads — the seed's
// worlds.json cities are the anchors (thebes 50512/50000, the_ruins 36064/48672, fuwage 14240/22688).

const THEBES = { x: 50_512, z: 50_000 }
const THE_RUINS = { x: 36_064, z: 48_672 }
const FUWAGE = { x: 14_240, z: 22_688 }

describe('farm_regions — the nauvis city anchors', () => {
  test('reads the three city regions from the seed', () => {
    const regions = farm_regions()
    expect(regions.length).toBeGreaterThanOrEqual(3)
    const by_city = new Map(regions.map((r) => [r.city, r]))
    expect(by_city.get('thebes')).toMatchObject(THEBES)
    expect(by_city.get('the_ruins')).toMatchObject(THE_RUINS)
    expect(by_city.get('fuwage')).toMatchObject(FUWAGE)
  })
})

describe('nearest_region — where the farm is right now', () => {
  test('each city sits in its own region', () => {
    const regions = farm_regions()
    expect(nearest_region(THEBES, regions)?.city).toBe('thebes')
    expect(nearest_region(THE_RUINS, regions)?.city).toBe('the_ruins')
    expect(nearest_region(FUWAGE, regions)?.city).toBe('fuwage')
  })

  test('world centre belongs to thebes; a deep-south-west point to fuwage', () => {
    const regions = farm_regions()
    expect(nearest_region({ x: 50_000, z: 50_000 }, regions)?.city).toBe('thebes')
    expect(nearest_region({ x: 17_000, z: 24_000 }, regions)?.city).toBe('fuwage')
  })

  test('no regions → null', () => {
    expect(nearest_region(THEBES, [])).toBeNull()
  })
})

describe('next_region — the rotation target never oscillates', () => {
  const REGIONS = farm_regions()

  test('from thebes, the nearest unvisited region is the_ruins (amber tier-2 ground)', () => {
    const chosen = next_region(THEBES, REGIONS, new Set())
    expect(chosen).not.toBeNull()
    expect(chosen!.region.city).toBe('the_ruins')
    expect(chosen!.cycled).toBe(false)
  })

  test('an already-visited region is skipped, so the farm keeps marching on', () => {
    const chosen = next_region(THEBES, REGIONS, new Set(['the_ruins']))
    expect(chosen!.region.city).toBe('fuwage')
  })

  test('when every other region was visited the rotation restarts (cycled)', () => {
    const chosen = next_region(THEBES, REGIONS, new Set(['the_ruins', 'fuwage']))
    expect(chosen).not.toBeNull()
    expect(chosen!.cycled).toBe(true)
    expect(chosen!.region.city).toBe('the_ruins')
  })

  test('the current region is never a target — the farm is already there', () => {
    const chosen = next_region(THEBES, REGIONS, new Set(['thebes']))
    expect(chosen!.region.city).not.toBe('thebes')
  })

  test('no regions → null', () => {
    expect(next_region(THEBES, [], new Set())).toBeNull()
  })
})

describe('chunked_landing — a bounded migration leg', () => {
  const THIRTY_MIN_MS = 30 * 60_000

  test('a walk that fits the budget lands exactly on the target city centre', () => {
    // thebes → the_ruins ≈ 21 min — well inside a 30-min leg.
    expect(chunked_landing(THEBES, THE_RUINS, THIRTY_MIN_MS)).toEqual(THE_RUINS)
  })

  test('a marathon walk is chunked to the furthest zone centre within the budget', () => {
    const landing = chunked_landing(THEBES, FUWAGE, 25 * 60_000)
    expect(landing).not.toEqual(FUWAGE)
    // The leg stays inside the travel budget modulo the ≤~half-zone centre snap.
    expect(travel_time_ms(THEBES, landing)).toBeLessThanOrEqual(25 * 60_000 + 30_000)
    // And lands strictly closer to home than the far city, at a zone centre.
    expect(Math.hypot(landing.x - THEBES.x, landing.z - THEBES.z)).toBeLessThan(
      Math.hypot(FUWAGE.x - THEBES.x, FUWAGE.z - THEBES.z)
    )
    expect(landing.x % 512).toBe(256)
    expect(landing.z % 512).toBe(256)
  })

  test('a next migration continues the rest of the distance from the landing', () => {
    const first = chunked_landing(THEBES, FUWAGE, 25 * 60_000)
    const second = chunked_landing(first, FUWAGE, 25 * 60_000)
    expect(Math.hypot(first.x - FUWAGE.x, first.z - FUWAGE.z)).toBeGreaterThan(
      Math.hypot(second.x - FUWAGE.x, second.z - FUWAGE.z)
    )
  })

  test('a tiny budget still lands at a (bounded) zone centre, never past home', () => {
    const landing = chunked_landing(THEBES, FUWAGE, 10_000)
    expect(travel_time_ms(THEBES, landing)).toBeLessThanOrEqual(10_000 + 30_000)
    expect(Math.hypot(landing.x - THEBES.x, landing.z - THEBES.z)).toBeLessThanOrEqual(
      Math.hypot(FUWAGE.x - THEBES.x, FUWAGE.z - THEBES.z)
    )
  })

  test('a mounted leg covers more ground per chunk (×1.5 speed), never past the budget', () => {
    const plain = chunked_landing(THEBES, FUWAGE, 25 * 60_000)
    const mounted = chunked_landing(THEBES, FUWAGE, 25 * 60_000, true)
    // The mounted leg is clock-limited the same way but covers 1.5× the blocks.
    expect(travel_time_ms(THEBES, mounted, true)).toBeLessThanOrEqual(25 * 60_000 + 30_000)
    expect(Math.hypot(mounted.x - THEBES.x, mounted.z - THEBES.z)).toBeGreaterThan(
      Math.hypot(plain.x - THEBES.x, plain.z - THEBES.z)
    )
    expect(mounted.x % 512).toBe(256)
    expect(mounted.z % 512).toBe(256)
  })

  test('a mounted short walk still lands exactly on the target city centre', () => {
    // thebes → the_ruins ≈ 14 min mounted — well inside a 30-min leg.
    expect(chunked_landing(THEBES, THE_RUINS, THIRTY_MIN_MS, true)).toEqual(THE_RUINS)
  })
})