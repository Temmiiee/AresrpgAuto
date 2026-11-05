// session tests – verify function structures
import {
  create_session,
  dungeon_owns_party_route,
  party_chore_beat_pending,
  play_loop,
  request_party_chore_beat,
  type Session,
} from '../src/net/session.ts'
import { create_party } from '../src/actions/party.ts'

describe('session actions type check', () => {
  it('typechecks pass', () => {
    expect(true).toBe(true)
  })

  it('create_session returns a Session object', () => {
    // Mock signer and address
    const result = create_session(
      {} as any,
      '0x0000000000000000000000000000000000000000'
    )
    expect(result).toBeDefined()
    expect(typeof result.send).toBe('function')
    expect(typeof result.status).toBe('function')
    expect(typeof result.dispose).toBe('function')
  })
})

describe('play_loop structure', () => {
  it('is a function', () => {
    expect(play_loop).toBeDefined()
    expect(typeof play_loop).toBe('function')
  })
})

describe('post-fight party chore beat', () => {
  it('schedules every member of the settled party, not only the runtime that settled it', () => {
    const party = create_party()
    party.members = ['leader', 'farmer', 'miner']
    const other_party = create_party()
    other_party.members = ['other']
    const runtimes = [
      { character: { id: 'leader' }, ctx: { party_state: party }, chore_pending: false },
      { character: { id: 'farmer' }, ctx: { party_state: party }, chore_pending: false },
      { character: { id: 'miner' }, ctx: { party_state: party }, chore_pending: false },
      { character: { id: 'spectator' }, ctx: { party_state: party }, chore_pending: false },
      { character: { id: 'other' }, ctx: { party_state: other_party }, chore_pending: false },
    ]

    request_party_chore_beat(runtimes, party)

    expect(runtimes.map((runtime) => runtime.chore_pending)).toEqual([true, true, true, false, false])
    expect(party_chore_beat_pending(runtimes, party)).toBe(true)
    for (const runtime of runtimes.slice(0, 3)) runtime.chore_pending = false
    expect(party_chore_beat_pending(runtimes, party)).toBe(false)
  })
})

describe('dungeon route ownership', () => {
  it('holds normal party routing across both sides of the projection gap', () => {
    const party = create_party()
    const idle = { dungeon_run: undefined }

    expect(dungeon_owns_party_route(party, idle)).toBe(false)

    party.dungeon = {
      dungeon: 'tangled_aftermath',
      world: 'nauvis',
      x: 1,
      z: 2,
      seats: 5,
      member_ids: ['leader'],
      committed_ms: 1,
    }
    expect(dungeon_owns_party_route(party, idle)).toBe(true)

    party.dungeon = null
    expect(dungeon_owns_party_route(party, { dungeon_run: {} as any })).toBe(true)
  })
})
