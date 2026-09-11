// Shared submit-with-retry machinery for every chain-mutating call the bot makes (fights,
// stat/spell raises, equipping, marketplace listings, ...) — one place that knows which errors
// are transient (worth an automatic retry) vs. a real problem (log and throw) vs. an expected,
// frequent non-error outcome (stay silent). Split out of fight_session.ts so other modules
// (auto_equip.ts) can reuse it without importing fight_session.ts itself and risking a cycle.
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Some SDK error paths (search_zone/engage/settle's underlying consensus-rejection errors, not
// the MoveAbort ones) come through with the message URL-encoded — literal "%20" instead of
// spaces — which silently defeated every regex below (they'd never match, so a genuinely
// transient error looked "permanent" and submit_with_retry gave up after one attempt). Decode
// before testing so detection works regardless of which shape a given error path used.
export const message_of = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.includes('%20') ? raw.replace(/%20/g, ' ') : raw
}

const is_too_soon_abort = (error: unknown): boolean => /abort code:\s*(1724|305)\b/i.test(message_of(error))

// The consensus/finality-lag race hit live on settle: several calls in a row all touch the SAME
// shared PersonalKioskCap object, and occasionally the network hasn't fully converged on the
// previous call's new object version yet when the next one is built ("provided version doesn't
// match" — hit live 2026-09-01 via a raise_spell loop missing its inter-call sleep, now fixed,
// but this stays as defense in depth for any other rapid-fire kiosk touch). It resolves itself
// within a couple of seconds — worth an automatic retry, same as ETooSoon.
const is_object_lock_race = (error: unknown): boolean => {
  const message = message_of(error)
  return (
    /already locked by a different transaction/i.test(message) ||
    /rejected as invalid by more than/i.test(message) ||
    /provided version doesn't match/i.test(message) ||
    /kiosk::/i.test(message) ||
    /abort code:\s*11\b/i.test(message)
  )
}
export const is_transient = (error: unknown): boolean => is_too_soon_abort(error) || is_object_lock_race(error)

// The SDK's own gas-coin-selection failure, thrown before a transaction is even built — never
// worth an immediate retry (nothing changes in the next few seconds; only a faucet top-up or a
// fight's own gas refunds move the needle), see cli_group_session.ts's backoff on this.
export const is_insufficient_balance = (error: unknown): boolean => /insufficient sui balance/i.test(message_of(error))

// fight.move abort codes that just mean "this candidate attack doesn't work from here" —
// expected, frequent outcomes of fight_session.ts's try-every-candidate loop, not real problems:
// EOutOfRange(1716) ENoLineOfSight(1717) ENotInLine(1718) EBadTargetCell(1720) ECapReached(1721)
// ENotYourSpell(1722).
const KNOWN_MISS_CODES = [1716, 1717, 1718, 1720, 1721, 1722]
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
  [...KNOWN_MISS_CODES, ...KNOWN_PROGRESSION_STOP_CODES, ...KNOWN_EQUIP_MISS_CODES].some((code) =>
    new RegExp(`abort code:\\s*${code}\\b`).test(message_of(error))
  )

/** Submits `action`, retrying on transient errors (network/consensus timing) up to a bounded
 *  number of attempts, and logging (unless it's a KNOWN, expected non-error outcome) before
 *  re-throwing anything else. */
export const submit_with_retry = async <T>(action: () => Promise<T>, log: (msg: string) => void): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      const max_attempts = is_too_soon_abort(error) ? 30 : 10
      if (!is_transient(error) || attempt >= max_attempts) {
        if (!is_known_miss(error)) log(`submit failed: ${message_of(error)}`)
        throw error
      }
      await sleep(2_500)
    }
  }
}
