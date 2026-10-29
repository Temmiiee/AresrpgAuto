// Regression tests for the 2026-10 log review: tx version races, room-1 gating, equip ownership,
// and automatic stat/spell progression.
import { characteristic_spending_quote, type ClassName } from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'

import { create_tx_lane, freshest_cap, serialize_actions, with_version_retry } from '../src/auth/sdk_client.ts'
import { dungeon_key_targets, MIN_GROUP_KEYS, party_key_stock } from '../src/actions/dungeon.ts'
import { GROUP_ENTER_MAX_WAIT_MS, GROUP_ENTER_STALL_MS, room1_gate } from '../src/actions/dungeon_run.ts'
import { ownership_verdict } from '../src/actions/equip_guard.ts'
import { plan_spell_raises, plan_stat_spending, spell_level_of } from '../src/actions/progression.ts'
import { spells } from '../src/content/catalog.ts'

const pad = (hex: string) => `0x${hex.padStart(64, '0')}`

describe('transaction lane', () => {
  it('runs kiosk doors one at a time, in call order', async () => {
    const lane = create_tx_lane()
    const log: string[] = []
    let running = 0
    let max_running = 0
    const job = (name: string, ms: number) => async () => {
      running += 1
      max_running = Math.max(max_running, running)
      log.push(`start ${name}`)
      await new Promise((resolve) => setTimeout(resolve, ms))
      log.push(`end ${name}`)
      running -= 1
      return name
    }
    const results = await Promise.all([lane(job('a', 20)), lane(job('b', 1)), lane(job('c', 5))])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(max_running).toBe(1)
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('keeps going after a failed door', async () => {
    const lane = create_tx_lane()
    await expect(lane(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await lane(async () => 7)).toBe(7)
  })

  it('serialize_actions wraps doors but leaves bypassed ones parallel', async () => {
    const lane = create_tx_lane()
    let busy = false
    let overlap = false
    const slow = async () => {
      if (busy) overlap = true
      busy = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      busy = false
    }
    const actions = serialize_actions({ a: slow, b: slow, fast: async () => 'x', value: 3 }, lane, new Set(['fast']))
    await Promise.all([actions.a(), actions.b()])
    expect(overlap).toBe(false)
    expect(actions.value).toBe(3)
    expect(await actions.fast()).toBe('x')
  })
})

describe('version-race retry', () => {
  const race = () =>
    new Error(
      `[sdk] transaction was NOT submitted: object ${pad('f8c6')} provided version doesn't match the current version (provided 10, actual 11)`
    )

  it('rebuilds after a pre-submission version race', async () => {
    let calls = 0
    const value = await with_version_retry(
      async () => {
        calls += 1
        if (calls === 1) throw race()
        return 'ok'
      },
      { backoff_ms: 1 }
    )
    expect(value).toBe('ok')
    expect(calls).toBe(2)
  })

  it('never retries an unrelated failure', async () => {
    let calls = 0
    await expect(
      with_version_retry(
        async () => {
          calls += 1
          throw new Error('MoveAbort 1603')
        },
        { backoff_ms: 1 }
      )
    ).rejects.toThrow('1603')
    expect(calls).toBe(1)
  })

  it('upgrades a lagging indexer cap to the receipt-fed ref', () => {
    const cap = { isPersonal: true, objectId: pad('ca9'), kioskId: pad('k1'), digest: 'old', version: '10' }
    expect(freshest_cap(cap, { objectId: cap.objectId, version: '12', digest: 'new' })).toMatchObject({
      version: '12',
      digest: 'new',
    })
    expect(freshest_cap(cap, { objectId: cap.objectId, version: '9', digest: 'older' }).digest).toBe('old')
    expect(freshest_cap(cap, undefined)).toBe(cap)
  })
})

describe('room-1 gate', () => {
  it('waits until every expected member entered', () => {
    expect(room1_gate({ present: 1, expected: 3, waited_ms: 60_000, since_last_arrival_ms: 60_000 })).toBe('wait')
    expect(room1_gate({ present: 3, expected: 3, waited_ms: 1_000, since_last_arrival_ms: 0 })).toBe('start')
  })

  it('only gives up after a stall or the hard cap', () => {
    expect(
      room1_gate({ present: 2, expected: 3, waited_ms: GROUP_ENTER_STALL_MS, since_last_arrival_ms: GROUP_ENTER_STALL_MS })
    ).toBe('start_partial')
    expect(
      room1_gate({ present: 2, expected: 3, waited_ms: GROUP_ENTER_MAX_WAIT_MS, since_last_arrival_ms: 1_000 })
    ).toBe('start_partial')
  })
})

describe('dungeon key stock', () => {
  it('stocks one key per active member', () => {
    expect(party_key_stock({ members: ['a', 'b', 'c', 'd'], detached: new Set() })).toBe(4)
    expect(party_key_stock({ members: ['a', 'b', 'c', 'd'], detached: new Set(['d']) })).toBe(3)
    expect(party_key_stock(null)).toBe(MIN_GROUP_KEYS)
  })

  it('keeps targeting the focused key until the stock is met', () => {
    const first = dungeon_key_targets([], new Set(), new Map(), Date.now(), 4)[0]
    expect(first).toBeDefined()
    const inventory = [{ id: '0x1', item_type: first!, amount: 2, category: 'resource' }] as never
    expect(dungeon_key_targets(inventory, new Set(), new Map(), Date.now(), 4)[0]).toBe(first)
    expect(dungeon_key_targets(inventory, new Set(), new Map(), Date.now(), 2)[0]).not.toBe(first)
  })
})

describe('equip ownership verdict', () => {
  const me = pad('c1')
  const other = pad('c2')
  const kiosk_child = { $kind: 'ObjectOwner', ObjectOwner: pad('df') } as never

  it('accepts a kiosk item in and a worn item out', () => {
    const owners = new Map([
      [pad('a'), kiosk_child],
      [pad('b'), { $kind: 'AddressOwner', AddressOwner: me }],
    ])
    const verdict = ownership_verdict(me, [{ slot: 'tool', item_id: pad('a') }], [{ slot: 'tool', item_id: pad('b') }], owners)
    expect(verdict.ok).toBe(true)
  })

  it('rejects unequipping an item that is back in the kiosk (the logged abort)', () => {
    const owners = new Map([
      [pad('a'), kiosk_child],
      [pad('4499'), kiosk_child],
    ])
    const verdict = ownership_verdict(me, [{ slot: 'tool', item_id: pad('a') }], [{ slot: 'tool', item_id: pad('4499') }], owners)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('not worn by this character')
  })

  it('flags an item already worn by us or a teammate', () => {
    const owners = new Map([
      [pad('a'), { $kind: 'AddressOwner', AddressOwner: me }],
      [pad('b'), { $kind: 'AddressOwner', AddressOwner: other }],
    ])
    const verdict = ownership_verdict(
      me,
      [
        { slot: 'tool', item_id: pad('a') },
        { slot: 'hat', item_id: pad('b') },
      ],
      [],
      owners
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.already_worn).toEqual([pad('a')])
  })
})

const character = (classe: string, level: number, patch: Partial<CharacterRow> = {}): CharacterRow =>
  ({
    id: pad('c1'),
    name: classe,
    classe,
    level,
    spells: {},
    available_points: 0,
    available_spell_points: 0,
    vitality: 0,
    wisdom: 0,
    strength: 0,
    intelligence: 0,
    chance: 0,
    agility: 0,
    ...patch,
  }) as unknown as CharacterRow

describe('auto progression', () => {
  const classes = [...new Set(spells.map((spell) => spell.classe))]

  it('spends stat capital exactly as the class ladder allows', () => {
    for (const classe of classes) {
      const row = character(classe, 40, { available_points: 195 })
      const spending = plan_stat_spending(row)
      expect(spending).not.toBeNull()
      const quote = characteristic_spending_quote(classe as ClassName, row as never, spending!)
      expect(quote).not.toBeNull()
      expect(quote!.cost).toBeLessThanOrEqual(195)
      expect(quote!.cost).toBeGreaterThan(190)
    }
  })

  it('puts early capital into the class damage element rather than wisdom', () => {
    const spending = plan_stat_spending(character('shugo', 10, { available_points: 45 }))!
    const element = (spending.strength ?? 0) + (spending.intelligence ?? 0) + (spending.chance ?? 0) + (spending.agility ?? 0)
    expect(element).toBeGreaterThan(0)
    expect(spending.wisdom ?? 0).toBe(0)
  })

  it('only raises learned spells, within points, at n → n+1 = n points', () => {
    for (const classe of classes) {
      const row = character(classe, 30, { available_spell_points: 29 })
      const raises = plan_spell_raises(row)
      expect(raises.length).toBeGreaterThan(0)
      const total = raises.reduce((sum, raise) => sum + raise.cost, 0)
      expect(total).toBeLessThanOrEqual(29)
      const levels = new Map<string, number>()
      for (const raise of raises) {
        const spell = spells.find((s) => s.classe === classe && s.name === raise.spell)!
        const from = levels.get(raise.spell) ?? spell_level_of(row, spell)
        expect(from).toBeGreaterThanOrEqual(1)
        expect(raise.from).toBe(from)
        expect(raise.cost).toBe(from)
        expect(from).toBeLessThan(spell.levels.length)
        expect(row.level).toBeGreaterThanOrEqual(spell.unlock_level)
        levels.set(raise.spell, from + 1)
      }
    }
  })

  it('does nothing without points', () => {
    expect(plan_spell_raises(character('shugo', 30))).toEqual([])
    expect(plan_stat_spending(character('shugo', 30))).toBeNull()
  })
})
