// party tests — the shared rendezvous state and the leader/follower staging transitions.
import { claim_key } from '../src/actions/combat.ts'
import {
  allies_of,
  create_party,
  follower_group_step,
  hop_toward,
  leader_group_step,
  needs_rejoin,
  party_attempting,
  party_center,
  PARTY_RADIUS,
  REGROUP_MIN_STEP,
  REJOIN_RADIUS,
  regroup_step,
  reset_rendezvous,
  window_viable,
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
    // the leader is in position (it can reach) but the follower has had the grace and is still absent
    party.in_position_at_ms = Date.now() - 200_000
    const { ctx, released } = ctx_claims([{ id: 'follower', name: 'follower' }])
    const handled = await leader_group_step(ctx, mover_reaching(true), leader(), party)
    expect(handled).toBeNull()
    expect(party.stragglers.has('follower')).toBe(true)
    expect(party.phase).toBe('idle')
    expect(released.length).toBe(1)
  })

  it('keeps waiting for a follower before the grace elapses', async () => {
    const party = staging_party()
    party.members = ['leader', 'follower']
    party.in_position_at_ms = Date.now() - 5_000
    const { ctx, released } = ctx_claims([{ id: 'follower', name: 'follower' }])
    const handled = await leader_group_step(ctx, mover_reaching(true), leader(), party)
    expect(handled).not.toBeNull()
    expect(party.stragglers.size).toBe(0)
    expect(party.phase).toBe('staging')
    expect(released.length).toBe(0)
  })

  it('does not start the grace clock until the leader itself can reach the target', async () => {
    const party = staging_party()
    party.members = ['leader', 'follower']
    // the rendezvous is ancient, but the leader is still walking (cannot reach yet): the followers
    // are walking the same leg and must not be written off for it
    party.staged_at_ms = Date.now() - 200_000
    const { ctx, released } = ctx_claims([{ id: 'follower', name: 'follower' }])
    const handled = await leader_group_step(ctx, mover_reaching(false), leader(), party)
    expect(handled).not.toBeNull()
    expect(party.stragglers.size).toBe(0)
    expect(party.in_position_at_ms).toBe(0)
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

describe('party_center / regroup_step', () => {
  const party_with_poses = (): PartyState => {
    const party = create_party()
    party.leader_id = 'leader'
    party.members = ['leader', 'a', 'b', 'c']
    return party
  }

  it('falls back to the leader pose when no follower pose is known', () => {
    const party = party_with_poses()
    expect(party_center(party, { x: 5, z: 6 })).toEqual({ x: 5, z: 6 })
  })

  it('is the median follower pose, ignoring a detached outlier', () => {
    const party = party_with_poses()
    party.poses.set('a', { x: 100, z: 100 })
    party.poses.set('b', { x: 200, z: 300 })
    party.poses.set('c', { x: 9_999, z: 9_999 })
    party.detached.add('c')
    expect(party_center(party, { x: 0, z: 0 })).toEqual({ x: 150, z: 200 })
  })

  it('does not ask a leader already inside PARTY_RADIUS to regroup', () => {
    const party = party_with_poses()
    party.poses.set('a', { x: 50_000, z: 50_000 })
    expect(regroup_step(party, { x: 50_000 + PARTY_RADIUS, z: 50_000 })).toBeNull()
  })

  it('sends a strayed leader to the PARTY_RADIUS boundary on the line to the centre', () => {
    const party = party_with_poses()
    party.poses.set('a', { x: 50_000, z: 50_000 })
    const step = regroup_step(party, { x: 50_000 + 3 * PARTY_RADIUS, z: 50_000 })
    expect(step).not.toBeNull()
    // three radii out walks back two, landing exactly on the boundary (never overshooting the party)
    expect(step!.x).toBe(50_000 + PARTY_RADIUS)
    expect(step!.z).toBe(50_000)
    expect(step!.offset).toBe(3 * PARTY_RADIUS)
  })

  it('leaves a leader a hair outside PARTY_RADIUS alone (no sub-block correction loop)', () => {
    const party = party_with_poses()
    party.poses.set('a', { x: 50_000, z: 50_000 })
    // The 30-minute stall: the leader sat exactly on the boundary, was handed a sub-block "walk back"
    // that travel_to could not perform, and the regroup gate returned before engage/roam every pass.
    expect(regroup_step(party, { x: 50_000 + PARTY_RADIUS + 1, z: 50_000 })).toBeNull()
    expect(regroup_step(party, { x: 50_000 + PARTY_RADIUS + REGROUP_MIN_STEP - 1, z: 50_000 })).toBeNull()
    expect(regroup_step(party, { x: 50_000 + PARTY_RADIUS + REGROUP_MIN_STEP + 1, z: 50_000 })).not.toBeNull()
  })
})

describe('rejoin gate', () => {
  const party = (): PartyState => {
    const p = create_party()
    p.leader_id = 'leader'
    p.members = ['leader', 'follower']
    return p
  }
  const state = (x: number, z: number) =>
    ({ characters: [{ id: 'leader', x, z }], resolutions: [] }) as never

  it('flags a follower left far from the leader', () => {
    expect(needs_rejoin(party(), state(50_000, 50_000), 'follower', { x: 50_000 + REJOIN_RADIUS + 1, z: 50_000 })).toBe(true)
  })

  it('does not flag a follower already beside the leader', () => {
    expect(needs_rejoin(party(), state(50_000, 50_000), 'follower', { x: 50_500, z: 50_500 })).toBe(false)
  })

  it('never flags the leader or a detached member', () => {
    const p = party()
    expect(needs_rejoin(p, state(50_000, 50_000), 'leader', { x: 0, z: 0 })).toBe(false)
    p.detached.add('follower')
    expect(needs_rejoin(p, state(50_000, 50_000), 'follower', { x: 0, z: 0 })).toBe(false)
  })
})

describe('window viability', () => {
  it('holds before the leader has ever screened the window', () => {
    expect(window_viable(create_party())).toBe(true)
  })

  it('keeps holding while the verdict is fresh (a short HP dip may still resolve)', () => {
    const p = create_party()
    p.no_viable_since_ms = Date.now() - 5_000
    expect(window_viable(p)).toBe(true)
  })

  it('moves on once the window has been unwinnable past the retreat delay', () => {
    const p = create_party()
    p.no_viable_since_ms = Date.now() - 120_000
    expect(window_viable(p)).toBe(false)
  })
})

describe('hop_toward', () => {
  it('returns the target itself when it is within the hop', () => {
    expect(hop_toward({ x: 0, z: 0 }, { x: 100, z: 0 }, PARTY_RADIUS)).toEqual({ x: 100, z: 0 })
  })

  it('caps a long leg on the line to the target', () => {
    // 10_000 blocks out, one 2_000 hop: the point is 2_000 along, NOT the target — so the caller can
    // re-read the peer's live pose next pass instead of blocking for the whole walk.
    expect(hop_toward({ x: 0, z: 0 }, { x: 10_000, z: 0 }, PARTY_RADIUS)).toEqual({
      x: PARTY_RADIUS,
      z: 0,
    })
  })

  it('caps a diagonal hop by true distance, not per axis', () => {
    const hop = hop_toward({ x: 0, z: 0 }, { x: 3_000, z: 4_000 }, 2_000)
    expect(Math.round(Math.hypot(hop.x, hop.z))).toBe(2_000)
  })
})
