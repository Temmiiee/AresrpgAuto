// Persists the party's last known chain position across separate script invocations, so
// `cli_group_fight_loop.ts` (run one fight at a time by hand) can chain fights the same way the
// session loop does, without needing you to re-tell it the position every time.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from './local_store.ts'
import { INITIAL_CHAIN_X, INITIAL_CHAIN_Z } from '../config/party_config.ts'
import type { Position } from '../fight/fight_session.ts'

const store = create_local_json_store<Position>(fileURLToPath(new URL('../../position.local.json', import.meta.url)), {
  x: INITIAL_CHAIN_X,
  z: INITIAL_CHAIN_Z,
})

export const read_position = store.read
export const write_position = store.write
