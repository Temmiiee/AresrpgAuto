import { describe, expect, test } from 'bun:test'

import {
  is_insufficient_balance,
  is_transient,
  message_of,
  submit_with_retry,
} from '../src/shared/chain_retry.ts'

describe('message_of', () => {
  test('decodes URL-encoded spaces so abort-code regexes can match', () => {
    expect(message_of(new Error('abort%20code:%201724'))).toBe('abort code: 1724')
  })

  test('leaves an already-plain message untouched', () => {
    expect(message_of(new Error('abort code: 1724'))).toBe('abort code: 1724')
  })

  test('stringifies a non-Error thrown value', () => {
    expect(message_of('a plain string throw')).toBe('a plain string throw')
    expect(message_of(404)).toBe('404')
  })
})

describe('is_transient', () => {
  test('a too-soon abort code is transient', () => {
    expect(is_transient(new Error('MoveAbort ... abort code: 1724'))).toBe(true)
    expect(is_transient(new Error('MoveAbort ... abort code: 305'))).toBe(true)
  })

  test('an object-lock-race message is transient', () => {
    expect(is_transient(new Error('object is already locked by a different transaction'))).toBe(true)
    expect(is_transient(new Error('provided version doesn\'t match'))).toBe(true)
    expect(is_transient(new Error('kiosk::place_and_list aborted'))).toBe(true)
    expect(is_transient(new Error('abort code: 11'))).toBe(true)
  })

  test('an unrelated error is not transient', () => {
    expect(is_transient(new Error('insufficient SUI balance for gas'))).toBe(false)
    expect(is_transient(new Error('abort code: 1716'))).toBe(false)
  })
})

describe('is_insufficient_balance', () => {
  test('matches the SDK\'s gas-selection failure, case-insensitively', () => {
    expect(is_insufficient_balance(new Error('Insufficient SUI balance for requested budget'))).toBe(true)
  })

  test('does not match an unrelated error', () => {
    expect(is_insufficient_balance(new Error('abort code: 1716'))).toBe(false)
  })
})

describe('submit_with_retry', () => {
  test('returns the action result on first success without logging', async () => {
    const logs: string[] = []
    const result = await submit_with_retry(async () => 'ok', (msg) => logs.push(msg))
    expect(result).toBe('ok')
    expect(logs).toEqual([])
  })

  test('throws immediately (no retry, no log) on a known-miss abort code', async () => {
    const logs: string[] = []
    await expect(
      submit_with_retry(async () => {
        throw new Error('MoveAbort ... abort code: 1716')
      }, (msg) => logs.push(msg))
    ).rejects.toThrow('abort code: 1716')
    expect(logs).toEqual([])
  })

  test('throws and logs once on a real, non-transient, non-known-miss error', async () => {
    const logs: string[] = []
    await expect(
      submit_with_retry(async () => {
        throw new Error('something genuinely wrong')
      }, (msg) => logs.push(msg))
    ).rejects.toThrow('something genuinely wrong')
    expect(logs).toEqual(['submit failed: something genuinely wrong'])
  })
})
