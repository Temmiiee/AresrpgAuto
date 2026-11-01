// Dungeon content projection — the runner reads rooms and the city portal straight from the seed.
import {
  DUNGEON_KEYS,
  DUNGEON_PARK_MS,
  dungeon_key_detail,
  dungeon_key_targets,
  held_dungeon_key,
  key_parked,
  MIN_GROUP_KEYS,
  park_dungeon_key,
  should_run_dungeons,
} from '../src/actions/dungeon.ts'
import {
  DUNGEON_EXPECTED_SCALAR,
  dungeon_preview_readiness,
  party_health_status,
  room_to_mob_group,
} from '../src/actions/dungeon_run.ts'
import { dungeon_city, dungeon_rooms, worlds_by_id } from '../src/content/catalog.ts'
import type { CharacterRow } from '@aresrpg/protocol'

const health_character = (over: Partial<CharacterRow> = {}): CharacterRow => ({
  id: 'health-test',
  name: 'health-test',
  classe: 'mori',
  sex: 'female',
  level: 20,
  experience: '0',
  color_1: 0,
  color_2: 0,
  color_3: 0,
  vitality: 0,
  wisdom: 0,
  strength: 0,
  intelligence: 0,
  chance: 0,
  agility: 0,
  available_points: 0,
  spells: {},
  available_spell_points: 0,
  jobs: {},
  kiosk: 'kiosk-1',
  equipment: [],
  ...over,
}) as CharacterRow

describe('dungeon content projection', () => {
  it('exposes the authored room compositions', () => {
    expect(dungeon_rooms('gilded_lorito').length).toBe(8)
    expect(dungeon_rooms('tangled_aftermath').length).toBe(6)
    expect(dungeon_rooms('ivory_rampart').length).toBe(6)
  })

  it('gives every room at least one mob row', () => {
    for (const dk of DUNGEON_KEYS) {
      const rooms = dungeon_rooms(dk.dungeon)
      expect(rooms.length).toBeGreaterThan(0)
      expect(rooms.every((room) => room.length > 0 && room.every((row) => typeof row.mob_type === 'string'))).toBe(true)
    }
  })

  it('returns no rooms for an unknown dungeon', () => {
    expect(dungeon_rooms('nope')).toEqual([])
  })

  it('finds each dungeon its city portal in nauvis', () => {
    const nauvis = worlds_by_id['nauvis']
    expect(nauvis).toBeDefined()
    for (const dk of DUNGEON_KEYS) {
      const city = dungeon_city(nauvis!, dk.dungeon)
      expect(city).not.toBeNull()
      expect(typeof city!.city).toBe('string')
      expect(city!.city.length).toBeGreaterThan(0)
      expect(city!.x).toBeGreaterThan(0)
      expect(city!.z).toBeGreaterThan(0)
    }
  })
})

