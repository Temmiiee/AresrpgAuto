// bun run src/cli/cli_job_farm.ts [max_gathers] [--no-craft]
//
// REAL characters, real progression (still Testnet fake SUI). Runs an unattended gathering +
// crafting loop for the three producing professions (FARMER / HERBALIST / MINER): search the
// current zone, discover which character wears each profession's tool, farm every live resource
// pack - tier 1 first, so a fresh account is always reachable - and periodically craft each
// profession's flour/powder to convert gathered raw material into job XP.
//
// The actual gather/craft machinery lives in ../farm/farm_engine.ts (shared with the roaming
// CLI); this file is just the 24/7 drive loop around it. See farm_engine.ts for the design notes.
// For a pure gathering pass (no crafting — e.g. while a manual objective hoards the materials)
// pass --no-craft. When every producing job is drained the loop asks the engine to MIGRATE the
// farm to the next city region (relocate_if_stalled) instead of napping through the 2h reseed:
// fresh, undiscovered ground (new first-discoveries) and usually higher-tier packs — farm_migrate.ts.
//
// Boot does two things the group/roam session historically skipped: it resolves any party fight a
// previous process left open (characters stuck inside a Fight can't borrow a kiosk, so every
// craft/gather would abort 0x2::kiosk::borrow code 11), and it drives the party's gathering
// roster (forge/tool_craft.ts) so the profession plan is honoured — e.g. a second basic_pickaxe
// gets crafted and equipped when the quartz focus wants two MINER characters.
//
// Movement budget (world_map.move: SPEED_SCALE/SPEED_BUDGET ms per world unit) accrues from each
// character's own checkpoint; ENothingThere (1302) during a gather means the pack is drained (by
// us or someone else) - mark it and move on. Zones reseed every ZONE_RESEARCH_TTL_MS by re-searching
// the same cell IN PLACE (zone.move refresh), so this farm stays near its base indefinitely.
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { sleep } from '../shared/chain_retry.ts'
import { craft_starter_tools_if_missing, ensure_gathering_roster, DEFAULT_ROSTER_PLAN } from '../forge/tool_craft.ts'
import { resolve_leftover_fights } from '../fight/fight_recovery.ts'
import { auto_equip_available_gear } from '../market/auto_equip.ts'
import { read_position, write_position } from '../state/position_state.ts'
import { ensure_min_balance } from '../market/faucet.ts'
import { create_farm_engine, CRAFT_EVERY_MS, NAP_CHUNK_MS } from '../farm/farm_engine.ts'

const main = async () => {
  const args = process.argv.slice(2)
  const no_craft = args.includes('--no-craft')
  const max_gathers = args.find((a) => /^\d+$/.test(a)) ? Number(args.find((a) => /^\d+$/.test(a))) : Infinity
  const bot = create_bot_sdk(await get_enoki_signer())
  const log = (msg: string): void => console.log(`  ${msg}`)

  console.log(`job farm — address ${bot.address}${no_craft ? ' (no-craft)' : ''}`)
  const { balance_mist, claim } = await ensure_min_balance(bot.sdk.read_sui_balance, bot.address)
  const faucet_note = claim
    ? claim.claimed
      ? ' — faucet top-up claimed'
      : ` — faucet: ${(claim as { claimed: false; reason: string }).reason}`
    : ''
  console.log(`  balance ${(Number(balance_mist) / 1e9).toFixed(4)} SUI${faucet_note}`)

  // A fight a previous process left open holds every party character as a dynamic field of the
  // Fight object, so every craft and gather below would abort kiosk::borrow EItemNotFound (11).
  // Finish/settle any leftover party fight first (run_one_group_fight or settle happen inside);
  // if recovery can't free the party at all, stop cleanly instead of hammering the kiosk with
  // doomed transactions.
  const leftover = await resolve_leftover_fights(bot, log)
  if (leftover.kind === 'in_progress') {
    console.log('party is stuck inside a fight that recovery could not finish — finishing it manually, then re-run job-farm')
    return
  }

  // Craft starter tools and drive the gathering roster BEFORE equipping -- auto_equip fills empty
  // tool slots from the kiosk, so tools crafted this run get worn the same run (the group session
  // does equip-then-craft and misses that first-run equip).
  await craft_starter_tools_if_missing(bot, (msg) => console.log(`  [tools] ${msg}`))
  await ensure_gathering_roster(bot, DEFAULT_ROSTER_PLAN, (msg) => console.log(`  [tools] ${msg}`), 2)
  await auto_equip_available_gear(bot, (msg) => console.log(`  [equip] ${msg}`))

  const initial = read_position()
  const engine = await create_farm_engine({ bot, log, initial, migrate_on_drain: true })
  if (engine.sessions.length === 0) {
    console.log('no tooled characters — nothing to farm')
    write_position(initial)
    return
  }
  console.log(
    `  farming roster: ${engine.sessions
      .map((s) => `${s.c.name}(${s.job})`)
      .join(', ') || 'none'}`
  )

  let pass = 0
  let rounds = 0
  // Crafting is the only way to level the non-producing jobs, so it runs on a timer as well as
  // after CRAFT_EVERY_GATHERS gathers — a long gather-less stretch (zones reseeding) must not
  // stall XP from the materials already in the kiosk.
  let last_craft_at = 0
  while (engine.gathers < max_gathers) {
    pass += 1
    if (!no_craft) {
      if (!engine.craft_due && Date.now() - last_craft_at >= CRAFT_EVERY_MS) {
        engine.craft_due = true
        last_craft_at = Date.now()
      }
      await engine.craft_pass_if_due()
    }

    const round_gathers = await engine.harvest_round()
    if (round_gathers === 0) {
      const active = engine.sessions.filter((s) => !s.done)
      if (active.length === 0) {
        // Every session permanently dropped (lost its tool) — the only hard stop. Nothing else
        // marks a session done, so the farm otherwise keeps waiting on zone rerolls forever.
        console.log('\nall characters lost their gathering tools — stopping')
        break
      }
      // Every producing job drained at the same time (nothing farmable anywhere in reach): migrate
      // the farm to the next city region instead of napping through the 2h reseed — fresh ground,
      // usually higher-tier packs, and a first-discovery claim on the landing zone. The migration
      // itself walks (minutes), so a fresh round starts the moment it lands.
      if (active.every((s) => s.drained)) {
        const migration = await engine.relocate_if_stalled()
        if (migration.relocated) continue
        log('no reachable region to migrate toward — waiting for a zone reseed')
      }
      // Nothing gathered this round: nap until the EARLIEST waiting session is ready again
      // (a rearmed zone or a roam retry), so we don't hot-loop read probes while idle.
      const soonest = Math.min(...active.map((s) => s.waiting_until || 0))
      const nap = Math.min(Math.max(0, soonest - Date.now()), NAP_CHUNK_MS)
      if (nap > 0) {
        log(`nothing farmable right now — sleeping ${Math.round(nap / 1000)}s until a zone reseeds…`)
        await sleep(nap)
      } else {
        await sleep(2_000)
      }
    }
    rounds += 1
  }
  const noted = engine.sessions.filter((s) => !s.done)
  write_position(noted[0]?.anchor ?? initial)
  console.log(`\njob farm stopped — ${engine.gathers} gathers across ${rounds} rounds (${engine.sessions.length} sessions)`)
}

await main()