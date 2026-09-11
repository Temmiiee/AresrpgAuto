// The session loop's live "what's happening right now" line, polled by the dashboard. Not a
// resumability mechanism (group-state.local.json owns that) — purely for display.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from './local_store.ts'

export type Status = { updated_at: string; message: string; fight_number: number }

const store = create_local_json_store<Status | null>(
  fileURLToPath(new URL('../../status.local.json', import.meta.url)),
  null
)

export const write_status = (message: string, fight_number: number): void =>
  store.write({ updated_at: new Date().toISOString(), message, fight_number })

export const read_status = store.read
