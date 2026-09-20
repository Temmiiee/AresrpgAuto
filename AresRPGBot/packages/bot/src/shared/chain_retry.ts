// Shared submit-with-retry machinery for every chain-mutating call the bot makes (fights,
// stat/spell raises, equipping, marketplace listings, ...) — one place that knows which errors
// are transient (worth an automatic retry) vs. a real problem (log and throw) vs. an expected,
// frequent non-error outcome (stay silent). Split out of fight_session.ts so other modules
// (auto_equip.ts) can reuse it without importing fight_session.ts itself and risking a cycle.
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Public RPCs trip a site-wide rate limit under the bot's bursty turns, so several loops keep an
// inter-call pause whose whole purpose is that 429 backoff. A paid RPC (PAID_RPC=true, see
// cli_group_session.ts) has no such site-wide cap — the pause is pure wall-clock there, so these
// callers can run 3-4x tighter without touching the public-RPC default that keeps the sessions
// out of "Too Many Requests" territory.
export const PAID_RPC = process.env.PAID_RPC?.toLowerCase() === 'true'
export const rpc_backoff_ms = (paid_ms: number, public_ms: number): number => (PAID_RPC ? paid_ms : public_ms)

// Some SDK error paths (search_zone/engage/settle's underlying consensus-rejection errors, not
// the MoveAbort ones) come through with the message URL-encoded — literal "%20" instead of
// spaces — which silently defeated every regex below (they'd never match, so a genuinely
// transient error looked "permanent" and submit_with_retry gave up after one attempt). Decode
// before testing so detection works regardless of which shape a given error path used.
export const message_of = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.includes('%20') ? raw.replace(/%20/g, ' ') : raw
}

// A read that hangs indefinitely (RPC endpoint reachable but unresponsive) is indistinguishable
// from a working-but-slow call — nothing in the SDK's own transport enforces a deadline.  The
// per-attempt timeout below kills such a stall so the retry loop can try another path or give up
// cleanly instead of hanging the whole process silently.
const ATTEMPT_TIMEOUT_MS = 30_000

// Public RPCs (testnet/mainnet) trip a site-wide rate limit under the bot's bursty multi-fight
// turns — "Too Many Requests"/HTTP 429/RESOURCE_EXHAUSTED. Unlike the abort codes, this is a
// pure backpressure signal: nothing changed on-chain, so simply waiting and retrying works.
const is_rate_limited = (error: unknown): boolean =>
  /too many requests|429|resource_?exhausted|service unavailable|connection (closed|reset|refused)/i.test(
    message_of(error)
  )
const is_too_soon_abort = (error: unknown): boolean => /abort code:\s*(1724|305)\b/i.test(message_of(error))

// The consensus/finality-lag race hit live on settle: several calls in a row all touch the SAME
// shared PersonalKioskCap object, and occasionally the network hasn't fully converged on the
// previous call's new object version yet when the next one is built ("provided version doesn't
// match" — hit live 2026-09-01 via a raise_spell loop missing its inter-call sleep, now fixed,
// but this stays as defense in depth for any other rapid-fire kiosk touch). It resolves itself
// within a couple of seconds — worth an automatic retry, same as ETooSoon.
const is_object_lock_race = (error: unknown): boolean => {
  const message = message_of(error)
  // Structural kiosk Move aborts are NOT races: borrow_mut abort 9 is EItemIsListed / missing
  // from that kiosk, and dynamic_field::add abort 0 is EFieldAlreadyExists (already listed).
  // Matching any `kiosk::` string used to retry those 10 times then crash the farm CLI.
  return (
    /already locked by a different transaction/i.test(message) ||
    /rejected as invalid by more than/i.test(message) ||
    /provided version doesn't match/i.test(message)
  )
}
export const is_transient = (error: unknown): boolean =>
  is_too_soon_abort(error) || is_object_lock_race(error) || is_rate_limited(error)

// The SDK's own gas-coin-selection failure, thrown before a transaction is even built — never
// worth an immediate retry (nothing changes in the next few seconds; only a faucet top-up or a
// fight's own gas refunds move the needle), see cli_group_session.ts's backoff on this.
export const is_insufficient_balance = (error: unknown): boolean => /insufficient sui balance/i.test(message_of(error))

