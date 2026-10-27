// status CLI – shows bot connection status
import { log_info } from '../shared/logger.ts'

export const status = (): void => {
  log_info('status', 'bot status check')
  log_info('status', 'bot is running')
  // In a full implementation, would check actual connection status
  log_info('status', 'available toggles: gather, fight, craft')
}