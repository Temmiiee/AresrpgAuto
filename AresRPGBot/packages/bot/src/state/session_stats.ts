// Pure summary computation over the session log — shared by cli_session_stats.ts (terminal)
// and cli_dashboard.ts (the browser view), so the two never disagree.
import type { FightLogEntry } from './session_log.ts'
import { value_drops } from '../market/item_valuation.ts'
import { CHARACTERS } from '../config/party_config.ts'

// The dev's ~0.02 SUI guidance is PER CHARACTER, not per fight — a group fight charges every
// owned participant's turns, so a 4-character party's normal fight totals ~0.08 SUI, not 0.02.
// Flag at 5x that per-party baseline instead of a flat number, so the threshold scales with
// whatever party_config.ts's roster actually is instead of silently firing on ~every fight for
// parties bigger than one character (as a flat 0.1 SUI did for the committed 4-character party).
export const PER_CHARACTER_GAS_BASELINE_MIST = 20_000_000n // ~0.02 SUI
const GAS_WARN_MULTIPLIER = 5n
export const GAS_WARN_MIST = PER_CHARACTER_GAS_BASELINE_MIST * BigInt(CHARACTERS.length) * GAS_WARN_MULTIPLIER

export type SessionStats = {
  fights: FightLogEntry[]
  errors: FightLogEntry[]
  wins: FightLogEntry[]
  losses: FightLogEntry[]
  win_rate: number | null // 0..1, null if no completed fights yet
  total_gas_mist: bigint
  avg_gas_mist: bigint
  expensive: FightLogEntry[] // fights at/above GAS_WARN_MIST
  xp_totals: Record<string, number>
  drops_totals: Record<string, number>
  total_drops_value_sui: number
  net_profit_sui: number
  is_net_profitable: boolean
}

export const compute_stats = (entries: readonly FightLogEntry[]): SessionStats => {
  const fights = entries.filter((e) => e.error === null)
  const errors = entries.filter((e) => e.error !== null)
  const wins = fights.filter((e) => e.won === true)
  const losses = fights.filter((e) => e.won === false)

  const total_gas_mist = fights.reduce((sum, e) => sum + BigInt(e.gas_mist), 0n)
  const avg_gas_mist = fights.length > 0 ? total_gas_mist / BigInt(fights.length) : 0n
  const expensive = fights.filter((e) => BigInt(e.gas_mist) >= GAS_WARN_MIST)

  const xp_totals: Record<string, number> = {}
  for (const fight of fights)
    for (const [name, xp] of Object.entries(fight.xp_gained)) xp_totals[name] = (xp_totals[name] ?? 0) + xp

  const drops_totals: Record<string, number> = {}
  for (const fight of fights) {
    if (fight.drops) {
      for (const [item, qty] of Object.entries(fight.drops)) {
        drops_totals[item] = (drops_totals[item] ?? 0) + qty
      }
    }
  }

  const valuation = value_drops(drops_totals)
  const total_gas_sui = Number(total_gas_mist) / 1e9
  const total_drops_value_sui = valuation.total_sui
  const net_profit_sui = Number((total_drops_value_sui - total_gas_sui).toFixed(4))
  const is_net_profitable = net_profit_sui >= 0

  return {
    fights,
    errors,
    wins,
    losses,
    win_rate: fights.length > 0 ? wins.length / fights.length : null,
    total_gas_mist,
    avg_gas_mist,
    expensive,
    xp_totals,
    drops_totals,
    total_drops_value_sui,
    net_profit_sui,
    is_net_profitable,
  }
}

export const mist_to_sui = (mist: bigint): string => (Number(mist) / 1e9).toFixed(4)
