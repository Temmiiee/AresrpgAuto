// Single-instance guard for the account-facing CLIs (cli_roam, cli_group_session): the bot must
// always put EXACTLY ONE session in charge of a wallet, because two roamers racing the same
// characters corrupt each other's on-chain state (seen live 2026-09-16: a second roamer
// re-entered a dungeon right after the first's settle, re-rooting the character ~100 years while
// the first logged a cheerful "run ended" — the on-chain DungeonRun never moved).
//
// The lock is a tiny file holding the owning PID. Taking it is atomic: create the file with the
// `wx` flag (fails with EEXIST if it already exists — two processes spawning at once cannot both
// win). A stale lock from a crashed process is detected by liveness-probing the recorded PID,
// reclaimed, and retried once.
import { openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pid } from 'node:process'

const LOCK_PATH = fileURLToPath(new URL('../../roamer.lock', import.meta.url))

const is_process_alive = (candidate: number): boolean => {
  if (!Number.isInteger(candidate) || candidate <= 0) return false
  try {
    process.kill(candidate, 0)
    return true
  } catch (error) {
    // ESRCH/EPERM: dead, or exists but owned by someone else. EPERM still means "a process with
    // this PID exists" — treat as alive (conservative: don't steal a lock we can't verify).
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const read_lock_pid = (): number | null => {
  try {
    const raw = readFileSync(LOCK_PATH, 'utf8').trim()
    return raw === '' ? null : Number(raw)
  } catch {
    return null
  }
}

/** Refuses to start (throwing) if another session already holds the lock for a LIVE process;
 *  otherwise takes exclusive, atomic ownership of the lock file for this process. */
export const acquire_session_lock = (): void => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, 'wx')
      writeSync(fd, `${pid}\n`)
      closeSync(fd)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      const existing = read_lock_pid()
      if (existing !== null && existing !== pid && is_process_alive(existing)) {
        throw new Error(
          `another roam/session process (PID ${existing}) already holds ${LOCK_PATH} — refusing to run two sessions on the same account. ` +
            `Stop it first, or delete the lock file if it is stale.`
        )
      }
      if (existing === pid) return // we already own it from an earlier call in this process
      // Stale: the recorded owner is dead (or the file is empty from an interrupted write) — drop
      // it and take the lock; the second loop pass creates the fresh file.
      console.log(`[lock] stale lock from ${existing !== null ? `dead PID ${existing}` : 'an incomplete write'} — reclaiming`)
      rmSync(LOCK_PATH, { force: true })
    }
  }
  throw new Error(`[lock] could not acquire ${LOCK_PATH}`)
}

/** Releases the lock (no-op if this process no longer owns it — e.g. it was reclaimed after a
 *  crash or swapped by a newer session). */
export const release_session_lock = (): void => {
  try {
    if (read_lock_pid() === pid) rmSync(LOCK_PATH)
  } catch {
    // best effort on shutdown
  }
}