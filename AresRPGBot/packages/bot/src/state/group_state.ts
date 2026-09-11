// Minimal local state for the real-account group fight — just enough to resume if interrupted.
// Everything else (who has joined, who is ready, whose turn it is) is re-derived fresh from the
// Fight object itself on every run, since that's the actual source of truth.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from './local_store.ts'

export type GroupFightState = { fight_id?: string }

const store = create_local_json_store<GroupFightState>(
  fileURLToPath(new URL('../../group-state.local.json', import.meta.url)),
  {}
)

export const read_group_state = store.read
export const write_group_state = store.write
