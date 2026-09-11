// Discord webhook notifications for critical bot events

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
const MENTION = process.env.DISCORD_MENTION || ''

export const send_discord_alert = async (message: string, mention: boolean = false): Promise<void> => {
  if (!WEBHOOK_URL) {
    console.log('[Discord] Webhook not configured, skipping notification')
    return
  }
  
  const content = mention && MENTION ? `${MENTION} ${message}` : message
  
  console.log(`[Discord] Sending notification to webhook...`)
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    
    if (!response.ok) {
      const error = await response.text()
      console.error(`[Discord] Webhook failed (${response.status}): ${error}`)
    } else {
      console.log(`[Discord] ✅ Notification sent successfully`)
    }
  } catch (error) {
    console.error(`[Discord] Webhook error: ${error}`)
  }
}

export const notify_session_expired = async (address: string, login_url?: string): Promise<void> => {
  let message = `🔴 **Session Expired!**\n\n` +
    `ZKLogin session expired for \`${address}\`\n\n`
  
  if (login_url) {
    message += `**Click here to re-authenticate:**\n${login_url}\n\n` +
      `Sign in with the SAME Google account you use for aresrpg.world.\n\n` +
      `The bot will automatically continue once you log in.`
  } else {
    message += `**Action Required:** Run \`bun run enoki-login\` to re-authenticate.\n\n` +
      `The bot will retry automatically, but it needs a fresh login to continue.`
  }
  
  await send_discord_alert(message, true)
}

export const notify_critical_error = async (error: string, address: string): Promise<void> => {
  const message = `⚠️ **Critical Bot Error**\n\n` +
    `Address: \`${address}\`\n` +
    `Error: \`${error}\``
  
  await send_discord_alert(message, true)
}

export const notify_session_start = async (address: string, max_fights: number | string): Promise<void> => {
  const message = `✅ **Bot Session Started**\n\n` +
    `Address: \`${address}\`\n` +
    `Max fights: ${max_fights}`
  
  await send_discord_alert(message, false)
}
