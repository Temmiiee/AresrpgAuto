// bun run src/cli/cli_roam.ts [max_expeditions] [--no-craft]
//
// The roaming expedition loop: alternates group battles and resource gathering/crafting in a
// zone, then travels FAR outward when the zone is fought-out and drained, aiming at the outward
// zone whose mob level band tops out near the party (level-guided expedition). This is the
// iterative unpacking of the old single-zone farm: instead of re-searching the SAME zone in place
// forever, once nothing here is worth fighting AND nothing is worth gathering, the party walks
// outward and repeats. Zones reseed on their own 2h TTL in the background, so the party always
// walks TOWARD the frontier and never needs to double back for a stale zone.
// Pure gathering mode: pass --no-craft to skip the harvest/craft passes AND their supply detours
// (the battle + gather + discover loop still runs).
//
// Phase A — battle:   `run_one_group_fight` until the zone runs out of winnable groups (the fight
//   discovery machinery stops us with a "win-rate floor" / "within reach" abort, exactly like the
//   group-session CLI) or a per-expedition battle cap is hit.
// Phase B — harvest:  the shared farm_engine (same code as cli_job_farm) gathers + crafts the
//   zone's resource packs; we drive its rounds until every session is waiting on a reroll / retry
//   (i.e. the zone is drained) OR a per-expedition gather cap is hit.
// Phase C — mastery:  today's daily dungeon quest (read quest -> resolve dungeon -> craft keys ->
//   clear rooms), once per chain epoch — the roamer checks it at the TOP of every expedition (so a
//   session surfaces the quest state immediately and the sell pass can reserve its materials), but
//   it assigns a new quest only when the epoch's quest is still open.
// Phase D — travel:   party levels are read live, and `maybe_relocate_zone` walks the party
//   outward to a zone whose top band challenges it (level-guided). Recorded position moves with
//   the party so the next expedition resumes from the frontier.
// Phase E — discovery: one first-discovery sweep per expedition (zone_discovery.ts) — claim a
//   still-undiscovered in-band neighbor zone: fresh untouched population (mobs + resources) and
//   the first-discovery leaderboard credit.
//
// Movement needs no transaction: the party's next search/engage proves the walk (world_map.move
// proves a character's checkpoint covers the distance), so Phase C only sleeps travel_time_ms,
// exactly like fight_discovery waits before engaging an in-zone group.
//
// A fresh BotSdk is created per phase (battle/harvest) — reusing one across both phases hits the
// same SDK object-cache staleness that cli_group_session documented on 2026-09-05, and the farm
// engine re-seeds movement from on-chain checkpoints at each create, which a long-lived engine
// would miss after battles move the party.
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { run_one_group_fight } from '../fight/fight_session.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import { message_of, is_insufficient_balance } from '../shared/chain_retry.ts'
import { notify_session_expired, notify_session_start } from '../shared/discord_notify.ts'
import { notify_rare_loot, notify_fight_summary, notify_expedition_summary } from '../shared/discord_reports.ts'
import { read_position, write_position } from '../state/position_state.ts'
import { append_log, clear_log, type FightLogEntry } from '../state/session_log.ts'
import { write_status } from '../state/status_state.ts'
import { acquire_session_lock, release_session_lock } from '../state/session_lock.ts'
import { GAS_WARN_MIST, mist_to_sui } from '../state/session_stats.ts'
import { CHARACTERS, LEADER, WORLD } from '../config/party_config.ts'
import { read_pet_mounted } from '../shared/pet_mount.ts'
import { value_drops, calculate_farming_profit } from '../market/item_valuation.ts'
import { ensure_min_balance, mist_to_sui_string, faucet_cooldown_remaining_ms } from '../market/faucet.ts'
import { auto_sell_spare_loot } from '../market/auto_sell.ts'
import { auto_equip_available_gear } from '../market/auto_equip.ts'
import { craft_starter_tools_if_missing, ensure_gathering_roster, DEFAULT_ROSTER_PLAN } from '../forge/tool_craft.ts'
import {
  create_farm_engine,
  CRAFT_EVERY_MS,
  NAP_CHUNK_MS,
} from '../farm/farm_engine.ts'
import { maybe_relocate_zone, maybe_back_off_zone, travel_time_ms } from '../shared/zone_relocation.ts'
import { plan_supply_run } from '../shared/craft_supply.ts'
import { discover_sweep } from '../shared/zone_discovery.ts'
import { run_daily_dungeon_quest } from '../dungeon/dungeon_session.ts'
import { read_mastery_row } from '../dungeon/mastery_quest.ts'
import { resolve_leftover_fights } from '../fight/fight_recovery.ts'

