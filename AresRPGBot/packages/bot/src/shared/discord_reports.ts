import { calculate_farming_profit, value_drops } from '../market/item_valuation.ts'
import { rarity_chance_bp, rarity_tier } from '../market/item_rarity.ts'
import { mist_to_sui } from '../state/session_stats.ts'
import type { FightLogEntry } from '../state/session_log.ts'

import { send_discord_embed } from './discord_notify.ts'
import type { DiscordEmbed } from './discord_notify.ts'

const RARE_COLOR = 0xf1c40f
const EPIC_COLOR = 0x9b59b6
const PROFIT_COLOR = 0x2ecc71
const LOSS_COLOR = 0xe74c3c

/** Sends one embed alerting that a fight's drops contained a rare/epic item (rarity registry in
 *  market/item_rarity.ts, fed live from every mob loot table fought). No-op when nothing rare
 *  dropped or the webhook isn't configured. */
export const notify_rare_loot = async (
  drops: Readonly<Record<string, number>>,
  fight_id: string
): Promise<void> => {
  const lines: string[] = []
  for (const [item, qty] of Object.entries(drops)) {
    if (qty <= 0) continue
    const tier = rarity_tier(item)
    if (tier !== 'rare' && tier !== 'epic') continue
    const chance_bp = rarity_chance_bp(item)
    const chance_str = chance_bp === null ? '' : ` — ~${(chance_bp / 100).toFixed(2)}% roll`
    lines.push(`${qty} × ${item} (${tier}${chance_str})`)
  }
  if (lines.length === 0) return

  const has_epic = lines.some((line) => line.includes('epic'))
  await send_discord_embed(
    {
      title: '✨ Rare loot!',
      description: `Fight \`${fight_id}\` dropped:\n${lines.join('\n')}`,
      color: has_epic ? EPIC_COLOR : RARE_COLOR,
    },
    true
  )
}

const completed_fights = (entries: readonly FightLogEntry[]): FightLogEntry[] =>
  entries.filter((e) => e.won !== null && e.error === null)

const xp_by_character = (entries: readonly FightLogEntry[]): Record<string, number> => {
  const totals: Record<string, number> = {}
  for (const fight of entries) {
    for (const [name, xp] of Object.entries(fight.xp_gained)) totals[name] = (totals[name] ?? 0) + xp
  }
  return totals
}

const drops_by_type = (entries: readonly FightLogEntry[]): Record<string, number> => {
  const totals: Record<string, number> = {}
  for (const fight of entries) {
    if (!fight.drops) continue
    for (const [item, qty] of Object.entries(fight.drops)) totals[item] = (totals[item] ?? 0) + qty
  }
  return totals
}

/** Sends one compact summary embed for a batch of completed fights (gas spent, XP gained, loot
 *  value, net profit). Aggregates whatever entries are passed — the session loop normally passes
 *  a rolling window of the last N finished fights. */
export const notify_fight_summary = async (
  entries: readonly FightLogEntry[],
  label: string
): Promise<void> => {
  const completed = completed_fights(entries)
  if (completed.length === 0) return

  const wins = completed.filter((e) => e.won === true).length
  const gas_mist = completed.reduce((sum, e) => sum + BigInt(e.gas_mist), 0n)
  const gas_sui = mist_to_sui(gas_mist)
  const xp_totals = xp_by_character(completed)
  const total_xp = Object.values(xp_totals).reduce((sum, xp) => sum + xp, 0)

  const drops_value_sui = value_drops(drops_by_type(completed)).total_sui
  const gas_sui_num = Number(gas_mist) / 1e9
  const profit = calculate_farming_profit(drops_value_sui, gas_sui_num)

  const xp_line =
    Object.entries(xp_totals).length > 0
      ? Object.entries(xp_totals).map(([name, xp]) => `${name} **+${xp}**`).join(', ')
      : '—'

  await send_discord_embed(
    {
      title: `📊 ${label} — ${total_xp} XP`,
      color: profit.net_profit_sui >= 0 ? PROFIT_COLOR : LOSS_COLOR,
      fields: [
        { name: '⚔️ Fights', value: `${completed.length} (${wins}W / ${completed.length - wins}L)`, inline: true },
        { name: '⛽ Gas', value: `${gas_sui} SUI`, inline: true },
        { name: '✨ XP gained', value: xp_line, inline: false },
        { name: '💰 Loot value', value: `~${drops_value_sui.toFixed(4)} SUI`, inline: true },
        {
          name: '📈 Net',
          value: `${profit.net_profit_sui >= 0 ? '+' : ''}${profit.net_profit_sui.toFixed(4)} SUI`,
          inline: true,
        },
      ],
    },
    false
  )
}

export type ExpeditionSummary = Readonly<{
  expedition: number
  position: string
  battles: number
  wins: number
  losses: number
  gathers: number
  crafts_succeeded: number
  crafts_blocked: number
  crafts_failed: number
  supply_fights: number
  discovery: string | null
  relocated: boolean
  backed_off: boolean
}>

/** Sends one embed recapping EVERYTHING one roam expedition did (not just battles) — a
 *  Discord-visible answer to "did the session only fight?": number of battles W/L, harvest
 *  gathers, craft passes that produced / were blocked / failed, and whether the party relocated,
 *  backed off, or claimed a first-discovery zone. No-op when the webhook isn't configured. */
export const notify_expedition_summary = async (summary: ExpeditionSummary): Promise<void> => {
  const position = `(${summary.position})`
  const moves: string[] = []
  if (summary.relocated) moves.push('relocated outward')
  if (summary.backed_off) moves.push('backed off inward')
  if (summary.discovery) moves.push(`discovered ${summary.discovery}`)
  if (summary.supply_fights > 0) moves.push(`supply run: ${summary.supply_fights} fight(s) for craft mats`)

  await send_discord_embed({
    title: `🧭 Expedition ${summary.expedition} — @ ${position}`,
    color: 0x3498db,
    fields: [
      { name: '⚔️ Battles', value: `${summary.battles} (${summary.wins}W / ${summary.losses}L)`, inline: true },
      { name: '🌾 Harvest', value: `${summary.gathers} gather(s)`, inline: true },
      { name: '🔨 Crafts', value: `${summary.crafts_succeeded} ok / ${summary.crafts_blocked} blocked / ${summary.crafts_failed} failed`, inline: true },
      { name: '🧭 Movement', value: moves.length > 0 ? moves.join(' · ') : 'stayed in place', inline: false },
    ],
  })
}