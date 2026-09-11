import { describe, expect, test } from 'bun:test'

import { all_dungeons, dungeon_by_slug, key_recipe, room_mobs } from '../src/shared/dungeon_content.ts'

describe('dungeon_content', () => {
  test('loads every dungeon in the real seed content with a portal city resolved', () => {
    const dungeons = all_dungeons()
    expect(dungeons.length).toBeGreaterThan(0)
    for (const d of dungeons) {
      expect(d.key).toBe(`key_of_${d.dungeon}`)
      expect(d.room_count).toBeGreaterThan(0)
      expect(d.world.length).toBeGreaterThan(0)
    }
  })

  test('dungeon_by_slug finds a known dungeon and returns undefined for an unknown one', () => {
    const [first] = all_dungeons()
    expect(dungeon_by_slug(first!.dungeon)?.dungeon).toBe(first!.dungeon)
    expect(dungeon_by_slug('__not_a_real_dungeon__')).toBeUndefined()
  })

  test('room_mobs is 1-indexed and matches room_count', () => {
    const info = all_dungeons()[0]!
    const first_room = room_mobs(info, 1)
    expect(first_room.length).toBeGreaterThan(0)
    const last_room = room_mobs(info, info.room_count)
    expect(last_room.length).toBeGreaterThan(0)
    expect(() => room_mobs(info, info.room_count + 1)).toThrow()
    expect(() => room_mobs(info, 0)).toThrow()
  })

  test('key_recipe returns real per-attempt ingredient quantities for every known key', () => {
    for (const info of all_dungeons()) {
      const recipe = key_recipe(info.key)
      expect(recipe).toBeDefined()
      const ingredients = Object.entries(recipe!)
      expect(ingredients.length).toBeGreaterThan(0)
      for (const [, qty] of ingredients) expect(qty).toBeGreaterThan(0)
    }
  })

  test('key_recipe is undefined for a key with no known recipe', () => {
    expect(key_recipe('__not_a_real_key__')).toBeUndefined()
  })
})
