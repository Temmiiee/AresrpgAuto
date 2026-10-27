// Auto-equip — the pure gear planner. The score is the game's own rune-weight unit, so these tests
// pin the two things the planner must get right: (1) the best item is chosen per slot, with every
// `equipment.move` guard respected (level, slot fit, relic type clash, other characters' worn items,
// the market), and (2) the diff handed to the SDK touches ONLY the slots that actually changed.
import { describe, expect, it } from 'bun:test'
import { item_stat_center } from '@aresrpg/immutable'
import type { CharacterRow, EquippedItem, ItemRow } from '@aresrpg/protocol'

import { auto_equip_party, character_affinity, equip_plan, item_power, item_stat_offset, plan_loadout } from '../src/actions/equip.ts'
import { initial_game_state, type GameState } from '../src/state/store.ts'

const SHIFT = item_stat_center

const character = (over: Partial<CharacterRow> = {}): CharacterRow =>
  ({
    id: 'c1',
    name: 'omori',
    classe: 'asobi',
    sex: 'male',
    level: 50,
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

/** An item whose stats are given as SIGNED offsets from neutral (32768). */
const item = (id: string, category: string, over: Partial<ItemRow> = {}): ItemRow =>
  ({
    id,
    name: id,
    item_type: id,
    category,
    level: 1,
    amount: 1,
    kiosk: 'kiosk-1',
    ...over,
  }) as ItemRow

const stats_of = (offsets: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(offsets).map(([stat, value]) => [stat, SHIFT + value]))

const worn = (slot: string, id: string, over: Partial<EquippedItem> = {}): EquippedItem =>
  ({ ...item(id, slot, over), slot }) as EquippedItem

const state = (inventory: readonly ItemRow[], characters: readonly CharacterRow[] = []): GameState => ({
  ...initial_game_state,
  inventory,
  characters,
})

/** A state that clears the pre-transaction freshness gate, so the action itself runs. */
const fresh_state = (inventory: readonly ItemRow[], characters: readonly CharacterRow[]): GameState => ({
  ...state(inventory, characters),
  connected: true,
  frozen: false,
  indexing_lag: 0,
  chain_clock: { chain_ms: Date.now(), received_ms: Date.now() },
  packets_seen: 20,
})

const context = (game: GameState, equip: unknown): unknown =>
  ({
    state: () => game,
    character_id: 'c1',
    sdk: { character: { equip } },
    ledger: { append: () => {} },
  }) as never

describe('item_stat_offset', () => {
  it('decodes the raw centered u16 into a signed offset', () => {
    const blade = item('blade', 'sword', { stats: stats_of({ strength: 30, vitality: -4 }) })
    expect(item_stat_offset(blade, 'strength')).toBe(30)
    expect(item_stat_offset(blade, 'vitality')).toBe(-4)
    expect(item_stat_offset(blade, 'water_resistance')).toBe(0)
  })

  it('scales a pet block by the pet power the chain folds', () => {
    const pet = item('pet', 'pet', { stats: stats_of({ wisdom: 60 }), pet_power: 30 })
    expect(item_stat_offset(pet, 'wisdom')).toBe(30)
  })
})

describe('character_affinity', () => {
  it('reads the class kit and lets allocated stats pull it toward what the character casts', () => {
    const base = character_affinity(character())
    expect(base.earth).toBeGreaterThan(base.fire) // asobi's seed kit is earth-heavy
    const caster = character_affinity(character({ intelligence: 500 }))
    expect(caster.fire).toBeGreaterThan(base.fire)
  })
})

describe('item_power', () => {
  it('prefers the element the character actually casts', () => {
    const affinity = character_affinity(character({ strength: 500 }))
    const on = item_power(item('on', 'hat', { stats: stats_of({ strength: 30 }) }), affinity)
    const off = item_power(item('off', 'hat', { stats: stats_of({ chance: 30 }) }), affinity)
    expect(on).toBeGreaterThan(off)
  })

  it('prices weapon damage in the same unit as raw damage, gated by the weapon element', () => {
    const affinity = character_affinity(character({ strength: 500 }))
    const blade = item_power(
      item('blade', 'sword', { damages: [{ element: 'earth', from: 10, to: 20, damage_type: 'weapon' }] }),
      affinity
    )
    expect(blade).toBeCloseTo(15 * 20 * (0.5 + 0.5 * affinity.earth))
  })

  it('scores a statless, damageless item at zero', () => {
    expect(item_power(item('plain', 'cloak'), character_affinity(character()))).toBe(0)
  })
})

describe('plan_loadout', () => {
  it('picks the highest-power item for every slot the character can fill', () => {
    const weak = item('weak-hat', 'hat', { stats: stats_of({ vitality: 2 }) })
    const strong = item('strong-hat', 'hat', { stats: stats_of({ strength: 40 }) })
    const loadout = plan_loadout(character({ strength: 500 }), state([weak, strong]))
    expect(loadout.get('hat')?.id).toBe('strong-hat')
  })

  it('never equips an item above the character level', () => {
    const tooHigh = item('elite', 'hat', { level: 90, stats: stats_of({ strength: 400 }) })
    const fine = item('plain', 'hat', { level: 1, stats: stats_of({ vitality: 1 }) })
    const loadout = plan_loadout(character({ level: 40 }), state([tooHigh, fine]))
    expect(loadout.get('hat')?.id).toBe('plain')
  })

  it('leaves items owned by another character, claimed this pass, or on the market alone', () => {
    const mine = item('mine', 'hat', { stats: stats_of({ strength: 5 }) })
    const theirs = item('theirs', 'hat', { stats: stats_of({ strength: 500 }) })
    const listed = item('listed', 'hat', { stats: stats_of({ strength: 500 }) })
    const alreadyClaimed = item('claimed', 'hat', { stats: stats_of({ strength: 500 }) })
    const other = character({ id: 'c2', name: 'memorien', equipment: [worn('hat', 'theirs')] })
    const game: GameState = {
      ...state([mine, theirs, listed, alreadyClaimed], [character({ strength: 1 }), other]),
      listings: [{ id: 'listed' } as never],
    }
    const loadout = plan_loadout(character({ strength: 1 }), game, { claimed: new Set(['claimed']) })
    expect(loadout.get('hat')?.id).toBe('mine')
  })

  it("keeps a character's own worn item as a candidate", () => {
    const own = item('worn-hat', 'hat', { stats: stats_of({ strength: 10 }) })
    const hero = character({ strength: 500, equipment: [worn('hat', 'worn-hat', { stats: stats_of({ strength: 10 }) })] })
    const loadout = plan_loadout(hero, state([own], [hero]))
    expect(loadout.get('hat')?.id).toBe('worn-hat')
  })

  it('never fits two relic slots with the same relic type', () => {
    const relicA = item('relic-a', 'relic', { stats: stats_of({ strength: 50 }) })
    const relicA2 = item('relic-a2', 'relic', { item_type: 'relic-a', stats: stats_of({ strength: 49 }) })
    const relicB = item('relic-b', 'relic', { stats: stats_of({ strength: 10 }) })
    const loadout = plan_loadout(character({ strength: 500 }), state([relicA, relicA2, relicB]))
    const fitted = [...loadout.values()].map((entry) => entry.item_type)
    expect(fitted).toContain('relic-a')
    expect(fitted).toContain('relic-b')
    expect(fitted.filter((type) => type === 'relic-a')).toHaveLength(1)
  })

  it('restricts the tool slot to the category the gathering chore needs', () => {
    const pick = item('pickaxe', 'tool_miner', { stats: stats_of({ strength: 50 }) })
    const hoe = item('hoe', 'tool_farmer', { stats: stats_of({ strength: 49 }) })
    const loadout = plan_loadout(character({ strength: 500 }), state([pick, hoe]), { tool_category: 'tool_farmer' })
    expect(loadout.get('tool')?.id).toBe('hoe')
  })
})

describe('equip_plan', () => {
  it('emits only the slots whose best item is not already worn, unequipping the replaced piece', () => {
    const hat = item('hat', 'hat', { stats: stats_of({ strength: 10 }) })
    const boots = item('boots', 'boots', { stats: stats_of({ strength: 10 }) })
    const hero = character({ strength: 500, equipment: [worn('hat', 'old-hat')] })
    const loadout = new Map([
      ['hat', hat],
      ['boots', boots],
    ]) as never
    const plan = equip_plan(hero, loadout)
    expect(plan.to_equip.map((change) => change.slot).sort()).toEqual(['boots', 'hat'])
    expect(plan.to_unequip).toEqual([{ slot: 'hat', item_id: 'old-hat' }])
  })

  it('is empty when the loadout matches what is already worn', () => {
    const hat = item('hat', 'hat')
    const hero = character({ equipment: [worn('hat', 'hat')] })
    const plan = equip_plan(hero, new Map([['hat', hat]]) as never)
    expect(plan.to_equip).toHaveLength(0)
    expect(plan.to_unequip).toHaveLength(0)
  })
})

describe('auto_equip_party', () => {
  it('equips the best gear for an idle character and reports nothing blocked', async () => {
    const hero = character({ strength: 500 })
    const hat = item('hat', 'hat', { stats: stats_of({ strength: 20 }) })
    const game = fresh_state([hat], [hero])
    const calls: unknown[] = []
    const report = await auto_equip_party([
      { ctx: context(game, async (args: unknown) => {
        calls.push(args)
        return { digest: '0x1' }
      }) } as never,
    ])
    expect(report).toEqual({ equipped: 1, blocked: 0 })
    expect((calls[0] as { to_equip: unknown[] }).to_equip).toEqual([{ slot: 'hat', item_id: 'hat' }])
  })

  it('reports a character seated in a fight as blocked and spends nothing for it', async () => {
    const hero = character({ strength: 500, custody: 'fight', active_fight: { id: '0xf', seat: 0 } })
    const hat = item('hat', 'hat', { stats: stats_of({ strength: 20 }) })
    const game = fresh_state([hat], [hero])
    let called = false
    const report = await auto_equip_party([
      { ctx: context(game, async () => {
        called = true
        return { digest: '0x1' }
      }) } as never,
    ])
    expect(report).toEqual({ equipped: 0, blocked: 1 })
    expect(called).toBe(false)
  })
})
