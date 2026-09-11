// bun run src/cli_group_fight_loop.ts — REAL characters, real progression (still Testnet fake
// SUI). Runs exactly ONE group fight (search, engage, join, ready, fight, settle) via
// src/fight_session.ts, then prints the outcome. Position chains automatically across separate
// runs via position.local.json — see src/cli_group_session.ts for the looping version.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { run_one_group_fight } from '../fight/fight_session.ts'
import { read_position, write_position } from '../state/position_state.ts'
import { GAS_WARN_MIST, mist_to_sui } from '../state/session_stats.ts'
import { CHARACTERS } from '../config/party_config.ts'

const main = async () => {
  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  const position = read_position()

  const outcome = await run_one_group_fight(bot, position)
  write_position(outcome.new_position)

  const gas_sui = Number(outcome.gas_mist) / 1e9
  console.log(
    `\n${outcome.won ? 'WON' : 'LOST'} — ${outcome.turns} turns, ${gas_sui.toFixed(4)} SUI gas, xp: ${Object.entries(
      outcome.xp_gained
    )
      .map(([name, xp]) => `${name}+${xp}`)
      .join(' ')}`
  )
  if (outcome.gas_mist >= GAS_WARN_MIST) {
    console.log(
      `\n⚠ this fight cost ${gas_sui.toFixed(4)} SUI — well above the ~${mist_to_sui(GAS_WARN_MIST)} SUI expected for ` +
        `this ${CHARACTERS.length}-character party (the dev's ~0.02 SUI/character baseline). ` +
        `Consider reporting fight ${outcome.fight_id} and address ${bot.address} to the dev for debugging.`
    )
  }
}

await main()
