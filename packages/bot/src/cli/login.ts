// login CLI – performs the one-time interactive zkLogin Google sign-in and caches the session.
// After this, `bun run start` reuses the cached session headlessly until it expires.
import { log_info, log_error } from '../shared/logger.ts'
import { notify_await } from '../shared/discord_notify.ts'
import { get_enoki_signer } from '../auth/enoki_auth.ts'

export const login = async (): Promise<void> => {
  log_info('login', 'initiating zkLogin flow...')
  try {
    const signer = await get_enoki_signer((url) => {
      void notify_await(`🔐 AresRPG sign-in required — open this link to reconnect:\n${url}`, 'warning')
    })
    log_info('login', `signed in as ${signer.toSuiAddress()}`)
    log_info('login', 'session cached — run `bun run start` to farm headlessly')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log_error('login', `sign-in failed: ${message}`)
    await notify_await(`❌ AresRPGAuto sign-in failed — ${message}`, 'error')
    process.exit(1)
  }
}