// A long-roaming session must outlive any single transient RPC/consensus hiccup. The SDK's
// grpc-web transport fires fire-and-forget sub-promises that reject on rate limits
// (RESOURCE_EXHAUSTED / HTTP 429) OUTSIDE every try/catch in the phase code — by default an
// unhandled rejection kills the whole process. These guards log it, keep the loop alive, and the
// next phase rebuilds a fresh BotSdk/retries on its own cadence (nothing on-chain changed on a
// rejected read, so continuing is always safe — unlike an aborted tx, which still throws through
// submit_with_retry and is handled by the phase-level catch).
process.on('unhandledRejection', (reason) => {
  console.log(`  [roam] unhandled rejection (${message_of(reason)}) — keeping session alive`)
})
process.on('uncaughtException', (error) => {
  console.log(`  [roam] uncaught exception (${message_of(error)}) — keeping session alive`)
})

// ── cadence / safety bounds ──────────────────────────────────────────────────────────────────────

// Max battles per expedition zone. After this the roamer moves to harvest even if groups remain —
// battles are the XP sink but they burn gas every turn, so a zone is never completely fight-spent
// in one pass; leftover groups get re-engaged on a later pass (they only despawn on engage).
const BATTLES_PER_ZONE = Number(process.env.ROAM_BATTLES ?? 5)
// Max harvest rounds per expedition zone before traveling onward regardless. A round is one pass
// across every session; when a round gathers 0 the engine schedules reroll waits, so this mostly
// bounds the nap while a zone reseeds.
const HARVEST_ROUNDS_PER_ZONE = Number(process.env.ROAM_HARVEST_ROUNDS ?? 6)
const RETRY_DELAY_MS = 30_000
const NO_TARGET_RETRY_DELAY_MS = 10 * 60_000 // zones only reroll every 2h — no point hammering
const MAX_CONSECUTIVE_LOSSES = process.env.MAX_CONSECUTIVE_LOSSES ? Number(process.env.MAX_CONSECUTIVE_LOSSES) : 5
const MAX_SESSION_GAS_MIST = BigInt(
  Math.round((process.env.MAX_SESSION_GAS_SUI ? Number(process.env.MAX_SESSION_GAS_SUI) : 1) * 1e9)
)
// Same reasoning as cli_group_session: an "insufficient balance" gas-selection failure changes
// nothing for a while, so retrying every 30s just hammers a doomed transaction.
const INSUFFICIENT_BALANCE_MIN_RETRY_DELAY_MS = 2 * 60_000
const SUMMARY_EVERY = Number(process.env.DISCORD_SUMMARY_EVERY ?? 10) || 10
// Supply run: after a craft pass is blocked for missing ingredients, the roamer walks to the
// city whose mobs drop them, fights a bounded number of groups there (in-city groups sit far
// below the party level band, so the discovery window accepts them all), then walks back.
const SUPPLY_BATTLES = Number(process.env.ROAM_SUPPLY_BATTLES ?? 4)
// Ceiling on a whole supply round trip; a city only worth the detour when the walk is sane
// travel-wise. Default 40 min round trip.
const SUPPLY_MAX_TRAVEL_MS = Number(process.env.ROAM_SUPPLY_MAX_TRAVEL_MIN ?? 40) * 60_000

const sleep_sec = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const timestamp = () => new Date().toISOString().slice(11, 19)
const describe_mobs = (mobs: readonly { mob_type: string; level: number }[]) =>
  mobs.map((m) => `${m.mob_type}(lv${m.level})`).join(', ')