describe('dungeon key helpers', () => {
  it('resolves each key recipe', () => {
    for (const dk of DUNGEON_KEYS) expect(dungeon_key_detail(dk.key)).not.toBeNull()
  })

  it('reports a held key only when the inventory row is free', () => {
    const inventory = [{ id: 'k1', item_type: 'key_of_gilded_lorito', amount: 1, kiosk: 'k' }]
    expect(held_dungeon_key(inventory as never, new Set())).toBe('key_of_gilded_lorito')
    // `unavailable` is a set of ITEM ids, not item types.
    expect(held_dungeon_key(inventory as never, new Set(['k1']))).toBeNull()
  })

  it('targets one unparked key at a time until the party can enter as a group', () => {
    const inventory: any[] = []
    const blacklist = new Map<string, number>()
    const now = 1_000_000
    expect(dungeon_key_targets(inventory, new Set(), blacklist, now)).toEqual([DUNGEON_KEYS[0]!.key])

    inventory.push({ id: 'first-key', item_type: DUNGEON_KEYS[0]!.key, amount: MIN_GROUP_KEYS })
    expect(dungeon_key_targets(inventory, new Set(), blacklist, now)).toEqual([DUNGEON_KEYS[1]!.key])

    park_dungeon_key(blacklist, DUNGEON_KEYS[0]!.key, now)
    inventory.length = 0
    expect(dungeon_key_targets(inventory, new Set(), blacklist, now)).toEqual([DUNGEON_KEYS[1]!.key])
  })

  it('keeps an under-level key targeted so the craft planner can train its trade', () => {
    expect(dungeon_key_targets([], new Set(), new Map())).toEqual([DUNGEON_KEYS[0]!.key])
  })

  it('does not request more keys once every dungeon is parked or group-ready', () => {
    const inventory = DUNGEON_KEYS.map((dk, index) => ({
      id: `key-${index}`,
      item_type: dk.key,
      amount: MIN_GROUP_KEYS,
    }))
    expect(dungeon_key_targets(inventory as never, new Set(), new Map())).toEqual([])
  })

  it('parks a key only until its retry window elapses, then re-screens it', () => {
    const parked = new Map<string, number>()
    const now = 1_000_000
    expect(key_parked(parked, 'key_of_ivory_rampart', now)).toBe(false)
    park_dungeon_key(parked, 'key_of_ivory_rampart', now)
    expect(key_parked(parked, 'key_of_ivory_rampart', now)).toBe(true)
    // Still parked one tick before the window closes; free once it has elapsed.
    expect(key_parked(parked, 'key_of_ivory_rampart', now + DUNGEON_PARK_MS - 1)).toBe(true)
    expect(key_parked(parked, 'key_of_ivory_rampart', now + DUNGEON_PARK_MS)).toBe(false)
  })

  it('runs dungeons as the party leader only', () => {
    const ctx = { party_state: { leader_id: 'omori' } } as never
    expect(should_run_dungeons({ id: 'omori' } as never, ctx)).toBe(true)
    expect(should_run_dungeons({ id: 'memorien' } as never, ctx)).toBe(false)
    // No party yet: nobody runs dungeons.
    expect(should_run_dungeons({ id: 'omori' } as never, {} as never)).toBe(false)
  })

  it('derives the dungeon roster from the seed instead of hardcoding it', () => {
    expect(DUNGEON_KEYS.length).toBeGreaterThan(0)
    expect(DUNGEON_KEYS.every((dk) => dk.key.length > 0 && dk.dungeon.length > 0)).toBe(true)
    for (const dk of DUNGEON_KEYS) {
      expect(dungeon_rooms(dk.dungeon).length).toBeGreaterThan(0)
      expect(dungeon_key_detail(dk.key)).not.toBeNull()
    }
    const names = DUNGEON_KEYS.map((dk) => dk.dungeon)
    expect(names).toContain('ivory_rampart')
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('dungeon room preview', () => {
  it('waits for HP only when a wounded party fails the current-HP preview', () => {
    expect(dungeon_preview_readiness(1, false)).toBe('ready')
    expect(dungeon_preview_readiness(0.6, false)).toBe('recovering')
    expect(dungeon_preview_readiness(0.6, true)).toBe('unwinnable')
  })

  it('does not treat missing health as a dungeon difficulty failure', () => {
    expect(party_health_status([health_character()]).ready).toBe(true)
    const wounded = party_health_status([health_character({ hp: 1, hp_ms: Date.now() })])
    expect(wounded.ready).toBe(false)
    expect(wounded.wounded[0]?.name).toBe('health-test')
    expect(wounded.missing_hp).toBeGreaterThan(0)
  })

  it('scores a room at the EXPECTED level, not a per-seat ramp', () => {
    // The chain derives each seat's scalar as mix(run_seed, seat) % 101 — a uniform draw over
    // [0,100] (mean 50) the client cannot predict. The preview must use that expectation for
    // EVERY seat; the old `50 + i` ramp over-estimated every mob after the first.
    const group = room_to_mob_group([{ mob_type: 'nook' }, { mob_type: 'bramble' }, { mob_type: 'bramble' }])
    expect(group.members.length).toBe(3)
    expect(group.members.every((member) => member.level_scalar === DUNGEON_EXPECTED_SCALAR)).toBe(true)
    expect(DUNGEON_EXPECTED_SCALAR).toBe(50)
  })

  it('maps every authored room mob onto a preview member in order', () => {
    for (const room of dungeon_rooms('ivory_rampart')) {
      expect(room_to_mob_group(room).members.map((member) => member.mob_type)).toEqual(
        room.map((row) => row.mob_type)
      )
    }
  })
})
