// bun run src/cli_auto_sell.ts [--reconcile] [--live]
//
// Default (no flags): read-only. Reconciles past listing outcomes against live kiosk state,
// then prints what the auto-seller WOULD list right now and at what price — nothing is signed
// or submitted. Pass --live to actually list those items on the HDV. Applies the same keep
// policy as the roamer's auto_sell_spare_loot (equipment, today's dungeon-key materials and
// craft-recipe ingredients stay in the kiosk); the control panel review is the only view that
// still shows kept items, for a deliberate human override.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { execute_auto_sell, reconcile_market_history, plan_spare_loot } from '../market/auto_sell.ts'

const main = async () => {
  const live = new Set(process.argv.slice(2)).has('--live')

  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  console.log(`address ${bot.address} — network ${bot.sdk.network}`)

  console.log('\nreconciling past listings…')
  await reconcile_market_history(bot)

  const { sellable, held_materials, quest_reserved } = await plan_spare_loot(bot)
  if (quest_reserved.size > 0) {
    console.log(`holding back ${[...quest_reserved].join(', ')} for today's dungeon quest`)
  }
  if (held_materials.length > 0) {
    const names = held_materials
      .slice(0, 8)
      .map((d) => d.name)
      .join(', ')
    console.log(
      `holding back ${held_materials.length} craft material(s) (used by craft recipes) — ` +
        `${names}${held_materials.length > 8 ? ` and ${held_materials.length - 8} more` : ''}`
    )
  }
  if (sellable.length === 0) {
    console.log('\nnothing to sell — no unlisted spare items in kiosk (or everything sellable is already listed).')
    return
  }

  console.log(`\n${live ? 'listing' : 'would list'} ${sellable.length} item(s):`)
  for (const decision of sellable) {
    const flag = decision.estimated_price ? ' (estimated price — no override in item_prices.json)' : ''
    console.log(`  ${decision.name} [${decision.item_type}] — ${decision.price_sui} SUI${flag}`)
  }

  if (!live) {
    console.log('\ndry run — pass --live to actually list these on the HDV.')
    return
  }

  const results = await execute_auto_sell(bot, sellable)
  console.log(`\nlisted ${results.length} item(s):`)
  for (const { decision, digest } of results) console.log(`  ${decision.name} — ${decision.price_sui} SUI — ${digest}`)
}

await main()
