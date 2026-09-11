// Append-only JSONL session log — one line per finished fight, so `cli_session_stats.ts` can
// summarize a long-running background session without needing to keep anything in memory.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOG_PATH = fileURLToPath(new URL('../../session.jsonl', import.meta.url))

export type LoggedMob = { mob_type: string; level: number }
export type FightLogEntry = {
  at: string // ISO timestamp
  fight_id: string
  won: boolean | null // null = the fight itself errored out before a result was known
  mobs: readonly LoggedMob[]
  turns: number
  gas_mist: string // bigint as string (JSON-safe)
  xp_gained: Readonly<Record<string, number>>
  error: string | null
  drops?: Record<string, number>
  drops_value_sui?: number
  net_profit_sui?: number
}

export const append_log = (entry: FightLogEntry): void => {
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`)
}

// Called once at the start of a session run so the dashboard shows only THIS session's fights,
// not a growing history across every run ever started.
export const clear_log = (): void => {
  writeFileSync(LOG_PATH, '')
}

export const read_log = (): FightLogEntry[] => {
  if (!existsSync(LOG_PATH)) return []
  return readFileSync(LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as FightLogEntry & { mob_types?: readonly string[] }
      // Back-compat for log lines written before mob levels were tracked (mob_types: string[]).
      if (!parsed.mobs && parsed.mob_types) parsed.mobs = parsed.mob_types.map((mob_type) => ({ mob_type, level: 0 }))
      return { ...parsed, mobs: parsed.mobs ?? [] }
    })
}
