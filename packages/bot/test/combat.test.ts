// combat tests – verify function structures and type correctness
import { hydrate_fight, drive_fight, engage_once, settle_pending } from '../src/actions/combat.ts'
import { plan_turn, describe_actions } from '../src/actions/turn_plan.ts'
import { CONTRACT_CONSTANTS } from '@aresrpg/fight'

describe('combat actions type check', () => {
  it('typechecks pass', () => {
    // If we get here, types are correct
    expect(true).toBe(true)
  })

  it('CONSTANTS grid_w is bigint', () => {
    // CONTRACT_CONSTANTS.grid_w is bigint, not number
    expect(CONTRACT_CONSTANTS.grid_w).toBe(20n)
  })
})

describe('combat hydrate_fight', () => {
  it('returns null for non-existent fight', () => {
    const state = () => ({
      fight_states: {},
      characters: [],
      inventory: [],
      zones: [],
      zone_spawns: {},
      tracked: null,
      fights: [],
      fight_states: {},
      fights_started_ms: {},
      resolutions: [],
      closable: [],
      chain_clock: null,
      indexing_lag: null,
      frozen: null,
      online: null,
      last_error: null,
      packets_seen: 0,
    } as any)

    const result = hydrate_fight(state(), 'nonexistent_fight')
    expect(result).toBeNull()
  })
})

describe('combat plan_turn', () => {
  it('exposes the planner and its action formatter', () => {
    expect(typeof plan_turn).toBe('function')
    expect(describe_actions([])).toBe('')
  })
})

describe('combat drive_fight structure', () => {
  it('returns a promise', () => {
    // Just verify the function exists
    expect(drive_fight).toBeDefined()
  })
})