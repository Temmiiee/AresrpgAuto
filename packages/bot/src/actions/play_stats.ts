// Play telemetry for the periodic Discord digest. Pure folds over outcomes the play loop already
// produces, so a summary costs no extra chain reads: one value in, one value out. The session owns
// the current value and replaces it with each fold's result (no shared mutation).
import type { ResolutionReport } from './combat.ts'

/** item_type → counted amount (actual drops, harvested nodes, craft successes). */
export type Tally = Readonly<Record<string, number>>

export type PlayStats = Readonly<{
  fights: number
  won: number
  lost: number
  draw: number
  loot: Tally
  gathered: Tally
  crafted: Tally
}>

export const empty_stats: PlayStats = Object.freeze({
  fights: 0,
  won: 0,
  lost: 0,
  draw: 0,
  loot: Object.freeze({}),
  gathered: Object.freeze({}),
  crafted: Object.freeze({}),
})

const bump = (tally: Tally, key: string, amount: number): Tally =>
  Object.freeze({ ...tally, [key]: (tally[key] ?? 0) + amount })

const fold_items = (tally: Tally, rows: readonly Readonly<{ item_type: string; qty: number }>[]): Tally =>
  rows.reduce((acc, { item_type, qty }) => bump(acc, item_type, qty), tally)

/** Fold one settled fight: its verdict and the loot it actually credited. */
export const record_fight = (stats: PlayStats, report: ResolutionReport): PlayStats =>
  Object.freeze({
    ...stats,
    fights: stats.fights + 1,
    won: stats.won + (report.outcome === 'won' ? 1 : 0),
    lost: stats.lost + (report.outcome === 'lost' ? 1 : 0),
    draw: stats.draw + (report.outcome === 'draw' ? 1 : 0),
    loot: fold_items(stats.loot, report.loot),
  })

export const record_gather = (stats: PlayStats, item_type: string, quantity: number): PlayStats =>
  Object.freeze({ ...stats, gathered: bump(stats.gathered, item_type, quantity) })

export const record_craft = (stats: PlayStats, output_type: string, successes: number): PlayStats =>
  Object.freeze({ ...stats, crafted: bump(stats.crafted, output_type, successes) })

const render_tally = (tally: Tally): string => {
  const rows = Object.entries(tally).sort(([left], [right]) => left.localeCompare(right))
  return rows.length > 0 ? rows.map(([item_type, amount]) => `${amount}× ${item_type}`).join(', ') : 'none'
}

const render_jobs = (job_xp: Readonly<Record<string, bigint>>): string => {
  const rows = Object.entries(job_xp).filter(([, xp]) => xp > 0n)
  return rows.length > 0 ? rows.map(([job, xp]) => `${job} +${xp}`).join(', ') : 'none'
}

/** The periodic digest body: one window of fights, xp, loot, gathering and crafting. */
export const format_summary = (
  stats: PlayStats,
  xp_gained: bigint,
  job_xp: Readonly<Record<string, bigint>>
): string =>
  [
    `${stats.fights} fights · ${stats.won}W ${stats.lost}L ${stats.draw}D`,
    `+${xp_gained} xp · job xp: ${render_jobs(job_xp)}`,
    `loot: ${render_tally(stats.loot)}`,
    `gathered: ${render_tally(stats.gathered)}`,
    `crafted: ${render_tally(stats.crafted)}`,
  ].join('\n')
