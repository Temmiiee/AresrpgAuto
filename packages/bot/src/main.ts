// main entry point for AresRPGAuto
import { play_loop } from './net/session.ts'
import { get_enoki_signer } from './auth/enoki_auth.ts'
import { config } from './config.ts'
import { log_info, log_error, log_configuration } from './shared/logger.ts'
import { notify, notify_await } from './shared/discord_notify.ts'
import { login } from './cli/login.ts'
import { doctor } from './cli/doctor.ts'
import { status } from './cli/status.ts'
import { start_game_content_watch } from './content/update_watch.ts'
import { analyze_fights } from './cli/fight_analyzer.ts'

// ── CLI parsing ────────────────────────────────────────────────────
async function run_cli(command: string): Promise<void> {
  log_info('cli', `running CLI: ${command}`)
  if (command === 'doctor') {
    doctor()
  } else if (command === 'status') {
    status()
  } else if (command === 'analyze-fights') {
    await analyze_fights(process.argv[3])
  } else if (command === 'login') {
    login()
  } else {
    log_info('cli', `unknown CLI: ${command}`)
    log_info('cli', 'available: doctor, status, analyze-fights, login, run')
  }
}

// ── main ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run'

  if (command !== 'run') {
    await run_cli(command)
    return
  }

  // Emit directly so a restrictive log level cannot hide why ordinary bot messages are missing
  // while SDK transaction lines remain visible.
  console.info(`[startup] application logging: ${log_configuration()}`)

  // Get zkLogin signer (handles cached session or interactive login). The cached session expires
  // periodically; when it does, the flow needs a real Google sign-in. The ONLY Discord message the
  // bot sends is this link, so an unattended operator is pinged exactly when they must act.
  log_info('main', 'initializing zkLogin session...')
  const login_started_ms = Date.now()
  const signer = await get_enoki_signer((login_url) => {
    notify(`🔐 AresRPG sign-in required — open this link to reconnect:\n${login_url}`, 'warning')
  })
  log_info('main', `zkLogin ready in ${((Date.now() - login_started_ms) / 1_000).toFixed(1)}s`)
  const address = signer.toSuiAddress()

  log_info('main', 'starting AresRPGAuto...')
  log_info('main', `runtime: network=${config.network}, party≤${config.party_size}`)
  log_info(
    'main',
    `actions: gather=${config.play.gather}, fight=${config.play.fight}, roam=${config.play.roam}, craft=${config.play.craft}, group=${config.play.group}, cross_world=${config.play.cross_world}`
  )
  // The upstream check is delayed so its parallel requests cannot contend with startup.
  start_game_content_watch()

  await play_loop(
    signer,
    address,
    {
      gather: config.play.gather,
      fight: config.play.fight,
      roam: config.play.roam,
      craft: config.play.craft,
      group: config.play.group,
      cross_world: config.play.cross_world,
    },
    config.idle_sleep_ms,
  )
}

main().catch(async (err: any) => {
  log_error('main', `fatal error: ${err.message}`)
  // An unattended operator must learn the bot died, not discover it hours later — flush the fatal
  // notice before exiting (notify_await, not the fire-and-forget notify).
  await notify_await(`❌ AresRPGAuto crashed — ${err?.message ?? String(err)}`, 'error')
  process.exit(1)
})

// An unhandled rejection or exception anywhere else is also fatal: report it before the process
// dies so the operator is never left wondering whether the bot is still farming.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  log_error('main', `unhandled rejection: ${message}`)
  void notify_await(`❌ AresRPGAuto unhandled rejection — ${message}`, 'error')
})
process.on('uncaughtException', (error) => {
  log_error('main', `uncaught exception: ${error.message}`)
  void notify_await(`❌ AresRPGAuto uncaught exception — ${error.message}`, 'error')
})
