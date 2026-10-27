// The fight report: win/lose comes from the chain's own winner/team columns, and the loot is what
// settlement ACTUALLY credited (the sealed-entropy `drops` roll), aggregated across our seats.
// `loot_types` is only the set of types the defeated mobs COULD drop, so it must never be reported.
import { describe, expect, it } from 'bun:test'
import type { FightResolutionRow } from '@aresrpg/protocol'

import { resolution_report } from '../src/actions/combat.ts'

const row = (over: Partial<FightResolutionRow>): FightResolutionRow => ({
  fight: '0xfight',
  world: 'nauvis',
  dungeon: null,
  dungeon_room: null,
  kolizeum: null,
  fighter: 0,
  character: 'me',
  team: 0,
  winner: 0,
  dead: false,
  settled: false,
  boss_weight: 0,
  kares: '0',
  loot_types: [],
  drops: [],
  ...over,
})

describe('combat resolution_report', () => {
  it('reports a win when our team is the winner and counts the actual drops', () => {
    const report = resolution_report([
      row({
        winner: 0,
        team: 0,
        drops: [
          { item_type: 'nook_fang', qty: 2 },
          { item_type: 'lorito_water', qty: 1 },
        ],
      }),
    ])
    expect(report.outcome).toBe('won')
    expect(report.loot).toEqual([
      { item_type: 'nook_fang', qty: 2 },
      { item_type: 'lorito_water', qty: 1 },
    ])
  })

  it('reports only the credited drops, never the potential loot table', () => {
    const report = resolution_report([
      row({ loot_types: ['key_of_gilded_lorito', 'nook_fang'], drops: [{ item_type: 'nook_fang', qty: 1 }] }),
    ])
    expect(report.loot).toEqual([{ item_type: 'nook_fang', qty: 1 }])
  })

  it('reports a loss when the other team won', () => {
    expect(resolution_report([row({ winner: 1, team: 0 })]).outcome).toBe('lost')
  })

  it('reports a draw when the fight ended without a winner', () => {
    expect(resolution_report([row({ winner: null })]).outcome).toBe('draw')
  })

  it('aggregates loot across every settled seat', () => {
    const report = resolution_report([
      row({ fighter: 0, kares: '1', drops: [{ item_type: 'gold_ore', qty: 1 }] }),
      row({
        fighter: 1,
        kares: '1',
        drops: [
          { item_type: 'gold_ore', qty: 1 },
          { item_type: 'ruby', qty: 1 },
        ],
      }),
    ])
    expect(report.loot).toEqual([
      { item_type: 'gold_ore', qty: 2 },
      { item_type: 'ruby', qty: 1 },
    ])
  })

  it('reports no loot and a draw for an empty settlement set', () => {
    const report = resolution_report([])
    expect(report.outcome).toBe('draw')
    expect(report.loot).toEqual([])
  })
})
