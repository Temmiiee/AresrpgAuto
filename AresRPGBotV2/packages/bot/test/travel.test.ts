// The mover's anchor is the one checkpoint every travel proof reads. Its `sync` must adopt a real
// checkpoint even when the server first pushed a bogus sentinel `at_ms` far in the future: the plain
// "newer wins" rule orders that sentinel above every real checkpoint, so without a self-heal a
// character can never prove a leg again (the dungeon/roam/gather deadlock this pins).
import { create_mover } from '../src/actions/travel.ts'
import { chain_now } from '../src/state/selectors.ts'
import { initial_game_state, reduce } from '../src/state/store.ts'

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

const ctx_for = (state: () => unknown) =>
  ({
    character_id: 'c1',
    world: 'nauvis',
    state,
    send: () => true,
    sdk: {},
  }) as never

const character = (over: Record<string, unknown> = {}) =>
  ({
    id: 'c1',
    name: 'omori',
    world: 'nauvis',
    checkpoint_world: 'nauvis',
    x: 100,
    z: 200,
    at_ms: Date.now(),
    ...over,
  }) as never

const live_chain = (): (() => unknown) => {
  const received_ms = Date.now() - 100
  return () => ({
    characters: [],
    chain_clock: { chain_ms: received_ms, received_ms },
  })
}

describe('mover anchor sync', () => {
  it('self-heals a future-sentinel anchor to the real checkpoint', () => {
    const now = Date.now()
    const mover = create_mover(ctx_for(live_chain()))
    mover.sync(character({ at_ms: now + 100 * YEAR_MS }))
    // The poisoned anchor is unusable: the chain can never prove even a zero-length leg.
    expect(mover.can_reach(100, 200)).toBe(false)
    // The server's next push carries the real checkpoint at the SAME pose but a live timestamp.
    mover.sync(character({ at_ms: now }))
    expect(mover.can_reach(100, 200)).toBe(true)
  })

  it('does not poison a plausible anchor with a later future sentinel', () => {
    const now = Date.now()
    const mover = create_mover(ctx_for(live_chain()))
    mover.sync(character({ at_ms: now }))
    mover.sync(character({ at_ms: now + 100 * YEAR_MS }))
    // The worse future value is ignored, so the anchor stays usable.
    expect(mover.can_reach(100, 200)).toBe(true)
  })

  it('adopts a moved checkpoint immediately', () => {
    const now = Date.now()
    const mover = create_mover(ctx_for(live_chain()))
    mover.sync(character({ at_ms: now }))
    mover.sync(character({ x: 300, z: 400, at_ms: now }))
    expect(mover.can_reach(300, 400)).toBe(true)
  })

  it('adopts a strictly newer (still plausible) checkpoint', () => {
    const now = Date.now()
    const mover = create_mover(ctx_for(live_chain()))
    mover.sync(character({ at_ms: now - 120_000 }))
    mover.sync(character({ at_ms: now - 60_000 }))
    expect(mover.can_reach(100, 200)).toBe(true)
  })

  it('refuses a late row that still names the checkpoint the bot just left', () => {
    // The roster push lags the chain by minutes. After the bot proves a leg itself, a straggling
    // push carrying the OLD position must not snap the pose back — that re-plans and re-walks the
    // same leg forever (the 74:95 <-> 78:95 ping-pong).
    const now = Date.now()
    const mover = create_mover(ctx_for(live_chain()))
    mover.sync(character({ x: 500, z: 600, at_ms: now }))
    mover.sync(character({ x: 100, z: 200, at_ms: now - 60_000 }))
    expect(mover.anchor()?.x).toBe(500)
    expect(mover.anchor()?.z).toBe(600)
    expect(mover.pose().x).toBe(500)
  })
})

describe('chain clock integrality', () => {
  it('floors a fractional server sample age so travel proofs still pass', () => {
    const packet = {
      type: 'packet/server_info',
      online: 1,
      indexing_lag: 0,
      current_epoch: null,
      chain_timestamp_ms: Date.now() - 500,
      // The server reports the sample age with sub-millisecond precision.
      chain_sample_age_ms: 12.7,
    }
    const state = reduce(initial_game_state, { kind: 'packet', packet } as never)
    const now = chain_now(state.chain_clock, Date.now())
    expect(now).not.toBeNull()
    expect(Number.isSafeInteger(now as number)).toBe(true)
  })

  it('never hands a fractional now to a travel proof', () => {
    // `travel_proof_ready` rejects a non-integer `now_ms` outright, so a fractional chain clock
    // froze EVERY leg (the character could not walk, gather or engage — a look-alike network stall).
    const clock = { chain_ms: 1_000_000, received_ms: 1_000_000 + 0.416 }
    const now = chain_now(clock, 1_000_001)
    expect(now).toBe(1_000_000)
    expect(Number.isSafeInteger(now as number)).toBe(true)
  })
})
