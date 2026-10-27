// A durable, append-only activity ledger. One JSON line per meaningful event (gather, fight,
// craft, transaction). It survives restarts and is the honest record of what the bot actually
// did on chain — the thing an operator checks before trusting a run summary.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export type LedgerEntry = Readonly<{
  at_ms: number
  kind: string
  digest?: string
  detail?: Record<string, unknown>
}>

export const create_ledger = (path: string) => {
  const append = (entry: Omit<LedgerEntry, 'at_ms'>): void => {
    const row: LedgerEntry = Object.freeze({ at_ms: Date.now(), ...entry })
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(row)}\n`)
  }
  const read = (): readonly LedgerEntry[] => {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEntry]
        } catch {
          return []
        }
      })
  }
  return Object.freeze({ append, read })
}

export type Ledger = ReturnType<typeof create_ledger>
