// bun run src/cli_group_session.ts [max_fights]
//
// Runs group fights back-to-back, unattended: search -> engage -> fight -> settle, then repeat
// with the new position, logging each result to session.jsonl. Meant to be started and left
// running in the background (see README "Running unattended"). Ctrl+C to stop — the current
// fight (if any) resumes cleanly on the next run via group-state.local.json.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { run_one_group_fight } from '../fight/fight_session.ts'
import { craft_starter_tools_if_missing } from '../forge/tool_craft.ts'
import { message_of, is_insufficient_balance, PAID_RPC, rpc_backoff_ms } from '../shared/chain_retry.ts'
import { send_discord_alert, notify_session_expired, notify_session_start } from '../shared/discord_notify.ts'
import { notify_rare_loot, notify_fight_summary } from '../shared/discord_reports.ts'
import { read_position, write_position } from '../state/position_state.ts'
import { append_log, clear_log, type FightLogEntry } from '../state/session_log.ts'
import { GAS_WARN_MIST, mist_to_sui } from '../state/session_stats.ts'
import { write_status } from '../state/status_state.ts'
import { acquire_session_lock, release_session_lock } from '../state/session_lock.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { value_drops, calculate_farming_profit } from '../market/item_valuation.ts'
import { ensure_min_balance, mist_to_sui_string, faucet_cooldown_remaining_ms } from '../market/faucet.ts'
import { auto_sell_spare_loot } from '../market/auto_sell.ts'
import { auto_equip_available_gear } from '../market/auto_equip.ts'
import { run_daily_dungeon_quest } from '../dungeon/dungeon_session.ts'

const DELAY_BETWEEN_FIGHTS_MS = () => rpc_backoff_ms(1_500, 5_000)
const RETRY_DELAY_MS = 30_000
const NO_TARGET_RETRY_DELAY_MS = 10 * 60_000 // zones only reroll every 2h — no point hammering
const POST_QUEST_DELAY_MS = PAID_RPC ? 0 : 10_000 // Wait 10s after quest check to avoid rate limit
// How many completed fights accumulate before a recap embed is sent to Discord.
const SUMMARY_EVERY = Number(process.env.DISCORD_SUMMARY_EVERY ?? 10) || 10

// Real spend circuit breakers — GAS_WARN_MIST (session_stats.ts) only ever logged a warning and
// let the loop keep going regardless; neither an unattended run stuck losing repeatedly (bad
// matchup, a policy regression, a chain-side change) nor one silently burning far more gas than
// expected had anything that actually stopped it. Both are env-configurable so a session that
// genuinely needs to run longer/pricier can raise them explicitly, but the loop never exceeds
// either silently by default.
const MAX_CONSECUTIVE_LOSSES = process.env.MAX_CONSECUTIVE_LOSSES ? Number(process.env.MAX_CONSECUTIVE_LOSSES) : 5
const MAX_SESSION_GAS_MIST = BigInt(
  Math.round((process.env.MAX_SESSION_GAS_SUI ? Number(process.env.MAX_SESSION_GAS_SUI) : 1) * 1e9)
)
// A gas-selection "insufficient balance" failure means nothing will change for a while — the
// same reasoning that got the faucet itself a cooldown (faucet.ts) applies one layer up: retrying
// every 30s here would just spend that whole window re-attempting a doomed transaction instead of
// waiting it out. Floor of 2min covers the case where the wallet is simply low but the faucet was
// never actually rate-limited (no cooldown tracked yet) — still much less aggressive than 30s.
const INSUFFICIENT_BALANCE_MIN_RETRY_DELAY_MS = 2 * 60_000

