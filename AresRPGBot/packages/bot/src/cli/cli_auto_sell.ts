// bun run src/cli_auto_sell.ts [--reconcile] [--live]
//
// Default (no flags): read-only. Reconciles past listing outcomes against live kiosk state,
// then prints what the auto-seller WOULD list right now and at what price — nothing is signed
// or submitted. Pass --live to actually list those items on the HDV. Meant to be run by hand or
// from a scheduler; it does not loop or wire into `session` — selling is a deliberate, reviewed
// action, not something a fight loop should trigger on its own.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { plan_auto_sell, execute_auto_sell, reconcile_market_history } from '../market/auto_sell.ts'

const main = async () => {
  const live = new Set(process.argv.slice(2)).has('--live')

  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  console.log(`address ${bot.address} — network ${bot.sdk.network}`)

  console.log('\nreconciling past listings…')
  await reconcile_market_history(bot)

  const decisions = await plan_auto_sell(bot)
  if (decisions.length === 0) {
    console.log('\nnothing to sell — no unlisted spare items in kiosk (or everything sellable is already listed).')
    return
  }

  console.log(`\n${live ? 'listing' : 'would list'} ${decisions.length} item(s):`)
  for (const decision of decisions) {
    const flag = decision.estimated_price ? ' (estimated price — no override in item_prices.json)' : ''
    console.log(`  ${decision.name} [${decision.item_type}] — ${decision.price_sui} SUI${flag}`)
  }

  if (!live) {
    console.log('\ndry run — pass --live to actually list these on the HDV.')
    return
  }

  const results = await execute_auto_sell(bot, decisions)
  console.log(`\nlisted ${results.length} item(s):`)
  for (const { decision, digest } of results) console.log(`  ${decision.name} — ${decision.price_sui} SUI — ${digest}`)
}

await main()
