// The periodic digest fold: fights/loot/gather/craft accumulate immutably and render one window.
import { describe, expect, it } from 'bun:test'

import {
  empty_stats,
  format_summary,
  record_craft,
  record_fight,
  record_gather,
} from '../src/actions/play_stats.ts'

describe('play_stats', () => {
  it('folds fights into won/lost/draw counts and loot tallies without mutating the input', () => {
    const start = empty_stats
    const after = record_fight(start, { outcome: 'won', loot: [{ item_type: 'nook_fang', qty: 2 }] })
    expect(start.fights).toBe(0)
    expect(start.loot).toEqual({})
    expect(after.fights).toBe(1)
    expect(after.won).toBe(1)
    expect(after.loot).toEqual({ nook_fang: 2 })
  })

  it('accumulates loot across fights and separates losses and draws', () => {
    const stats = [
      { outcome: 'won' as const, loot: [{ item_type: 'gold_ore', qty: 1 }] },
      { outcome: 'lost' as const, loot: [] },
      { outcome: 'won' as const, loot: [{ item_type: 'gold_ore', qty: 3 }] },
      { outcome: 'draw' as const, loot: [] },
    ].reduce(record_fight, empty_stats)
    expect({ fights: stats.fights, won: stats.won, lost: stats.lost, draw: stats.draw }).toEqual({
      fights: 4,
      won: 2,
      lost: 1,
      draw: 1,
    })
    expect(stats.loot).toEqual({ gold_ore: 4 })
  })

  it('tallies gathered nodes and crafted batches', () => {
    const stats = record_craft(record_gather(record_gather(empty_stats, 'gold_ore', 3), 'gold_ore', 2), 'gold_bar', 4)
    expect(stats.gathered).toEqual({ gold_ore: 5 })
    expect(stats.crafted).toEqual({ gold_bar: 4 })
  })

  it('renders a digest with counts, xp, job xp and per-item tallies', () => {
    const stats = record_fight(record_gather(empty_stats, 'iron_ore', 5), {
      outcome: 'won',
      loot: [{ item_type: 'nook_fang', qty: 2 }],
    })
    const text = format_summary(stats, 1234n, { miner: 40n, cook: 0n })
    expect(text).toContain('1 fights · 1W 0L 0D')
    expect(text).toContain('+1234 xp')
    expect(text).toContain('miner +40')
    expect(text).not.toContain('cook')
    expect(text).toContain('loot: 2× nook_fang')
    expect(text).toContain('gathered: 5× iron_ore')
    expect(text).toContain('crafted: none')
  })
})
