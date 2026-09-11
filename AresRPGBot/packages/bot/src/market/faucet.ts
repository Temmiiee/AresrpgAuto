// Auto-tops-up the bot wallet from the official Sui testnet faucet (the same
// `requestSuiFromFaucetV2` the frontend's own AddFundsModal points players at — an
// unauthenticated, rate-limited developer API Mysten Labs runs for exactly this purpose, not a
// scrape of the browser faucet page) whenever the balance drops below a threshold, so an
// unattended session doesn't just die out of gas overnight.
import { fileURLToPath } from 'node:url'

import { FaucetRateLimitError, getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet'

import { create_local_json_store } from '../state/local_store.ts'
import { NETWORK } from '../shared/network_config.ts'
import { PER_CHARACTER_GAS_BASELINE_MIST } from '../state/session_stats.ts'
import { CHARACTERS } from '../config/party_config.ts'

const MIST_PER_SUI = 1_000_000_000n

// ~0.02 SUI/character (the dev's own guidance — see session_stats.ts) times this party's actual
// roster size gives the expected cost of one normal fight; keep ~15 fights of headroom.
const FIGHTS_OF_HEADROOM = 15n
export const DEFAULT_MIN_BALANCE_MIST = PER_CHARACTER_GAS_BASELINE_MIST * BigInt(CHARACTERS.length) * FIGHTS_OF_HEADROOM

// A balance stuck below the threshold means every session-loop retry (every ~30s, indefinitely —
// see cli_group_session.ts) would otherwise re-call the faucet API too, hammering it for hours
// straight (measured live 2026-09-03: ~580 retries against one still-rate-limited address in a
// single run). Once rate-limited, stop trying for this long instead of re-asking every 30
// seconds — a real cooldown, not a guess at the exact server-side window, but "much less
// aggressive than every retry" is true regardless of the exact number, and this backs off far
// enough to matter without ever losing more than one real top-up cycle to it.
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000
const cooldown_store = create_local_json_store<{ until_ms: number } | null>(
  fileURLToPath(new URL('../../faucet-cooldown.local.json', import.meta.url)),
  null
)

export type FaucetClaimResult =
  | { claimed: true; coins_sent: number }
  | { claimed: false; reason: 'rate_limited' | 'cooling_down' | 'error'; detail: string }

export const claim_from_faucet = async (recipient: string): Promise<FaucetClaimResult> => {
  // A testnet-only concept — there is no faucet on mainnet, and calling one against a live
  // wallet would just be a wasted network round trip, never a harmful one. Gate here, the one
  // place both ensure_min_balance (the automatic per-fight top-up) and cli_faucet_check.ts's
  // standalone command funnel through.
  if (NETWORK !== 'testnet')
    return { claimed: false, reason: 'error', detail: `no faucet on ${NETWORK} — skipped` }
  try {
    const response = await requestSuiFromFaucetV2({ host: getFaucetHost('testnet'), recipient })
    if (response.status === 'Success') return { claimed: true, coins_sent: response.coins_sent?.length ?? 0 }
    return { claimed: false, reason: 'error', detail: response.status.Failure.internal }
  } catch (error) {
    if (error instanceof FaucetRateLimitError) return { claimed: false, reason: 'rate_limited', detail: 'rate limited' }
    return { claimed: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Reads the live balance and claims from the faucet only if it's below the threshold — and,
 *  within that, only if a PRIOR claim wasn't rate-limited recently (see RATE_LIMIT_COOLDOWN_MS).
 *  Returns null when no claim was needed at all (balance already healthy). */
export const ensure_min_balance = async (
  read_balance_mist: () => Promise<bigint>,
  recipient: string,
  min_balance_mist: bigint = DEFAULT_MIN_BALANCE_MIST
): Promise<{ balance_mist: bigint; claim: FaucetClaimResult | null }> => {
  const balance_mist = await read_balance_mist()
  if (balance_mist >= min_balance_mist) return { balance_mist, claim: null }

  const cooldown = cooldown_store.read()
  if (cooldown && Date.now() < cooldown.until_ms) {
    const minutes_left = Math.ceil((cooldown.until_ms - Date.now()) / 60_000)
    return {
      balance_mist,
      claim: {
        claimed: false,
        reason: 'cooling_down',
        detail: `still cooling down from a prior rate limit, ~${minutes_left}min left`,
      },
    }
  }

  const claim = await claim_from_faucet(recipient)
  if (claim.claimed) cooldown_store.write(null)
  else if (claim.reason === 'rate_limited') cooldown_store.write({ until_ms: Date.now() + RATE_LIMIT_COOLDOWN_MS })
  return { balance_mist, claim }
}

export const mist_to_sui_string = (mist: bigint): string => (Number(mist) / Number(MIST_PER_SUI)).toFixed(4)

/** How long until a prior rate-limit cooldown clears, or 0 if none is active. Lets a caller that
 *  hits a real "insufficient balance" transaction failure back off for as long as topping up is
 *  known to be pointless, instead of retrying on its own unrelated schedule (see
 *  cli_group_session.ts — retrying every 30s here would just reproduce the exact faucet-hammering
 *  pattern RATE_LIMIT_COOLDOWN_MS was added to stop, one layer up). */
export const faucet_cooldown_remaining_ms = (): number => {
  const cooldown = cooldown_store.read()
  return cooldown ? Math.max(0, cooldown.until_ms - Date.now()) : 0
}
