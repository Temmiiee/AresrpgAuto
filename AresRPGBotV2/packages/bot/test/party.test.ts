// party tests — the shared rendezvous state and the leader/follower staging transitions.
import { claim_key } from '../src/actions/combat.ts'
import { create_party, follower_group_step, party_attempting } from '../src/actions/party.ts'
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
  ({ can_reach: () => reach, travel_to: async () => {} }) as never

describe('party state', () => {
  it('starts idle with no leader, members or target', () => {
    const party = create_party()
    expect(party.phase).toBe('idle')
    expect(party.leader_id).toBeNull()
    expect(party.members).toEqual([])
    expect(party.fight).toBeNull()
    expect(party.target).toBeNull()
    expect(party.staged.size).toBe(0)
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