// mastery.move's daily quest resets once per chain epoch (~1 real day) -- mastery.start() itself
// is idempotent-safe (aborts cleanly, no gas-wasting side effect, if already assigned this
// epoch), but a REAL submitted transaction still costs gas even on abort, so this loop checks it
// on a timer rather than before every single fight. 6h comfortably catches a day rollover in a
// long-running unattended session without hammering it.
const DUNGEON_QUEST_CHECK_INTERVAL_MS = 6 * 60 * 60_000
let last_quest_check_ms = 0
const maybe_run_daily_quest = async (bot: ReturnType<typeof create_bot_sdk>, log: (msg: string) => void): Promise<void> => {
  if (Date.now() - last_quest_check_ms < DUNGEON_QUEST_CHECK_INTERVAL_MS) return
  last_quest_check_ms = Date.now()
  try {
    const outcome = await run_daily_dungeon_quest(bot, log)
    log(`daily quest check: ${JSON.stringify(outcome)}`)
  } catch (error) {
    log(`daily quest check skipped (${message_of(error)})`)
  }
}

const max_fights = process.argv[2] ? Number(process.argv[2]) : Infinity
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const timestamp = () => new Date().toISOString().slice(11, 19)
const describe_mobs = (mobs: readonly { mob_type: string; level: number }[]) =>
  mobs.map((m) => `${m.mob_type}(lv${m.level})`).join(', ')

const retry_delay_ms = (error: unknown, message: string): number => {
  if (/No group in this zone is within reach/.test(message)) return NO_TARGET_RETRY_DELAY_MS
  // Same reasoning as the case above -- zones only reroll every 2h, so a zone with nothing
  // winnable right now won't have anything different in 30s either.
  if (/clears the .*% win-rate floor/.test(message)) return NO_TARGET_RETRY_DELAY_MS
  if (is_insufficient_balance(error))
    return Math.max(INSUFFICIENT_BALANCE_MIN_RETRY_DELAY_MS, faucet_cooldown_remaining_ms())
  return RETRY_DELAY_MS
}

