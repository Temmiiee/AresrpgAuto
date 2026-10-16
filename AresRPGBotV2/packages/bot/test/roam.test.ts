// roam tests — the controller that decides where the bot stands. It must read the chain's own XP
// penalties (fight_math::xp_for_player) so "trivial" means exactly "the chain would trim the pay".
import { describe, expect, it } from 'bun:test'

import type { MobGroupRow } from '@aresrpg/protocol'

import { assess_window, plan_roam } from '../src/actions/roam.ts'
import { worlds_by_id } from '../src/content/catalog.ts'

const nauvis = worlds_by_id['nauvis']!

const group = (mob_type: string, level_scalar: number, size = 1, index = 0): MobGroupRow =>
  Object.freeze({
    index,
    x: 50_000,
    z: 50_000,
    members: Object.freeze(
      Array.from({ length: size }, () => Object.freeze({ mob_type, level_scalar }))
    ),
  })

const thebes = Object.freeze({ x: 50_512, z: 50_000 }) // zone 98:97 (distance 432)
const far_ring = Object.freeze({ x: 70_400, z: 50_000 }) // zone 137:97 (distance 20,400)

describe('roam assess_window', () => {
  it('calls level-1 prey trivial for a level-30 character', () => {
    const assessment = assess_window(30, [group('bramble', 0, 3)])
    expect(assessment.trivial).toBe(true)
    expect(assessment.highest_level).toBe(1)
    expect(assessment.overwhelming).toBe(false)
  })

  it('calls a same-level mob worthwhile', () => {
    // bramble band 1..8: scalar 100 → level 8, which pays for a level-5 character.
    const assessment = assess_window(5, [group('bramble', 100)])
    expect(assessment.trivial).toBe(false)
    expect(assessment.highest_level).toBe(8)
  })

  it('calls far-above prey overwhelming', () => {
    // ant_red band 12..28: scalar 100 → level 28, far above a level-1 character.
    const assessment = assess_window(1, [group('ant_red', 100)])
    expect(assessment.overwhelming).toBe(true)
  })

  it('an empty window is neither trivial nor overwhelming', () => {
    const assessment = assess_window(30, [])
    expect(assessment.groups).toBe(0)
    expect(assessment.trivial).toBe(false)
    expect(assessment.overwhelming).toBe(false)
  })
})

describe('roam plan_roam', () => {
  it('advances outward on trivial prey', () => {
    const plan = plan_roam(30, thebes, nauvis, assess_window(30, [group('bramble', 0, 3)]))
    expect(plan.kind).toBe('advance')
    if (plan.kind === 'advance') expect(plan.distance).toBeGreaterThan(432)
  })

  it('creeps one step toward the band instead of jumping to it', () => {
    // Level 30's band is ~20_000; the old plan used Math.max and jumped straight there in one leg,
    // stranding the followers. The bounded plan steps out exactly one STEP_BLOCKS (2_500).
    const plan = plan_roam(30, thebes, nauvis, assess_window(30, [group('bramble', 0, 3)]))
    expect(plan.kind).toBe('advance')
    if (plan.kind === 'advance') expect(plan.distance).toBe(432 + 2_500)
  })

  it('holds when the window already pays', () => {
    const plan = plan_roam(5, thebes, nauvis, assess_window(5, [group('bramble', 100)]))
    expect(plan.kind).toBe('stay')
  })

  it('advances on undiscovered ground', () => {
    const plan = plan_roam(30, thebes, nauvis, assess_window(30, []))
    expect(plan.kind).toBe('advance')
  })

  it('holds once past the ramp even with trivial prey', () => {
    const plan = plan_roam(30, far_ring, nauvis, assess_window(30, [group('bramble', 0, 3)]))
    expect(plan.kind).toBe('stay')
  })

  it('steps inward when the prey is out of reach', () => {
    const plan = plan_roam(1, far_ring, nauvis, assess_window(1, [group('ant_red', 100)]))
    expect(plan.kind).toBe('advance')
    if (plan.kind === 'advance') expect(plan.distance).toBeLessThan(20_400)
  })

  // The deadlock the party hit live: the window paid by the XP table (mob levels high enough) but the
  // fight preview could not certify ANY group, so the group step found nothing while the roam "held".
  // The verdict must turn that hold into a step toward weaker prey.
  const mid_ring = Object.freeze({ x: 58_000, z: 50_000 })

  it('holds at a payable window while the preview still finds a winnable group', () => {
    const plan = plan_roam(5, mid_ring, nauvis, assess_window(5, [group('bramble', 100)]), 2_500, true)
    expect(plan.kind).toBe('stay')
  })

  it('steps inward when the window pays but nothing in it is winnable', () => {
    const plan = plan_roam(5, mid_ring, nauvis, assess_window(5, [group('bramble', 100)]), 2_500, false)
    expect(plan.kind).toBe('advance')
    if (plan.kind === 'advance') expect(plan.distance).toBeLessThan(8_112)
  })

  it('does not oscillate below the inner ring when nothing is winnable', () => {
    const inner = Object.freeze({ x: 50_000, z: 50_000 })
    const plan = plan_roam(5, inner, nauvis, assess_window(5, [group('bramble', 100)]), 2_500, false)
    expect(plan.kind).toBe('stay')
  })
})
