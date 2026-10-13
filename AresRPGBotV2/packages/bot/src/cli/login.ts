// login CLI – initiates zkLogin flow
import { log_info } from '../shared/logger.ts'

export const login = (): void => {
  log_info('login', 'initiating zkLogin flow...')
  log_info('login', 'please complete the interactive login in your browser')
  log_info('login', 'run `bot status` to check connection after login')
}