const main = async () => {
  clear_log()
  acquire_session_lock()
  const release = () => {
    release_session_lock()
    process.exit(0)
  }
  process.on('SIGINT', release)
  process.on('SIGTERM', release)
  process.on('exit', release_session_lock)

  // Pass callback to send login URL to Discord if re-auth is needed
  let signer = await get_enoki_signer(async (login_url) => {
    console.log('[Discord] Sending re-authentication link...')
    await notify_session_expired('pending...', login_url)
  })
  
  const address = create_bot_sdk(signer).address
  console.log(`session start — address ${address}, up to ${max_fights === Infinity ? 'unlimited' : max_fights} fights`)
  await notify_session_start(address, max_fights === Infinity ? 'unlimited' : max_fights)

  const boot_bot = create_bot_sdk(signer)
  // The boot sequence (equip -> tools -> quest) fires several RPC-heavy kiosk scans back to back;
  // on the public RPC that burst lands as "Too Many Requests". Pause once up front, before the
  // first of them, instead of after the quest check where it never covered the equip/tools burst.
  if (POST_QUEST_DELAY_MS > 0) {
    console.log(`  ⏱️  waiting ${(POST_QUEST_DELAY_MS / 1000).toFixed(0)}s before session-start RPC burst to avoid rate limit...`)
    await sleep(POST_QUEST_DELAY_MS)
  }
  try {
    await auto_equip_available_gear(boot_bot, (msg) => console.log(`  [equip] ${msg}`))
  } catch (error) {
    console.log(`  [equip] skipped this session start (${message_of(error)})`)
  }
  try {
    await craft_starter_tools_if_missing(boot_bot, (msg) => console.log(`  [tools] ${msg}`))
  } catch (error) {
    console.log(`  [tools] cancelled this session start (${message_of(error)})`)
  }

  let position = read_position()
  let count = 0
  let consecutive_losses = 0
  let session_gas_mist = 0n
  const recent_fights: FightLogEntry[] = []

  while (count < max_fights) {
    count += 1
    // A fresh BotSdk every fight, not one reused for the whole session (2026-09-05): the SDK's
    // own object-resolution cache accumulates across calls within one instance, and a search_zone
    // (or its refresh fallback) hydrating an object early in a fight, followed later by that same
    // object's version changing on-chain, leaves engage()'s later reference to it stale --
    // surfacing as "[sdk] unresolved object ... hydrate it first", reproducibly, only when
    // preceded by a search/refresh in the SAME process. Confirmed live: calling fight.engage()
    // with the EXACT failing parameters from a brand-new process (fresh cache, no preceding
    // search/refresh) succeeded every time. get_enoki_signer() reuses the cached session file (no
    // network round-trip), so recreating this per fight costs nothing real.
    const bot = create_bot_sdk(signer)
    console.log(`\n[${timestamp()}] === fight ${count} ===`)
    write_status(`fight ${count}: starting…`, count)
    try {
      await maybe_run_daily_quest(bot, (msg) => console.log(`  [quest] ${msg}`))
      // The daily quest enter() proves movement TO the dungeon portal (world.move::prove_move
      // sets the on-chain overworld checkpoint there) and end_run() leaves that checkpoint in
      // place. The position read at session start is therefore stale the moment a quest runs —
      // searching/engaging from it aborts world::prove_move ETravelTooFar (305). Re-read so the
      // battle anchors at the portal where the party actually is (live: first quest of a session
      // aborted the very next engage with exactly this).
      position = read_position()

      const { balance_mist, claim } = await ensure_min_balance(bot.sdk.read_sui_balance, bot.address)
      if (claim?.claimed) {
        console.log(
          `  ⛽ balance ${mist_to_sui_string(balance_mist)} SUI — claimed from faucet (${claim.coins_sent} coin(s))`
        )
      } else if (claim && !claim.claimed) {
        console.log(
          `  ⛽ balance ${mist_to_sui_string(balance_mist)} SUI — faucet claim failed (${claim.reason}: ${claim.detail})`
        )
      }

      const outcome = await run_one_group_fight(bot, position, (msg) => {
        console.log(`  ${msg}`)
        write_status(msg, count)
      })
      position = outcome.new_position
      write_position(position)

      // Ensure gas_mist is properly converted to number
      const gas_mist_bigint = typeof outcome.gas_mist === 'bigint' ? outcome.gas_mist : BigInt(outcome.gas_mist)
      const gas_sui = Number(gas_mist_bigint) / 1e9
      const valuation = value_drops(outcome.drops ?? {})
      const profit = calculate_farming_profit(valuation.total_sui, gas_sui)

      const entry: FightLogEntry = {
        at: new Date().toISOString(),
        fight_id: outcome.fight_id,
        won: outcome.won,
        mobs: outcome.mobs,
        turns: outcome.turns,
        gas_mist: gas_mist_bigint.toString(),
        xp_gained: outcome.xp_gained,
        error: null,
        drops: outcome.drops,
        drops_value_sui: valuation.total_sui,
        net_profit_sui: profit.net_profit_sui,
      }
      append_log(entry)

      await notify_rare_loot(outcome.drops ?? {}, outcome.fight_id)
      if (entry.error === null && outcome.won !== null) {
        recent_fights.push(entry)
        if (recent_fights.length >= SUMMARY_EVERY) {
          await notify_fight_summary(recent_fights, `${count} fights — recap`)
          recent_fights.length = 0
        }
      }

      const drop_summary =
        Object.entries(outcome.drops ?? {})
          .map(([item, qty]) => `${item} x${qty}`)
          .join(', ') || 'none'

      write_status(`fight ${count}: ${outcome.won ? 'WON' : 'LOST'} vs ${describe_mobs(outcome.mobs)}`, count)
      console.log(
        `[${timestamp()}] ${outcome.won ? 'WON' : 'LOST'} vs ${describe_mobs(outcome.mobs)} — ${outcome.turns} turns, gas: ${gas_sui.toFixed(4)} SUI` +
          ` | drops: ${drop_summary} (+${valuation.total_sui.toFixed(4)} SUI est.)` +
          ` | NET: ${profit.net_profit_sui >= 0 ? '+' : ''}${profit.net_profit_sui.toFixed(4)} SUI`
      )
      if (gas_mist_bigint >= GAS_WARN_MIST) {
        console.log(
          `⚠ fight cost ${gas_sui.toFixed(4)} SUI — above the ~${mist_to_sui(GAS_WARN_MIST)} SUI expected for this ` +
            `${CHARACTERS.length}-character party (the dev's ~0.02 SUI/character baseline). ` +
            `Worth reporting fight ${outcome.fight_id} + address ${bot.address} to the dev.`
        )
      }

      consecutive_losses = outcome.won ? 0 : consecutive_losses + 1
      session_gas_mist += gas_mist_bigint
      if (consecutive_losses >= MAX_CONSECUTIVE_LOSSES) {
        console.log(
          `\n⛔ stopping: ${consecutive_losses} losses in a row (MAX_CONSECUTIVE_LOSSES=${MAX_CONSECUTIVE_LOSSES}) — ` +
            `likely a bad matchup, a policy regression, or something wrong on-chain. Investigate before restarting ` +
            `rather than let this keep spending gas on losses.`
        )
        write_status(`session stopped: ${consecutive_losses} losses in a row`, count)
        break
      }
      if (session_gas_mist >= MAX_SESSION_GAS_MIST) {
        console.log(
          `\n⛔ stopping: cumulative session gas spend ${mist_to_sui(session_gas_mist)} SUI has reached the ` +
            `MAX_SESSION_GAS_SUI=${mist_to_sui(MAX_SESSION_GAS_MIST)} cap. Restart explicitly (optionally with a ` +
            `higher MAX_SESSION_GAS_SUI) to keep going.`
        )
        write_status(`session stopped: gas cap reached (${mist_to_sui(session_gas_mist)} SUI)`, count)
        break
      }

      // Same bot/signer already active this fight -- never a second, separately-signed-in
      // process touching the same kiosk (that race is exactly what left a control-panel-initiated
      // listing reporting success while never actually persisting on-chain, confirmed live
      // 2026-09-06). Best-effort: a listing hiccup should never abort an otherwise-successful
      // fight loop.
      try {
        await auto_sell_spare_loot(bot, (msg) => console.log(`  ${msg}`))
      } catch (error) {
        console.log(`  auto-sell skipped this round (${message_of(error)})`)
      }

      await sleep(DELAY_BETWEEN_FIGHTS_MS())
    } catch (error) {
      const message = message_of(error)
      console.log(`[${timestamp()}] fight ${count} errored: ${message}`)
      write_status(`fight ${count}: error — ${message}`, count)
      
      // Detect ZKLogin expiration and re-authenticate
      if (/ZKLogin expired|Invalid user signature/.test(message)) {
        console.log('🔄 Session expired - requesting fresh login...')
        await notify_session_expired(address)
        
        // Get fresh signer with Discord login link
        try {
          const new_signer = await get_enoki_signer(async (login_url) => {
            console.log('[Discord] Sending re-authentication link...')
            await notify_session_expired(address, login_url)
          })
          // Update signer for next iteration
          signer = new_signer
          console.log('✅ Re-authenticated successfully!')
        } catch (auth_error) {
          console.error(`❌ Re-authentication failed: ${message_of(auth_error)}`)
          // Will retry with delay
        }
      }
      
      append_log({
        at: new Date().toISOString(),
        fight_id: '',
        won: null,
        mobs: [],
        turns: 0,
        gas_mist: '0',
        xp_gained: {},
        error: message,
      })
      const delay = retry_delay_ms(error, message)
      console.log(`waiting ${(delay / 1000).toFixed(0)}s before retrying…`)
      await sleep(delay)
    }
  }
  if (recent_fights.length > 0) await notify_fight_summary(recent_fights, `session end — ${count} fights`)
  write_status(`session done — ${count} fights attempted`, count)
  console.log(`\nsession done — ${count} fights attempted. Run "bun run session-stats" for a summary.`)
}

await main()
