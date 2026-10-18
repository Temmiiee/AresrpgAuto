// fight preview tests — the smart-fight sim's contract: the evidence behind a win rate (wins /
// timeouts / wipes, every run accounted), sequential seeding's stop rule (decided reads stop,
// borderline reads buy more seeds), pinned seed lists running exactly, and the party replay path
// (allies join with the same planner the live door drives).
import { describe, expect, it } from 'bun:test'
import type { CharacterRow, MobGroupRow } from '@aresrpg/protocol'

import {
  describe_score,
  keep_sampling,
  mob_inputs,
  score_mobs,
  MIN_WIN_RATE,
} from '../src/actions/fight_preview.ts'

const character = (over: Partial<CharacterRow> = {}): CharacterRow =>
  ({
    id: 'c1',
    name: 'preview',
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

/** A character the twin can actually win with: one big weapon and enough folded stats to swing it. */
const hero = (level: number, over: Partial<CharacterRow> = {}): CharacterRow =>
  character({
    level,
    equipment: [
      {
        id: 'w',
        slot: 'weapon',
        category: 'axe',
        item_type: 'lid_splitter',
        level: 3,
        damages: [{ element: 'earth', from: 200, to: 400, damage_type: 'weapon' }],
      },
    ] as CharacterRow['equipment'],
    folded_stats: { strength: 50_000, agility: 50_000, vitality: 50_000 },
    ...over,
  })

/** `count` copies of one mob family at a zone scalar (the zero..hundred create maps to its band). */
const group_of = (mob_type: string, level_scalar: number, count: number): MobGroupRow =>
  ({
    index: 0,
    x: 0,
    z: 0,
    members: Array.from({ length: count }, () => ({ mob_type, level_scalar })),
  }) as MobGroupRow

/** The invariant behind every read: every simulated run lands in exactly one bucket. */
const expect_runs_accounted = (score: ReturnType<typeof score_mobs>): void => {
  expect(score.wins + score.timeouts + score.wipes).toBe(score.seeds)
  expect(score.seeds).toBeLessThanOrEqual(15)
}

describe('keep_sampling', () => {
  it('stops decided reads and extends only borderline ones', () => {
    // five-run batch: ≤2/5 is decided fail, 5/5 decided pass, {3,4}/5 one win from the threshold
    expect(keep_sampling(3, 0)).toBe(true) // 0+12 wins still reachable at fifteen → not locked yet
    expect(keep_sampling(4, 0)).toBe(false) // horizon lock: even 15/15's finish cannot reach 12 wins
    expect(keep_sampling(5, 2)).toBe(false)
    expect(keep_sampling(5, 3)).toBe(true)
    expect(keep_sampling(5, 4)).toBe(true)
    expect(keep_sampling(5, 5)).toBe(false)
    // ten-run batch: {7,8}/10 extends, ≤6 fail, 9+ pass
    expect(keep_sampling(10, 6)).toBe(false)
    expect(keep_sampling(10, 7)).toBe(true)
    expect(keep_sampling(10, 8)).toBe(true)
    expect(keep_sampling(10, 9)).toBe(false)
    // horizon locks fire mid-batch, and fifteen is always final
    expect(keep_sampling(9, 4)).toBe(false) // 4 + 6 remaining < 12 wins
    expect(keep_sampling(12, 12)).toBe(false) // already 12 wins: every finish still clears 0.8
    expect(keep_sampling(15, 0)).toBe(false)
    expect(keep_sampling(15, 14)).toBe(false)
  })
})

describe('score_mobs sequential seeding', () => {
  it('calls a hopeless fight decided early, with every run accounted', () => {
    // A naked level-1 (no weapon, no spells) cannot win a round against six top-band ants — the
    // horizon lock should stop simulating before the first batch of five finishes.
    const naked = character({ level: 1 })
    const score = score_mobs(naked, mob_inputs(group_of('ant_red', 100, 6)))
    expect(score.win_rate).toBe(0)
    expect(score.wins).toBe(0)
    expect(score.seeds).toBeLessThan(5)
    expect_runs_accounted(score)
    expect(describe_score(score)).toBe(`wins=0/${score.seeds}, timeouts=${score.timeouts}, wipes=${score.wipes}`)
  })

  it('stops a clean win at the first batch without over-sampling', () => {
    const score = score_mobs(hero(50), mob_inputs(group_of('ant_red', 0, 1)))
    expect(score.win_rate).toBeGreaterThanOrEqual(MIN_WIN_RATE)
    expect(score.seeds).toBe(5)
    expect(score.timeouts).toBe(0)
    expect(score.wipes).toBe(0)
    expect_runs_accounted(score)
  })

  it('runs a pinned seed list exactly (the strategy brain cheap pass)', () => {
    const pinned = score_mobs(hero(50), mob_inputs(group_of('ant_red', 0, 1)), [], { seeds: [1n, 2n] })
    expect(pinned.seeds).toBe(2)
    expect(pinned.win_rate).toBe(1)
    expect_runs_accounted(pinned)
  })

  it('replays a whole party: an ally carries what the naked leader cannot beat alone', () => {
    const naked = character({ level: 50 })
    const ally = hero(50, { id: 'c2', name: 'second' })
    const solo = score_mobs(naked, mob_inputs(group_of('ant_red', 100, 1)))
    const party = score_mobs(naked, mob_inputs(group_of('ant_red', 100, 1)), [ally])
    expect(solo.wins).toBe(0)
    expect(party.wins).toBeGreaterThan(solo.wins)
    expect_runs_accounted(solo)
    expect_runs_accounted(party)
  })
})
