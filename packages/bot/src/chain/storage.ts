// Durable transaction storage for the SDK's execution boundary.
//
// The SDK records an in-flight transaction's digest BEFORE submitting, so a crash mid-submission
// leaves evidence that lets the next process recover the outcome by digest instead of blindly
// re-sending. Browser builds use sessionStorage; Bun has no `window`, so we supply a small
// file-backed store. The record carries NO signature and NO transaction bytes — only the digest
// and the receipt options needed to recover it — so a plain JSON file is safe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { TransactionStorage } from '../../../sdk/src/transaction_execution.ts'

export const create_durable_storage = (path: string): TransactionStorage => {
  const load = (): Record<string, string> => {
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    } catch (error) {
      // Refuse to silently discard an unreadable pending record: losing it risks a blind retry.
      throw new Error(
        `[storage] pending-transaction file ${path} is unreadable (${error instanceof Error ? error.message : String(error)}); refusing to start`
      )
    }
  }
  let data = load()
  const persist = (): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 })
  }
  return {
    getItem: (key: string): string | null => data[key] ?? null,
    setItem: (key: string, value: string): void => {
      data = { ...data, [key]: value }
      persist()
    },
    removeItem: (key: string): void => {
      const { [key]: _removed, ...rest } = data
      data = rest
      persist()
    },
  }
}
