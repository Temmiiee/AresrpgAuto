import { describe, expect, test } from 'bun:test'

import { seek_easier_zone, seek_ideal_zone, travel_time_ms, zone_levels } from '../src/shared/zone_relocation.ts'

// Zone indices 0..195; world centre at (50_000, 50_000) → zone (97,97) holds the centre.
// Zone level band = f(Chebyshev distance of the zone's centre to the world centre), mirrored
// from aresrpg_math::zone_math (level ramp 0→100 over 20_000 blocks).

describe('zone_levels — deterministic band from zone coordinates', () => {
  test('world centre zone (97,97) is the level-0 spawn band', () => {
    expect(zone_levels(97, 97)).toEqual({ lo: 0, hi: 0 })
  })

  test('one zone east of centre (98,97) ramps to lo 1 / hi 2', () => {
    // district centre (50432, 49920) → distance 432 → lo = floor(75*432/20000)=1, hi = floor(100*432/20000)=2.
    expect(zone_levels(98, 97)).toEqual({ lo: 1, hi: 2 })
  })

  test('world corner (0,0) is already at the level cap', () => {
    // distance 49_744 ≥ LEVEL_RAMP_AT → lo 75, hi 100.
    expect(zone_levels(0, 0)).toEqual({ lo: 75, hi: 100 })
  })

  test('ramps with distance and floors like the move u64 division', () => {
    // District centre (53504, 49920) → distance 3504 → lo = floor(75*3504/20000)=13, hi=17.
    expect(zone_levels(104, 97)).toEqual({ lo: 13, hi: 17 })
    // District centre (52992, 49920) → distance 2992 → hi = floor(100*2992/20000)=14.
    expect(zone_levels(103, 97)).toEqual({ lo: Math.floor((75 * 2992) / 20000), hi: 14 })
  })
})

describe('seek_ideal_zone — walks the outward ray to a party-fitting band', () => {
  const SPAWN = { x: 49_728, z: 49_728 } // mid (97,97)

  test('level-11 party in the spawn band walks outward to the zone topping out at lv 15', () => {
    // target hi = 11 + 4 = 15. The walk takes the strictly-outermost neighbour each step (a
    // deterministic tie-free rule); with the world centre 336 blocks into the west edge of zone
    // (97,97), westward moves gain distance faster than eastward ones, so it lands on zone
    // (91,97) at lv 11..15 — the first zone whose top band clears the target.
    expect(seek_ideal_zone(SPAWN, 11)).toEqual({ x: 46_848, z: 49_920 })
    expect(zone_levels(91, 97)).toEqual({ lo: 11, hi: 15 })
  })

  test('does not relocate when the current zone is already at/above the party', () => {
    // (91,97) tops out at 15; a level-11 party has no reason to walk.
    expect(seek_ideal_zone({ x: 46_848, z: 49_920 }, 11)).toBeNull()
    // A level-8 party in a hi-14 zone stays put as well: 14 + 3 ≥ 8.
    expect(seek_ideal_zone({ x: 52_992, z: 49_920 }, 8)).toBeNull()
  })

  test('fresher parties in the spawn band stay put (gap still too small to justify a walk)', () => {
    // Level 1: the zone tops at 0, but 0 + RELOCATE_MIN_GAP(2) ≥ 1 → nothing to walk toward.
    expect(seek_ideal_zone(SPAWN, 1)).toBeNull()
  })

  test('a level-3 party now leaves the spawn band for the first band topping at/beyond party+bonus', () => {
    // target hi = 3 + 4 = 7 → the walk along the west ray stops at zone (94,97) at lv 6..8.
    expect(seek_ideal_zone(SPAWN, 3)).toEqual({ x: 48_384, z: 49_920 })
    expect(zone_levels(94, 97).hi).toBeGreaterThanOrEqual(7)
  })

  test('walks further out the higher the party level', () => {
    // Level 21: target hi 25 → zone (87,97) at lv 19..26.
    expect(seek_ideal_zone(SPAWN, 21)).toEqual({ x: 44_800, z: 49_920 })
    expect(zone_levels(87, 97).hi).toBeGreaterThanOrEqual(24)
  })

  test('max-level party still walks only toward the cap, never past it', () => {
    // party 100: target hi = min(103, 95) = 95 → zone (60,97) at lv 71..95.
    const target = seek_ideal_zone(SPAWN, 100)
    expect(target).not.toBeNull()
    expect(zone_levels(target!.x / 512, target!.z / 512).hi).toBe(95)
  })

  test('keeps the walking zone within the world bounds', () => {
    const target = seek_ideal_zone(SPAWN, 100)
    expect(target!.x).toBeLessThanOrEqual(100_000)
    expect(target!.z).toBeLessThanOrEqual(100_000)
  })

  test('corner zone (0,0) is never underleveled, so it never walks', () => {
    expect(seek_ideal_zone({ x: 256, z: 256 }, 11)).toBeNull()
  })
})