// fight.move abort codes that just mean "this candidate attack doesn't work from here" —
// expected, frequent outcomes of fight_session.ts's try-every-candidate loop, not real problems:
// EOutOfRange(1716) ENoLineOfSight(1717) ENotInLine(1718) EBadTargetCell(1720) ECapReached(1721)
// ENotYourSpell(1722). ENoPath(1725) joins them: it's how walk_path rejects a move candidate
// (by design the bot probes several), so an individual 1725 is a miss, not a failure.
// ENoTool(2203) and ETierLocked(2204) are gathering.move's probe abort codes when a character lacks the
// tool or tier for a node — cli_job_farm tests characters via these dry-runs.
const KNOWN_MISS_CODES = [1302, 1716, 1717, 1718, 1720, 1721, 1722, 1725, 2203, 2204]
// progression.move abort codes fight_session.ts's raise_spell loop stops on deliberately —
// ESpellCapped (1602) and ENoSpellPoints (1603) — already expected and re-logged (or not) by
// that loop's own catch, so this generic gate staying silent on them avoids a redundant "submit
// failed" line for something that isn't a failure at all, just the loop finding its stopping point.
const KNOWN_PROGRESSION_STOP_CODES = [1602, 1603]
// equipment.move abort codes auto_equip.ts's try-every-slot pass expects constantly — a slot
// already occupied (ESlotTaken, 1004) or a relic of the same template already worn (ERelicDuplicate,
// 1005) are the ordinary, silent "this one doesn't fit right now" outcome, not a real problem.
const KNOWN_EQUIP_MISS_CODES = [1004, 1005]
const is_known_miss = (error: unknown): boolean =>
  /EObjectAlreadyExists|already claimed|not found/i.test(message_of(error)) ||
  /abort code:\s*2305\b/i.test(message_of(error)) ||
  /abort code:\s*2323\b/i.test(message_of(error)) ||
  [...KNOWN_MISS_CODES, ...KNOWN_PROGRESSION_STOP_CODES, ...KNOWN_EQUIP_MISS_CODES].some((code) =>
    new RegExp(`abort code:\\s*${code}\\b`).test(message_of(error))
  )

// Rate limits drain on their own timescale — wait longer than a transient consensus race so the
// shared public RPC recovers before we re-hammer it.
const sleep_ms = (secs: number): number => secs * 1_000

// RPC endpoint reachable but unresponsive — same retry strategy as rate-limiting (back off, give
// up after a bounded number of attempts).
const is_rpc_timeout = (error: unknown): boolean => /RPC timed out/i.test(message_of(error))

/** Retry delay in ms for `error` after `attempt` tries (1-based); null means "give up". */
const retry_delay_ms = (error: unknown, attempt: number): number | null => {
  if (is_rate_limited(error)) return attempt >= 15 ? null : sleep_ms(5)
  if (is_rpc_timeout(error)) return attempt >= 5 ? null : sleep_ms(5)
  if (is_too_soon_abort(error)) return attempt >= 30 ? null : sleep_ms(2.5)
  if (is_object_lock_race(error)) return attempt >= 10 ? null : sleep_ms(2.5)
  return null
}

/** Logs a reject unless it's a regular, expected near-miss outcome (probe aborts, spell caps). */
const report_reject = (error: unknown, log: (msg: string) => void): void => {
  if (!is_known_miss(error)) log(`submit failed: ${message_of(error)}`)
}

/** Submits `action`, retrying on transient errors (network/consensus timing) up to a bounded
 *  number of attempts, and logging (unless it's a KNOWN, expected non-error outcome) before
 *  re-throwing anything else. Each attempt is wrapped in a per-attempt timeout so an RPC
 *  endpoint that is reachable but unresponsive (no response, no error) doesn't stall the
 *  process silently. */
export const submit_with_retry = async <T>(action: () => Promise<T>, log: (msg: string) => void): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await Promise.race([
        action(),
        sleep(ATTEMPT_TIMEOUT_MS).then(() => {
          throw new Error(`RPC timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s`)
        }),
      ])
    } catch (error) {
      const delay = retry_delay_ms(error, attempt)
      if (delay === null) {
        report_reject(error, log)
        throw error
      }
      await sleep(delay)
    }
  }
}
