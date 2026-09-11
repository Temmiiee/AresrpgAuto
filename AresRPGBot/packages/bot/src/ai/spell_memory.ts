// Persisted, cross-session record of which spells actually land when tried, so the bot stops
// re-trying options that keep failing for this party (wrong range for how it usually ends up
// positioned, awkward line-of-sight requirements, etc.) instead of relearning the same lesson
// every fight. Pure success-rate bookkeeping — no game rules live here.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from '../state/local_store.ts'

type Record_ = { attempts: number; successes: number }
type Memory = Record<string, Record_> // `${classe}:${spell_name}` -> record

const key_of = (classe: string, spell: string): string => `${classe}:${spell}`

const store = create_local_json_store<Memory>(fileURLToPath(new URL('../../spell-memory.local.json', import.meta.url)), {})

export const record_attempt = (classe: string, spell: string, landed: boolean): void => {
  const memory = store.read()
  const key = key_of(classe, spell)
  const current = memory[key] ?? { attempts: 0, successes: 0 }
  store.write({ ...memory, [key]: { attempts: current.attempts + 1, successes: current.successes + (landed ? 1 : 0) } })
}

/** Laplace-smoothed success rate in [0,1] — a spell nobody has tried yet reads as a neutral
 *  0.5 rather than 0 (untried is not the same as "known bad") or 1 (not yet proven good either). */
export const success_rate = (classe: string, spell: string): number => {
  const record = store.read()[key_of(classe, spell)]
  if (!record) return 0.5
  return (record.successes + 1) / (record.attempts + 2)
}