describe('seek_easier_zone — walks inward out of a too-hard zone', () => {
  const DEAD = { x: 46_336, z: 49_920 } // zone (90,97), band 13..18

  test('backs off to the outermost zone whose top band is at or below the target', () => {
    // target 11 → first inward zone with hi ≤ 11 is (93,97) at lv 7..10.
    expect(seek_easier_zone(DEAD, 11)).toEqual({ x: 47_872, z: 49_920 })
    expect(zone_levels(93, 97)).toEqual({ lo: 7, hi: 10 })
  })

  test('returns null when the starting zone is already at or below the target', () => {
    expect(seek_easier_zone({ x: 47_872, z: 49_920 }, 10)).toBeNull()
    // Spawn band is level 0 — always easy enough.
    expect(seek_easier_zone({ x: 49_728, z: 49_728 }, 2)).toBeNull()
  })

  test('descends monotonically toward the world centre for any target', () => {
    const target = seek_easier_zone(DEAD, 2)
    expect(target).not.toBeNull()
    expect(zone_levels(target!.x / 512, target!.z / 512).hi).toBeLessThanOrEqual(2)
    // Next inward hop keeps the band from being any higher.
    const next = seek_easier_zone(target!, 2)
    expect(next).toBeNull()
  })

  test('a max-level corner band walks inward only until it clears the target', () => {
    const target = seek_easier_zone({ x: 256, z: 256 }, 95)
    expect(target).not.toBeNull()
    expect(zone_levels(target!.x / 512, target!.z / 512).hi).toBeLessThanOrEqual(95)
    expect(zone_levels(target!.x / 512, target!.z / 512).hi).toBeGreaterThanOrEqual(90)
  })
})

describe('travel_time_ms — matches the world_map::travel_ok speed budget', () => {
  test('waits the scaled Euclidean distance plus the 4s margin', () => {
    // 3584 blocks at 1150 blocks/100_000ms → ceil(311652.17) = 311653 + 4000 = 315653.
    expect(travel_time_ms({ x: 49_920, z: 49_920 }, { x: 53_504, z: 49_920 })).toBe(315_653)
  })

  test('a mounted leg waits the ×1.5 pet budget (world.move PET_NUM/PET_DEN = 3/2)', () => {
    // 3584 blocks at 1725 blocks/100_000ms → ceil(207768.11) = 207769 + 4000 = 211769.
    expect(travel_time_ms({ x: 49_920, z: 49_920 }, { x: 53_504, z: 49_920 }, true)).toBe(211_769)
    expect(travel_time_ms({ x: 49_920, z: 49_920 }, { x: 53_504, z: 49_920 }, true)).toBeLessThan(
      travel_time_ms({ x: 49_920, z: 49_920 }, { x: 53_504, z: 49_920 })
    )
  })

  test('zero distance still pays the safety margin', () => {
    const here = { x: 50_000, z: 50_000 }
    expect(travel_time_ms(here, here)).toBe(4_000)
    expect(travel_time_ms(here, here, true)).toBe(4_000)
  })
})