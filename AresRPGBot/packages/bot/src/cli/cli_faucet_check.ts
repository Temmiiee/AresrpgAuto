// bun run src/cli_faucet_check.ts
//
// One-shot: log in, check the bot wallet's live SUI balance, claim from the official testnet
// faucet if it's below the threshold. Safe to run standalone (cron, a scheduled task) between
// `session` runs, or just by hand whenever you suspect the wallet is running low.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { ensure_min_balance, mist_to_sui_string } from '../market/faucet.ts'

const main = async () => {
  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  const { balance_mist, claim } = await ensure_min_balance(bot.sdk.read_sui_balance, bot.address)

  console.log(`address ${bot.address} — balance ${mist_to_sui_string(balance_mist)} SUI`)
  if (claim === null) {
    console.log('above threshold — no claim needed')
  } else if (claim.claimed) {
    console.log(`claimed from faucet (${claim.coins_sent} coin(s) sent)`)
  } else {
    console.log(`claim failed: ${claim.reason} — ${claim.detail}`)
  }
}

await main()
