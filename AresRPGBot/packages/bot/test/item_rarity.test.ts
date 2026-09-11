// item_rarity.ts persists to a real file (item_rarity.local.json, gitignored) shared with
// whatever this machine's own bot session has recorded from real fights. These tests back that
// file up before running and restore it exactly afterward (deleting it again if it didn't exist),
// so a test run never permanently mutates real recorded rarity data — and use item_type names no
// real mob loot table could ever produce, so a run in the middle of these tests never collides
// with anything genuinely being recorded elsewhere.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { rarity_chance_bp, rarity_tier, record_loot_table } from '../src/market/item_rarity.ts'

const STORE_PATH = fileURLToPath(new URL('../item_rarity.local.json', import.meta.url))
let existed_before = false
let backup: string | null = null

beforeAll(() => {
  existed_before = existsSync(STORE_PATH)
  if (existed_before) backup = readFileSync(STORE_PATH, 'utf8')
})

afterAll(() => {
  if (existed_before && backup !== null) writeFileSync(STORE_PATH, backup)
  else rmSync(STORE_PATH, { force: true })
})

// Reset to empty before EACH test too, so tests don't leak state into each other regardless of
// run order.
beforeEach(() => {
  writeFileSync(STORE_PATH, '{}\n')
})

const EPIC_ITEM = '__test_rarity_epic__'
const COMMON_ITEM = '__test_rarity_common__'
const NEVER_SEEN_ITEM = '__test_rarity_never_seen__'

describe('rarity_tier / rarity_chance_bp', () => {
  test('an item never seen on any fought mob is null, not "common"', () => {
    expect(rarity_tier(NEVER_SEEN_ITEM)).toBeNull()
    expect(rarity_chance_bp(NEVER_SEEN_ITEM)).toBeNull()
  })

  test('buckets a recorded chance_bp into the right tier at each threshold', () => {
    record_loot_table([
      { item_type: EPIC_ITEM, chance_bp: 18 }, // < 500 -> epic
      { item_type: '__test_rarity_rare__', chance_bp: 1200 }, // <= 2000 -> rare
      { item_type: '__test_rarity_uncommon__', chance_bp: 4000 }, // <= 6000 -> uncommon
      { item_type: COMMON_ITEM, chance_bp: 8000 }, // > 6000 -> common
    ])
    expect(rarity_tier(EPIC_ITEM)).toBe('epic')
    expect(rarity_tier('__test_rarity_rare__')).toBe('rare')
    expect(rarity_tier('__test_rarity_uncommon__')).toBe('uncommon')
    expect(rarity_tier(COMMON_ITEM)).toBe('common')
    expect(rarity_chance_bp(EPIC_ITEM)).toBe(18)
  })

  test('only ever LOWERS a recorded chance_bp, never raises it', () => {
    record_loot_table([{ item_type: COMMON_ITEM, chance_bp: 3000 }])
    expect(rarity_chance_bp(COMMON_ITEM)).toBe(3000)

    // A later, MORE common sighting (higher chance_bp) must not un-learn the rarer one.
    record_loot_table([{ item_type: COMMON_ITEM, chance_bp: 9000 }])
    expect(rarity_chance_bp(COMMON_ITEM)).toBe(3000)

    // A later, RARER sighting (lower chance_bp) does update it.
    record_loot_table([{ item_type: COMMON_ITEM, chance_bp: 100 }])
    expect(rarity_chance_bp(COMMON_ITEM)).toBe(100)
  })

  test('an empty loot table is a no-op', () => {
    record_loot_table([])
    expect(rarity_chance_bp(NEVER_SEEN_ITEM)).toBeNull()
  })
})
