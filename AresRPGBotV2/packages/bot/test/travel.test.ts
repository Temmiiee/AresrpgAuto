// The mover's anchor is the one checkpoint every travel proof reads. Its `sync` must adopt a real
// checkpoint even when the server first pushed a bogus sentinel `at_ms` far in the future: the plain
// "newer wins" rule orders that sentinel above every real checkpoint, so without a self-heal a
// character can never prove a leg again (the dungeon/roam/gather deadlock this pins).
import { create_mover } from '../src/actions/travel.ts'

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
})
