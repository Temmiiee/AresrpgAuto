// party tests — the shared rendezvous state and the leader/follower staging transitions.
import { claim_key } from '../src/actions/combat.ts'
import {
  allies_of,
  create_party,
  follower_group_step,
  leader_group_step,
  party_attempting,
  reset_rendezvous,
} from '../src/actions/party.ts'
import type { PartyState } from '../src/actions/party.ts'

const candidate = (world = 'nauvis', index = 7) => ({
  zone: { world, zx: 3, zz: 4 },
  group: { index, x: 10, z: 20 },
})

const staging_party = (world = 'nauvis'): PartyState => {
  const party = create_party()
  party.leader_id = 'leader'
  party.members = ['leader', 'follower']
  party.phase = 'staging'
  party.staged_at_ms = Date.now()
  party.target = Object.freeze({
    world,
    candidate: candidate(world) as never,
    claim_key: claim_key(candidate(world) as never),
    x: 10,
    z: 20,
  })
  return party
}

const follower = (world = 'nauvis') =>
  ({ id: 'follower', name: 'follower', world }) as never

const ctx_for = (characters: readonly unknown[] = []) =>
  ({ state: () => ({ characters, resolutions: [] }) }) as never

const mover_reaching = (reach: boolean) =>
  ({
    can_reach: () => reach,
    travel_to: async () => {},
    anchor: () => null,
    pose: () => ({ x: 0, y: 0, z: 0 }),
  }) as never

const ctx_claims = (characters: readonly unknown[] = []) => {
  const released: unknown[] = []
  const ctx = {
    character_id: 'leader',
    state: () => ({ characters, resolutions: [] }),
    claims: {
      release: (key: string, id: string) => {
        released.push([key, id])
        return true
      },
    },
  }
  return { ctx: ctx as never, released }
}

const leader = () =>
  ({ id: 'leader', name: 'leader', world: 'nauvis', custody: 'free' }) as never

describe('party state', () => {
  it('starts idle with no leader, members or target', () => {
    const party = create_party()
    expect(party.phase).toBe('idle')
    expect(party.leader_id).toBeNull()
    expect(party.members).toEqual([])
    expect(party.fight).toBeNull()
    expect(party.target).toBeNull()
    expect(party.staged.size).toBe(0)
    expect(party.stragglers.size).toBe(0)
  })

  it('is not attempting without a leader or a partner', () => {
    const party = create_party()
    expect(party_attempting(party)).toBe(false)
    party.leader_id = 'leader'
    party.members = ['leader']
    expect(party_attempting(party)).toBe(false)
    party.members = ['leader', 'follower']
    expect(party_attempting(party)).toBe(true)
  })

  it('stops attempting while cooling down after rendezvous failures', () => {
    const party = create_party()
    party.leader_id = 'leader'
    party.members = ['leader', 'follower']
    party.retry_after_ms = Date.now() + 60_000
    expect(party_attempting(party)).toBe(false)
    party.retry_after_ms = Date.now() - 1
    expect(party_attempting(party)).toBe(true)
  })
})

describe('claim_key', () => {
  it('names a group by world, zone and index', () => {
    expect(claim_key(candidate('nauvis', 7) as never)).toBe('nauvis:3:4:7')
  })
})

describe('follower_group_step', () => {
  it('stages once it can prove the leg to the target', async () => {
    const party = staging_party()
    const handled = await follower_group_step(ctx_for(), mover_reaching(true), follower(), party)
    expect(party.staged.has('follower')).toBe(true)
    expect(handled).not.toBeNull()
  })

  it('falls through to the solo path when it is in another world', async () => {
    const party = staging_party('nauvis')
    const handled = await follower_group_step(ctx_for(), mover_reaching(true), follower('other'), party)
    expect(party.staged.has('follower')).toBe(false)
    expect(handled).toBeNull()
  })

  it('waits while the party fight is still on chain', async () => {
    const party = create_party()
    party.leader_id = 'leader'
    party.members = ['leader', 'follower']
    party.phase = 'active'
    party.fight = '0xfight'
    const state = [{ id: 'follower', active_fight: { id: '0xfight', seat: 1 } }]
    const handled = await follower_group_step(ctx_for(state), mover_reaching(false), follower(), party)
    expect(handled).not.toBeNull()
    expect(party.phase).toBe('active')
  })

  it('clears a finished fight and resumes the solo path', async () => {
    const party = create_party()
    party.leader_id = 'leader'
    party.members = ['leader', 'follower']
    party.phase = 'active'
    party.fight = '0xfight'
    const handled = await follower_group_step(ctx_for(), mover_reaching(false), follower(), party)
    expect(handled).toBeNull()
    expect(party.phase).toBe('idle')
    expect(party.fight).toBeNull()
  })
})

describe('party stragglers', () => {
  it('drops detached and straggler members from the side', () => {
    const party = create_party()
    party.leader_id = 'leader'
    party.members = ['leader', 'a', 'b', 'c']
    party.detached.add('b')
    party.stragglers.add('c')
    const state = {
      characters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      resolutions: [],
    }
    const allies = allies_of(state as never, party, 'leader')
    expect(allies.map((row) => row.id)).toEqual(['a'])
  })

  it('writes off a follower that cannot stage within the grace and re-plans', async () => {
    const party = staging_party()
    party.members = ['leader', 'follower']
    party.staged_at_ms = Date.now() - 100_000
    const { ctx, released } = ctx_claims([{ id: 'follower', name: 'follower' }])
    const handled = await leader_group_step(ctx, mover_reaching(false), leader(), party)
    expect(handled).toBeNull()
    expect(party.stragglers.has('follower')).toBe(true)
    expect(party.phase).toBe('idle')
    expect(released.length).toBe(1)
  })

  it('keeps waiting for a follower before the grace elapses', async () => {
    const party = staging_party()
    party.members = ['leader', 'follower']
    const { ctx, released } = ctx_claims([{ id: 'follower', name: 'follower' }])
    const handled = await leader_group_step(ctx, mover_reaching(false), leader(), party)
    expect(handled).not.toBeNull()
    expect(party.stragglers.size).toBe(0)
    expect(party.phase).toBe('staging')
    expect(released.length).toBe(0)
  })

  it('restores a straggler once it finally stages', async () => {
    const party = staging_party()
    party.stragglers.add('follower')
    const handled = await follower_group_step(ctx_for(), mover_reaching(true), follower(), party)
    expect(handled).not.toBeNull()
    expect(party.staged.has('follower')).toBe(true)
    expect(party.stragglers.has('follower')).toBe(false)
  })

  it('keeps stragglers across a rendezvous reset', () => {
    const party = create_party()
    party.stragglers.add('follower')
    reset_rendezvous(party)
    expect(party.stragglers.has('follower')).toBe(true)
  })
})
