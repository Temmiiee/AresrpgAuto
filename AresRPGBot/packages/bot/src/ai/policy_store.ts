// Persists the evolutionary search's best-found policy (cli_train.ts) so the live bot and the
// other CLIs pick up whatever was actually learned, instead of every script hardcoding
// DEFAULT_POLICY. Falls back to the hand-built default when nothing has been trained yet, or
// when the saved file doesn't parse — a missing/corrupt learned policy should never crash a
// real fight, just quietly play with the untrained baseline.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from '../state/local_store.ts'
import { DEFAULT_POLICY, POLICY_KEYS, type Policy } from './policy.ts'

const POLICY_PATH = fileURLToPath(new URL('../../learned_policy.local.json', import.meta.url))

export type StoredPolicy = {
  policy: Policy
  trained_at: string
  generations: number
  fitness: number
  matchups: readonly string[]
}

const store = create_local_json_store<StoredPolicy | null>(POLICY_PATH, null)

export const save_trained_policy = (stored: StoredPolicy): void => store.write(stored)

const is_valid_policy = (value: unknown): value is Policy =>
  typeof value === 'object' &&
  value !== null &&
  POLICY_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === 'number')

/** Loads the trained policy if one exists and parses cleanly; otherwise the untrained default.
 *  `source` tells the caller (and the human reading a log line) which one it actually got. */
export const load_trained_policy = (): { policy: Policy; source: string } => {
  if (!existsSync(POLICY_PATH))
    return { policy: DEFAULT_POLICY, source: 'default (never trained — run `bun run train`)' }
  const stored = store.read()
  if (!stored || !is_valid_policy(stored.policy))
    return { policy: DEFAULT_POLICY, source: 'default (learned_policy.local.json unreadable or malformed)' }
  return {
    policy: stored.policy,
    source: `trained ${stored.trained_at} (${stored.generations} generations, fitness ${stored.fitness.toFixed(2)})`,
  }
}
