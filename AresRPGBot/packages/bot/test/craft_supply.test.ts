import { describe, expect, test } from 'bun:test'

import { item_drop_cities, plan_supply_run } from '../src/shared/craft_supply.ts'

// Craft mats that the frontier zones can't gather are city-locked mob drops. The supply-run
// planner must send the party to exactly the city whose mobs drop them — confirming the thebes
// diagnosis for the mats omori was missing (gnawed_branch / rabbit_sinew / lorito_feather).

describe('item_drop_cities — city-locked mob drop mapping', () => {
  test('gnawed_branch drops only in thebes (tinker)', () => {
    const cities = item_drop_cities('gnawed_branch')
    expect(cities.size).toBeGreaterThan(0)
    expect([...cities.keys()]).toContain('thebes')
  })

  test('rabbit_sinew and lorito_feather also map to thebes', () => {
    for (const item of ['rabbit_sinew', 'lorito_feather']) {
      const cities = item_drop_cities(item)
      expect(cities.size).toBeGreaterThan(0)
      expect([...cities.keys()]).toContain('thebes')
    }
  })
})

describe('plan_supply_run — picks the city covering the missing mats', () => {
  const START = { x: 50_000, z: 50_000 } // world centre, next to thebes (50512, 50000)
  const GENEROUS_TRAVEL_MS = 30 * 60_000

  test('a single missing thebes mat plans a thebes detour', () => {
    const plan = plan_supply_run(START, new Map([['gnawed_branch', 4]]), GENEROUS_TRAVEL_MS)
    expect(plan).not.toBeNull()
    expect(plan!.city).toBe('thebes')
    expect(plan!.coverage.get('gnawed_branch')).toBeGreaterThan(0.5)
  })

  test('covering the full omori shortage picks one city (thebes)', () => {
    const plan = plan_supply_run(
      START,
      new Map([
        ['gnawed_branch', 4],
        ['rabbit_sinew', 2],
        ['lorito_feather', 2],
      ]),
      GENEROUS_TRAVEL_MS
    )
    expect(plan).not.toBeNull()
    expect(plan!.city).toBe('thebes')
    expect(plan!.coverage.size).toBe(3)
  })

  test('a mat with no city-locked mob drop yields no plan', () => {
    // Gatherable via packs only (green_mushroom) — the farm phase handles it, never a detour.
    expect(item_drop_cities('green_mushroom').size).toBe(0)
    expect(plan_supply_run(START, new Map([['green_mushroom', 5]]), GENEROUS_TRAVEL_MS)).toBeNull()
    expect(plan_supply_run(START, new Map([['nonexistent_item', 1]]), GENEROUS_TRAVEL_MS)).toBeNull()
  })

  test('a too-tight travel budget rejects an otherwise reachable city', () => {
    const plan = plan_supply_run(START, new Map([['gnawed_branch', 4]]), 1_000)
    expect(plan).toBeNull()
  })

  test('empty shortage always yields no plan', () => {
    expect(plan_supply_run(START, new Map(), GENEROUS_TRAVEL_MS)).toBeNull()
  })
})