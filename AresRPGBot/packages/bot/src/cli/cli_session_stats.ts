// bun run src/cli_session_stats.ts — summarizes session.jsonl. Safe to run at any time,
// including while a session is running in another terminal (it only reads the log).
import { read_log } from '../state/session_log.ts'
import { compute_stats, mist_to_sui, GAS_WARN_MIST } from '../state/session_stats.ts'

const main = () => {
  const entries = read_log()
  if (entries.length === 0) {
    console.log('No fights logged yet — run `bun run session` first.')
    return
  }

  const stats = compute_stats(entries)

  console.log(
    `fights completed : ${stats.fights.length} (${stats.wins.length} won, ${stats.losses.length} lost, ${stats.errors.length} errored)`
  )
  if (stats.win_rate !== null) console.log(`win rate          : ${(stats.win_rate * 100).toFixed(0)}%`)
  console.log(`total gas spent  : ${mist_to_sui(stats.total_gas_mist)} SUI`)
  console.log(`average per fight: ${mist_to_sui(stats.avg_gas_mist)} SUI`)
  console.log(
    `xp gained        : ${Object.entries(stats.xp_totals)
      .map(([name, xp]) => `${name}+${xp}`)
      .join(' ')}`
  )

  const drops_summary =
    Object.entries(stats.drops_totals)
      .map(([item, qty]) => `${item} x${qty}`)
      .join(', ') || 'none'
  console.log(`items dropped    : ${drops_summary}`)
  console.log(`est. loot value  : ${stats.total_drops_value_sui.toFixed(4)} SUI`)
  console.log(
    `net farming profit: ${stats.net_profit_sui >= 0 ? '+' : ''}${stats.net_profit_sui.toFixed(4)} SUI (${stats.is_net_profitable ? 'PROFITABLE' : 'NET LOSS'})`
  )

  if (stats.expensive.length > 0) {
    console.log(
      `\n⚠ ${stats.expensive.length} fight(s) cost ${mist_to_sui(GAS_WARN_MIST)}+ SUI — worth reporting to the dev:`
    )
    for (const fight of stats.expensive)
      console.log(`  ${fight.at}  ${fight.fight_id}  ${mist_to_sui(BigInt(fight.gas_mist))} SUI`)
  }
  if (stats.errors.length > 0) {
    console.log(`\nlast ${Math.min(5, stats.errors.length)} error(s):`)
    for (const error of stats.errors.slice(-5)) console.log(`  ${error.at}  ${error.error}`)
  }
}

main()
