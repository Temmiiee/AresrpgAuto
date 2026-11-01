// doctor CLI – checks bot environment and configuration
import { log_info } from '../shared/logger.ts'
import { config } from '../config.ts'

export const doctor = (): void => {
  log_info('doctor', 'checking environment...')
  log_info('doctor', `network: ${config.network}`)
  log_info('doctor', `rpc endpoint: ${config.rpc_url ? 'configured' : 'not set'}`)
  log_info('doctor', `server WS: ${config.server_ws_url ? 'configured' : 'not set'}`)
  log_info('doctor', `origin: ${config.origin ? 'configured' : 'not set'}`)
  log_info('doctor', `enoki API key: ${config.enoki_api_key ? 'configured' : 'not set'}`)
  log_info('doctor', `google client: ${config.google_client_id ? 'configured' : 'not set'}`)
  log_info('doctor', `login port: ${config.login_port}`)
  log_info('doctor', `discord webhook: ${config.discord_webhook_url ? 'configured' : 'not set'}`)
  log_info('doctor', `discord mention: ${config.discord_mention ?? 'not set'}`)
  log_info('doctor', `character ID: ${config.character_id ?? 'not set'}`)
  log_info('doctor', `world: ${config.world ?? 'not set'}`)
  log_info('doctor', `play toggles: gather=${config.play.gather}, fight=${config.play.fight}, roam=${config.play.roam}, craft=${config.play.craft}`)
  log_info('doctor', `idle sleep: ${config.idle_sleep_ms}ms`)
  log_info('doctor', `state dir: ${config.state_dir}`)
  log_info('doctor', 'doctor: OK')
}