const retry_delay_ms = (error: unknown, message: string): number => {
  if (/No group in this zone is within reach/.test(message)) return NO_TARGET_RETRY_DELAY_MS
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
  let signer = await get_enoki_signer(async (login_url) => {
    console.log('[Discord] Sending re-authentication link...')
    await notify_session_expired('pending...', login_url)
  })

  const address = create_bot_sdk(signer).address
  const args = process.argv.slice(2)
  const no_craft = args.includes('--no-craft')
  const max_expeditions = args.find((a) => /^\d+$/.test(a)) ? Number(args.find((a) => /^\d+$/.test(a))) : Infinity
  console.log(
    `roam session — address ${address}, up to ${max_expeditions === Infinity ? 'unlimited' : max_expeditions} expeditions${no_craft ? ' (no-craft)' : ''}`
  )
  await notify_session_start(address, max_expeditions === Infinity ? 'unlimited' : max_expeditions)

  const boot_bot = create_bot_sdk(signer)
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
  try {
    await ensure_gathering_roster(
      boot_bot,
      DEFAULT_ROSTER_PLAN,
      (msg) => console.log(`  [tools] ${msg}`),
      2
    )
  } catch (error) {
    console.log(`  [tools] roster assignment cancelled this session start (${message_of(error)})`)
  }

  let position = read_position()
  let expedition = 0
  let battles = 0
  let gathers = 0
  let consecutive_losses = 0
  let phase_too_hard = false
  let session_gas_mist = 0n
  const recent_fights: FightLogEntry[] = []
  // Per-expedition battle tallies — reset at the top of every loop pass, reported in the
  // expedition Discord summary (recent_fights is a rolling summary window, not a full record).
  let expedition_battles = 0
  let expedition_wins = 0

  const log_phase = (label: string, detail = ''): void => {
    console.log(`\n[${timestamp()}] === ${label}${detail ? ` — ${detail}` : ''} ===`)
    write_status(`${label}${detail ? ` — ${detail}` : ''}`, battles)
  }

  // Live party levels — the quantity zone_relocation guides the walk on. Re-read each expedition
  // so the party's progression is reflected even mid-session. All four stat reads are
  // independent, so they run concurrently (one RPC each, ~30-80ms — the sequential version
  // strung four round-trips in a row).
  const party_levels = async (): Promise<Map<string, number>> => {
    const levels = new Map<string, number>()
    const reads = await Promise.all(
      CHARACTERS.map(async (c) => {
        try {
          return { c, stats: await read_live_character_stats(boot_bot.sdk, c.id) }
        } catch (error) {
          console.warn(`  [levels] ${c.name} stat read failed (${message_of(error)})`)
          return { c, stats: null }
        }
      })
    )
    for (const { c, stats } of reads) levels.set(c.id, stats?.level ?? 1)
    return levels
  }

  const run_battle_phase = async (): Promise<boolean> => {
    let fought = 0
    for (let i = 0; i < BATTLES_PER_ZONE; i += 1) {
      const bot = create_bot_sdk(signer)
      battles += 1
      expedition_battles += 1
      console.log(`\n[${timestamp()}] === battle ${battles} ===`)
      write_status(`battle ${battles}: starting…`, battles)
      try {
        const { balance_mist, claim } = await ensure_min_balance(bot.sdk.read_sui_balance, bot.address)
        if (claim?.claimed) {
          console.log(
            `  ⛽ balance ${mist_to_sui_string(balance_mist)} SUI — claimed from faucet (${claim.coins_sent} coin(s))`
          )
        } else if (claim && !claim.claimed) {
          console.log(`  ⛽ balance ${mist_to_sui_string(balance_mist)} SUI — faucet claim failed (${claim.reason})`)
        }

        const outcome = await run_one_group_fight(bot, position, (msg) => {
          console.log(`  ${msg}`)
          write_status(msg, battles)
        })
        position = outcome.new_position
        write_position(position)

        const gas_mist_bigint = outcome.gas_mist
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
        recent_fights.push(entry)
        if (recent_fights.length >= SUMMARY_EVERY) {
          await notify_fight_summary(recent_fights, `${battles} fights — recap`)
          recent_fights.length = 0
        }

        const drop_summary =
          Object.entries(outcome.drops ?? {})
            .map(([item, qty]) => `${item} x${qty}`)
            .join(', ') || 'none'
        write_status(`battle ${battles}: ${outcome.won ? 'WON' : 'LOST'} vs ${describe_mobs(outcome.mobs)}`, battles)
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
        if (outcome.won) expedition_wins += 1
        session_gas_mist += gas_mist_bigint
        if (consecutive_losses >= MAX_CONSECUTIVE_LOSSES) {
          console.log(
            `\n⛔ stopping: ${consecutive_losses} losses in a row (MAX_CONSECUTIVE_LOSSES=${MAX_CONSECUTIVE_LOSSES}) — ` +
              `likely a bad matchup, a policy regression, or something wrong on-chain. Investigate before restarting.`
          )
          write_status(`session stopped: ${consecutive_losses} losses in a row`, battles)
          process.exit(1)
        }
        if (session_gas_mist >= MAX_SESSION_GAS_MIST) {
          console.log(
            `\n⛔ stopping: cumulative session gas spend ${mist_to_sui(session_gas_mist)} SUI has reached the ` +
              `MAX_SESSION_GAS_SUI=${mist_to_sui(MAX_SESSION_GAS_MIST)} cap. Restart explicitly (optionally with a ` +
              `higher MAX_SESSION_GAS_SUI) to keep going.`
          )
          write_status(`session stopped: gas cap reached (${mist_to_sui(session_gas_mist)} SUI)`, battles)
          process.exit(1)
        }
      } catch (error) {
        const message = message_of(error)
        console.log(`[${timestamp()}] battle ${battles} errored: ${message}`)
        write_status(`battle ${battles}: error — ${message}`, battles)
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
        // Zone fought out / nothing winnable — break the battle phase and move to harvest+travel.
        // Both messages mean the CURRENT zone has nothing worth fighting: the "within reach" one
        // is mobs running above the party's level band, the "win-rate floor" one is level-eligible
        // but unwinnable in practice. Either way the roamer should retreat inward a beat rather
        // than relocate OUTWARD to a harder zone (that direction is for when we're farming a zone
        // too weak for the party, not one we can't clear).
        if (/No group in this zone is within reach|clears the .*% win-rate floor/.test(message)) {
          phase_too_hard = true
          await sleep_sec(RETRY_DELAY_MS)
          return fought > 0
        }
        // Re-auth on session expiry (rare, mid-session).
        if (/ZKLogin expired|Invalid user signature/.test(message)) {
          console.log('🔄 Session expired - requesting fresh login...')
          await notify_session_expired(address)
          try {
            signer = await get_enoki_signer(async (login_url) => {
              console.log('[Discord] Sending re-authentication link...')
              await notify_session_expired(address, login_url)
            })
            console.log('✅ Re-authenticated successfully!')
          } catch {
            // keep old signer; retry after delay
          }
        }
        const delay = retry_delay_ms(error, message)
        console.log(`waiting ${(delay / 1000).toFixed(0)}s before retrying…`)
        await sleep_sec(delay)
      }
      fought += 1
    }
    return fought > 0
  }

  const run_harvest_phase = async (): Promise<{
    gathers: number
    crafts_succeeded: number
    crafts_blocked: number
    crafts_failed: number
    missing: Map<string, number>
  }> => {
    const bot = create_bot_sdk(signer)
    const log = (msg: string): void => console.log(`  ${msg}`)
    const engine = await create_farm_engine({ bot, log, initial: position })

    let gathered_before = engine.gathers
    let last_craft_at = 0
    let idle_rounds = 0
    for (let round = 0; round < HARVEST_ROUNDS_PER_ZONE; round += 1) {
      if (!no_craft) {
        if (!engine.craft_due && Date.now() - last_craft_at >= CRAFT_EVERY_MS) {
          engine.craft_due = true
          last_craft_at = Date.now()
        }
        await engine.craft_pass_if_due()
      }
      const landed = await engine.harvest_round()
      gathers += engine.gathers - gathered_before
      gathered_before = engine.gathers
      if (landed > 0) {
        idle_rounds = 0
        continue
      }
      // Nothing landed this round. If every session is parked on a reroll/retry wait, the zone
      // is drained — that's the roamer's signal to move on (unlike cli_job_farm, which naps
      // through the 2h reseed). Give it two park cycles before deciding, in case packs are just
      // on the edge of a walk budget.
      const active = engine.sessions.filter((s) => !s.done)
      if (active.length === 0) break
      if (active.every((s) => s.waiting_until > Date.now())) {
        idle_rounds += 1
        if (idle_rounds >= 2) break
      }
      await sleep_sec(NAP_CHUNK_MS)
    }
    log(`harvest phase done`)
    return {
      gathers: engine.gathers,
      crafts_succeeded: engine.crafts_succeeded,
      crafts_blocked: engine.crafts_blocked,
      crafts_failed: engine.crafts_failed,
      // In no-craft mode there is no craft pass to plan supply for — skip the read/stat work.
      missing: no_craft ? new Map<string, number>() : await engine.missing_materials(),
    }
  }

  const run_mastery_phase = async (): Promise<void> => {
    const bot = create_bot_sdk(signer)
    const log = (msg: string): void => console.log(`  ${msg}`)

    // A fight a previous process left open holds every character OUT of the kiosk — the quest
    // assignment borrows the leader from it (start_daily_quest -> kiosk::borrow) and would abort
    // EItemNotFound. Settle/finish any leftover party fight first (the battle phase would too,
    // but it runs AFTER this phase — too late for today's borrow).
    const leftover = await resolve_leftover_fights(bot, log)
    if (leftover.kind === 'in_progress') {
      log(`party is still inside a fight that recovery couldn't resolve — the battle phase will finish it; skipping mastery this pass`)
      return
    }

    // Read-only gate before committing an assign tx: the quest resets once per chain epoch
    // (~1 day), so a long-running roamer shouldn't call mastery.start() every expedition — only
    // when the row says the quest is actually still open. If the read fails for any reason, let
    // run_daily_dungeon_quest sort it out (its own ensure_daily_quest asserts correctly).
    try {
      const row = await read_mastery_row(bot, bot.mastery.id)
      if (row && row.quest_completed) {
        log(`mastery quest already completed this epoch — skipping`)
        return
      }
    } catch (error) {
      log(`mastery row read failed (${message_of(error)}) — attempting the quest anyway`)
    }

    log_phase(`mastery quest`, `today's dungeon`)
    const outcome = await run_daily_dungeon_quest(bot, log)
    // The dungeon entered the party at its portal and wrote the new position — keep the local
    // travel anchor in sync so the relocation phase walks outward from where the party is.
    position = read_position()
    if (outcome.kind === 'run') {
      console.log(
        `  ${outcome.cleared ? 'CLEARED' : 'run ended'} ${outcome.dungeon} (${outcome.rooms_cleared} room(s))`
      )
    } else if (outcome.kind === 'not_enough_keys') {
      console.log(`  not enough ${outcome.dungeon} keys (${outcome.have}/${outcome.need}) — will retry next expedition`)
    }
  }

  // Supply run: a craft pass reported ingredients it can't obtain by gathering in the frontier
  // zone (the tell-tale "not enough X materials" block), so the roamer makes a bounded detour to
  // the city whose mobs drop those ingredients (plan_supply_run), fights a few low-level in-city
  // groups there, then walks home. The city fights count toward the session/expedition battle
  // totals so the Discord summary stays truthful, and every fight gets the same loot/rare-loot
  // reporting as a frontier one. No loss-streak / gas-cap exits here on purpose: in-city groups
  // sit far below the party band (win floor passes trivially), and the walk home is independent.
  const run_supply_phase = async (missing: ReadonlyMap<string, number>): Promise<number> => {
    // The party walks leader-led — plan the out/back legs at the ×1.5 mounted speed when its pet
    // is on both ends (read failure degrades to unmounted: the honest slow plan is always provable).
    let pet_mounted = false
    try {
      const bot = create_bot_sdk(signer)
      pet_mounted = await read_pet_mounted(bot, LEADER.id, WORLD)
    } catch (error) {
      console.log(`  pet mount read failed (${message_of(error)}) — supply walk unmounted`)
    }

    const plan = plan_supply_run(position, missing, SUPPLY_MAX_TRAVEL_MS)
    if (!plan) {
      console.log(`  no reachable supply source for missing mats (${[...missing.keys()].join(', ')}) — skipping`)
      return 0
    }
    const home = position
    const out_ms = travel_time_ms(position, plan.target)
    log_phase(`supply run`, `${plan.city} — need ${[...missing.keys()].join(', ')}`)
    console.log(
      `  walking ${Math.round(Math.hypot(plan.target.x - position.x, plan.target.z - position.z))} blocks to ${plan.city} ` +
        `(≈${Math.ceil(out_ms / 1000)}s one way)${pet_mounted ? ' — riding a pet' : ''}…`
    )
    await sleep_sec(out_ms)
    position = plan.target
    write_position(position)

    let fought = 0
    for (let i = 0; i < SUPPLY_BATTLES; i += 1) {
      const bot = create_bot_sdk(signer)
      battles += 1
      expedition_battles += 1
      console.log(`\n[${timestamp()}] === supply battle ${i + 1}/${SUPPLY_BATTLES} @ ${plan.city} ===`)
      write_status(`supply battle ${i + 1}/${SUPPLY_BATTLES} @ ${plan.city}: starting…`, battles)
      try {
        const outcome = await run_one_group_fight(bot, position, (msg) => {
          console.log(`  ${msg}`)
          write_status(msg, battles)
        })
        position = outcome.new_position
        write_position(position)

        const gas_sui = Number(outcome.gas_mist) / 1e9
        const valuation = value_drops(outcome.drops ?? {})
        const profit = calculate_farming_profit(valuation.total_sui, gas_sui)
        const entry: FightLogEntry = {
          at: new Date().toISOString(),
          fight_id: outcome.fight_id,
          won: outcome.won,
          mobs: outcome.mobs,
          turns: outcome.turns,
          gas_mist: outcome.gas_mist.toString(),
          xp_gained: outcome.xp_gained,
          error: null,
          drops: outcome.drops,
          drops_value_sui: valuation.total_sui,
          net_profit_sui: profit.net_profit_sui,
        }
        append_log(entry)
        await notify_rare_loot(outcome.drops ?? {}, outcome.fight_id)
        recent_fights.push(entry)
        if (recent_fights.length >= SUMMARY_EVERY) {
          await notify_fight_summary(recent_fights, `${battles} fights — recap`)
          recent_fights.length = 0
        }
        if (outcome.won) expedition_wins += 1
        session_gas_mist += outcome.gas_mist
        consecutive_losses = outcome.won ? 0 : consecutive_losses + 1
        const drop_summary =
          Object.entries(outcome.drops ?? {})
            .map(([item, qty]) => `${item} x${qty}`)
            .join(', ') || 'none'
        write_status(
          `supply battle ${i + 1}/${SUPPLY_BATTLES}: ${outcome.won ? 'WON' : 'LOST'} vs ${describe_mobs(outcome.mobs)}`,
          battles
        )
        console.log(
          `[${timestamp()}] ${outcome.won ? 'WON' : 'LOST'} vs ${describe_mobs(outcome.mobs)} — ${outcome.turns} turns, gas: ${gas_sui.toFixed(4)} SUI` +
            ` | drops: ${drop_summary} (+${valuation.total_sui.toFixed(4)} SUI est.)`
        )
        if (consecutive_losses >= MAX_CONSECUTIVE_LOSSES) {
          console.log(
            `\n⛔ stopping: ${consecutive_losses} losses in a row (MAX_CONSECUTIVE_LOSSES=${MAX_CONSECUTIVE_LOSSES}) — ` +
              `likely a bad matchup, a policy regression, or something wrong on-chain. Investigate before restarting.`
          )
          write_status(`session stopped: ${consecutive_losses} losses in a row`, battles)
          process.exit(1)
        }
        if (session_gas_mist >= MAX_SESSION_GAS_MIST) {
          console.log(
            `\n⛔ stopping: cumulative session gas spend ${mist_to_sui(session_gas_mist)} SUI has reached the ` +
              `MAX_SESSION_GAS_SUI=${mist_to_sui(MAX_SESSION_GAS_MIST)} cap. Restart explicitly (optionally with a ` +
              `higher MAX_SESSION_GAS_SUI) to keep going.`
          )
          write_status(`session stopped: gas cap reached (${mist_to_sui(session_gas_mist)} SUI)`, battles)
          process.exit(1)
        }
        fought += 1
      } catch (error) {
        const message = message_of(error)
        console.log(`  supply battle ${i + 1} errored: ${message}`)
        write_status(`supply battle ${i + 1}: error — ${message}`, battles)
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
        if (/No group in this zone is within reach|clears the .*% win-rate floor/.test(message)) {
          console.log(`  ${plan.city} zone not producing winnable groups — ending supply run`)
          break
        }
        await sleep_sec(RETRY_DELAY_MS)
      }
    }

    // Walk back to the original frontier anchor so the loop's relocation math starts where the
    // party actually is; the sleep covers the same travel gate the next engage will prove.
    const back_ms = travel_time_ms(position, home, pet_mounted)
    console.log(`\nsupply run done (${fought} battle(s)) — walking back ${Math.round(Math.hypot(home.x - position.x, home.z - position.z))} blocks (≈${Math.ceil(back_ms / 1000)}s)…`)
    await sleep_sec(back_ms)
    position = home
    write_position(position)
    return fought
  }

  while (expedition < max_expeditions) {
    expedition += 1
    log_phase(`expedition ${expedition}`, `(${Math.round(position.x)},${Math.round(position.z)})`)

    expedition_battles = 0
    expedition_wins = 0

    const expedition_stats = {
      gathers_landed: 0,
      crafts_succeeded: 0,
      crafts_blocked: 0,
      crafts_failed: 0,
      supply_fights: 0,
      discovery_claimed: null as string | null,
      relocated: false,
      backed_off: false,
    }

    // Phase C (run first each pass): the mastery daily quest — today's dungeon, cleared if the
    // party holds (or can craft) the keys. Checking before the day's battles surfaces the quest
    // state (assigned / completed / missing keys) immediately instead of after the battle and
    // harvest phases. Once per epoch; skips itself when already completed.
    try {
      await run_mastery_phase()
    } catch (error) {
      // Same contract as the battles below: a transient RPC hiccup must not end the session —
      // log it, rebuild a fresh BotSdk next phase, and keep the loop going (nothing on-chain
      // changed on a rejected read; an aborted tx still throws through submit_with_retry and is
      // handled inside run_daily_dungeon_quest's own retries).
      console.log(`  mastery phase failed (${message_of(error)}) — continuing`)
      await sleep_sec(RETRY_DELAY_MS)
    }

    // Phase A: battles at the frontier, until the zone stops producing winnable groups.
    try {
      await run_battle_phase()
    } catch (error) {
      console.log(`  battle phase failed (${message_of(error)}) — continuing`)
      await sleep_sec(RETRY_DELAY_MS)
    }

    // Phase B: gather + craft the zone's packs, then craft even after packs dry — kiosk materials
    // keep converting to job XP while the zone reseeds.
    let harvest_missing = new Map<string, number>()
    try {
      const harvest = await run_harvest_phase()
      expedition_stats.gathers_landed += harvest.gathers
      expedition_stats.crafts_succeeded += harvest.crafts_succeeded
      expedition_stats.crafts_blocked += harvest.crafts_blocked
      expedition_stats.crafts_failed += harvest.crafts_failed
      if (harvest.missing.size > 0) harvest_missing = harvest.missing
    } catch (error) {
      console.log(`  harvest phase failed (${message_of(error)}) — continuing`)
      await sleep_sec(RETRY_DELAY_MS)
    }

    // Phase B2: craft-block supply run — the frontier can't gather what the craft pass wants, so
    // make a bounded detour to the city whose mobs drop the missing ingredients, then walk back.
    // No-craft mode never plans a supply run (there is no craft pass to feed).
    if (!no_craft && harvest_missing.size > 0) {
      try {
        const supply_fights = await run_supply_phase(harvest_missing)
        if (supply_fights > 0) {
          expedition_stats.supply_fights += supply_fights
          console.log(
            `  supply run fought ${supply_fights} group(s) for missing craft materials (${[...harvest_missing.keys()].join(', ')})`
          )
        }
      } catch (error) {
        console.log(`  supply run failed (${message_of(error)}) — continuing`)
        await sleep_sec(RETRY_DELAY_MS)
      }
    }

    // Phase C ran first — no second run here: the quest is once per chain epoch and the party
    // won't have more key materials until the battle/harvest phases just ran produce some.

    // Gathering roster retry: crafting a starter tool is a probabilistic roll that BURNS
    // ingredients on a failed attempt, so the boot-time attempts alone can leave the party short
    // of its gathering roster for the whole session (two unlucky rolls in a row has happened
    // live). Retry once per expedition, cheaply and idempotently, until every planned character
    // holds its plan tool — the supply run above just had a chance to replenish what a failed
    // roll burned.
    try {
      await ensure_gathering_roster(create_bot_sdk(signer), DEFAULT_ROSTER_PLAN, (msg) =>
        console.log(`  [tools] ${msg}`)
      )
    } catch (error) {
      console.log(`  [tools] roster reassignment skipped this expedition (${message_of(error)})`)
    }

    // Phase D: level-guided travel — the whole point of roaming. Walk OUTWARD to the zone whose
    // top band challenges the party (when the current zone is beneath it); back off INWARD when
    // the current zone proved too hard (discovery refused it outright or a loss streak piled up).
    const levels = await party_levels()
    const avg = [...levels.values()].reduce((a, b) => a + b, 0) / Math.max(1, levels.size)
    log_phase(`relocating`, `party avg lv ${avg.toFixed(1)}`)

    // The relocation walk is leader-led — plan it at the ×1.5 mounted speed when the leader's pet
    // is on both ends (read failure degrades to unmounted: the honest slow plan is always provable).
    let leader_mounted = false
    try {
      const bot = create_bot_sdk(signer)
      leader_mounted = await read_pet_mounted(bot, LEADER.id, WORLD)
    } catch (error) {
      console.log(`  pet mount read failed (${message_of(error)}) — relocating unmounted`)
    }

    if (phase_too_hard || consecutive_losses > 0) {
      const back = await maybe_back_off_zone(position, levels, (msg) => console.log(`  ${msg}`), leader_mounted)
      if (back) {
        position = back
        write_position(position)
        expedition_stats.backed_off = true
        log_phase(`backed off`, `(${Math.round(position.x)},${Math.round(position.z)})`)
      }
      phase_too_hard = false
      consecutive_losses = 0
    } else {
      const target = await maybe_relocate_zone(position, levels, (msg) => console.log(`  ${msg}`), leader_mounted)
      if (target) {
        position = target
        write_position(position)
        expedition_stats.relocated = true
      } else {
        // Zone already at/above the party: stay and let the 2h reseed + harvest re-fight the same
        // frontier. Nothing to walk toward — the expedition loop simply tightens on this zone.
        console.log(`  staying in place — this zone already challenges the party (avg lv ${avg.toFixed(1)})`)
      }
    }

    // Phase E: first-discovery sweep — claim still-undiscovered in-band neighbor zones (fresh
    // population: untouched mob groups + resource packs, plus the leaderboard's first-discovery
    // credit). A couple of claims per expedition so a pass genuinely widens the party's frontiers;
    // the walk follows the same travel gate as the relocation above, and a missed claim (someone
    // faster) is just a skipped pass, not a failure. Runs after relocation so the sweep anchor is
    // wherever the party just landed.
    const DISCOVERY_CLAIMS_PER_EXPEDITION = 2
    for (let claim_i = 0; claim_i < DISCOVERY_CLAIMS_PER_EXPEDITION; claim_i += 1) {
      try {
        const bot = create_bot_sdk(signer)
        const claim = await discover_sweep(bot, position, avg, (msg) => console.log(`  ${msg}`))
        if (!claim) break
        position = claim
        write_position(position)
        expedition_stats.discovery_claimed = `(${Math.round(claim.x)},${Math.round(claim.z)})`
        log_phase(`discovery claimed`, `(${Math.round(position.x)},${Math.round(position.z)})`)
      } catch (error) {
        console.log(`  discovery sweep skipped this round (${message_of(error)})`)
        break
      }
    }

    try {
      const bot = create_bot_sdk(signer)
      await auto_sell_spare_loot(bot, (msg) => console.log(`  [sell] ${msg}`))
    } catch (error) {
      console.log(`  auto-sell skipped this round (${message_of(error)})`)
    }

    // Recap the whole expedition on Discord — battles are the only thing the fight summary
    // notified during the session, so this is where harvest/craft/discovery actually surface.
    await notify_expedition_summary({
      expedition,
      position: `${Math.round(position.x)},${Math.round(position.z)}`,
      battles: expedition_battles,
      wins: expedition_wins,
      losses: expedition_battles - expedition_wins,
      gathers: expedition_stats.gathers_landed,
      crafts_succeeded: expedition_stats.crafts_succeeded,
      crafts_blocked: expedition_stats.crafts_blocked,
      crafts_failed: expedition_stats.crafts_failed,
      supply_fights: expedition_stats.supply_fights,
      discovery: expedition_stats.discovery_claimed,
      relocated: expedition_stats.relocated,
      backed_off: expedition_stats.backed_off,
    })
  }

  if (recent_fights.length > 0) await notify_fight_summary(recent_fights, `session end — ${expedition} expeditions`)
  write_position(position)
  write_status(`session done — ${expedition} expeditions, ${battles} battles, ${gathers} gathers`, battles)
  console.log(
    `\nroam session stopped — ${expedition} expeditions, ${battles} battles, ${gathers} gathers. Run "bun run session-stats" for a summary.`
  )
}

await main()