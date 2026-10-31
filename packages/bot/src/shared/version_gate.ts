// Process-wide latch for the game's on-chain `version::assert_latest` gate. Abort 601 is not a
// transient object-version race: mutating game doors remain unusable until deployment pins and
// the chain's package-version gate agree again.
import { log_error } from './logger.ts'
import { notify } from './discord_notify.ts'

let tripped = false

export const version_gate_active = (): boolean => tripped

export const is_version_assert_error = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.includes('::version::assert_latest') && /abort code:\s*601\b/i.test(message)
  if (match && !tripped) {
    tripped = true
    const reason = 'MoveAbort 601 from version::assert_latest; all bot actions are paused until the server version gate is open and the bot pins match the current deployment. Restart after resolving it.'
    log_error('version', reason)
    notify(`⛔ AresRPGAuto paused: ${reason}`, 'error')
  }
  return match
}
