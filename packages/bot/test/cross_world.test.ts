// Cross-world gathering — the target planner the detacher reads before setting out.
//
// The trip is only worth starting when the character's LEVEL clears a world's entry gate AND one of
// that world's resources is tier-unlocked AND the matching job tool is actually owned. These tests
// pin that triple gate: a qualified miner heads to yakutia for its T4 moonstone, an untooled or
// under-levelled character stays home.
import { job_xp_for_level } from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'

import { cross_world_target } from '../src/actions/cross_world.ts'
import type { GameState } from '../src/state/store.ts'

const character = (over: Partial<CharacterRow> = {}): CharacterRow =>
  ({
    id: 'c1',
    name: 'archero',
    level: 40,
    jobs: {},
    equipment: [],
    ...over,
  }) as never

const state = (inventory: readonly unknown[] = []): GameState =>
  ({ inventory, listings: [], characters: [] }) as never

const miner_tool = { id: 't1', item_type: 'tool_miner', category: 'tool_miner' }

describe('cross_world_target', () => {
  it('sends a tooled T4 miner to yakutia for moonstone', () => {
    const archero = character({
      jobs: { MINER: job_xp_for_level(35) } as never,
      equipment: [miner_tool] as never,
    })
    const target = cross_world_target(archero, state(), 'nauvis')
    expect(target).not.toBeNull()
    expect(target!.world.world).toBe('yakutia')
    expect(target!.job).toBe('MINER')
    expect(target!.tier).toBe(4)
    expect(target!.item_types).toContain('moonstone')
  })

  it('accepts a tool merely held (not equipped) in the shared inventory', () => {
    const archero = character({ jobs: { MINER: job_xp_for_level(35) } as never })
    const target = cross_world_target(archero, state([miner_tool]), 'nauvis')
    expect(target?.world.world).toBe('yakutia')
    expect(target?.job).toBe('MINER')
  })

  it('stays home when the job tool is not owned', () => {
    const archero = character({ jobs: { MINER: job_xp_for_level(35) } as never })
    expect(cross_world_target(archero, state(), 'nauvis')).toBeNull()
  })

  it('stays home when the tier is not unlocked', () => {
    // MINER level 25 leaves T4 (needs 30) locked; nothing in yakutia is harvestable.
    const archero = character({
      jobs: { MINER: job_xp_for_level(25), FARMER: job_xp_for_level(25), HERBALIST: job_xp_for_level(25) } as never,
      equipment: [miner_tool] as never,
    })
    expect(cross_world_target(archero, state(), 'nauvis')).toBeNull()
  })

  it('stays home when the world entry gate is above the character level', () => {
    const rookie = character({
      level: 5,
      jobs: { MINER: job_xp_for_level(35) } as never,
      equipment: [miner_tool] as never,
    })
    expect(cross_world_target(rookie, state(), 'nauvis')).toBeNull()
  })

  it('does not target the world it is already in', () => {
    const archero = character({
      jobs: { MINER: job_xp_for_level(35) } as never,
      equipment: [miner_tool] as never,
    })
    // Already in yakutia: yakutia is excluded as `home`, so the target is another world (or none).
    expect(cross_world_target(archero, state(), 'yakutia')?.world.world).not.toBe('yakutia')
  })
})
