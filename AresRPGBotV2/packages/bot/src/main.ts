// main entry point for AresRPGBotV2
import { play_loop } from './net/session.ts'
import { get_enoki_signer } from './auth/enoki_auth.ts'
import { config } from './config.ts'
import { log_info, log_error } from './shared/logger.ts'
import { notify } from './shared/discord_notify.ts'

// ── CLI parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2)
const cli = args[0] ?? 'run'

async function run_cli(cli: string): Promise<void> {
  log_info('cli', `running CLI: ${cli}`)

  if (cli === 'doctor') {
    log_info('cli', 'doctor: checking environment...')
    log_info('cli', `config: network=${config.network}, world=${config.world}`)
    log_info('cli', `play toggles: gather=${config.play.gather}, fight=${config.play.fight}, roam=${config.play.roam}, craft=${config.play.craft}, group=${config.play.group}`)
    log_info('cli', `idle sleep: ${config.idle_sleep_ms}ms`)
    log_info('cli', 'doctor: OK')
  } else if (cli === 'status') {
    log_info('cli', 'status: bot is running')
    log_info('cli', `config: ${config.network}/${config.rpc_url}`)
    log_info('cli', `WS: ${config.server_ws_url}`)
    log_info('cli', `origin: ${config.origin}`)
  } else if (cli === 'login') {
    log_info('cli', 'login: initiates zkLogin flow')
    log_info('cli', 'please use the interactive login flow')
  } else {
    log_info('cli', `unknown CLI: ${cli}`)
    log_info('cli', 'available: doctor, status, login, run')
  }
}

// ── main ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const cli = process.argv[2] ?? 'run'

  if (cli !== 'run') {
    await run_cli(cli)
    return
  }

  // Get zkLogin signer (handles cached session or interactive login). The cached session expires
  // periodically; when it does, the flow needs a real Google sign-in. The ONLY Discord message the
  // bot sends is this link, so an unattended operator is pinged exactly when they must act.
  log_info('main', 'initializing zkLogin session...')
  const signer = await get_enoki_signer((login_url) => {
    notify(`🔐 AresRPG sign-in required — open this link to reconnect:\n${login_url}`, 'warning')
  })
  const address = signer.toSuiAddress()

  log_info('main', 'starting AresRPGBotV2...')
  log_info('main', `config: ${config.network}/${config.rpc_url}`)
  log_info('main', `WS: ${config.server_ws_url}`)
  log_info('main', `origin: ${config.origin}`)
  log_info('main', `play: gather=${config.play.gather}, fight=${config.play.fight}, roam=${config.play.roam}, craft=${config.play.craft}, group=${config.play.group}`)
  log_info('main', `idle sleep: ${config.idle_sleep_ms}ms`)
  log_info('main', `party: up to ${config.party_size} simultaneous characters`)
  log_info('main', `character: ${address}`)

  await play_loop(
    signer,
    address,
    {
      gather: config.play.gather,
      fight: config.play.fight,
      roam: config.play.roam,
      craft: config.play.craft,
      group: config.play.group,
    },
    config.idle_sleep_ms,
  )
}

main().catch((err: any) => {
  log_error('main', `fatal error: ${err.message}`)
  process.exit(1)
})