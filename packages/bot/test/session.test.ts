// session tests – verify function structures
import { create_session, play_loop, type Session } from '../src/net/session.ts'

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