// Discord webhook reporting. Fire-and-forget by design: a notification failure must never abort
// a farming run. A configured mention is prepended so the operator's phone actually buzzes.
import { config } from '../config.ts'
import { log_info, log_warn } from './logger.ts'

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error'

const COLOR: Record<NotifyLevel, number> = {
  info: 0x58a6ff,
  success: 0x3fb950,
  warning: 0xd29922,
  error: 0xf85149,
}

const send = async (content: string, level: NotifyLevel): Promise<void> => {
  const webhook = config.discord_webhook_url
  if (!webhook) {
    log_warn('discord', 'no webhook URL configured, skipping notification')
    return
  }
  const mention = config.discord_mention
  // ONE visible block per notification. Posting the same text in BOTH `content` and an embed made
  // every message render twice (the plain body and the coloured card), which the operator read as
  // duplicate notifications. The embed carries the message; `content` carries only the ping.
  const body = {
    username: 'AresRPG Bot',
    // Omit `content` entirely when there is no ping: an empty string is accepted by Discord today,
    // but omitting it is the unambiguous "embed only" payload.
    ...(mention ? { content: mention } : {}),
    embeds: [{ description: content, color: COLOR[level] }],
  }
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) log_warn('discord', `webhook answered ${response.status}`)
    else log_info('discord', `notification sent successfully`)
  } catch (error) {
    log_warn('discord', `notification failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const notify = (content: string, level: NotifyLevel = 'info'): void => {
  void send(content, level)
}

export const notify_await = (content: string, level: NotifyLevel = 'info'): Promise<void> => send(content, level)
