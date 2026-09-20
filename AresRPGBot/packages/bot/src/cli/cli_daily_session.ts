// bun run src/cli/cli_daily_session.ts
//
// The mastery-quest automation's daily session: farm one group fight for spare loot, craft any
// dungeon keys the party is short of, withdraw HDV listings reserved for today's quest, then run
// today's daily dungeon quest (assign/confirm it -> resolve which dungeon -> craft the keys ->
// clear every room). Exactly one loop runs at a time per account — the fight and dungeon SDK
// sessions are NOT safe under two concurrent loops (kiosk EItemLocked / listing race) — so this
// is the single entrypoint a cron would call once per epoch.
//
// The farm/craft/withdraw steps are best-effort; only the dungeon quest itself can throw.
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { run_daily_session } from '../daily/daily_session.ts'

const main = async () => {
  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  const log = (msg: string): void => console.log(`  ${msg}`)
  const stats = await run_daily_session(bot, log)
  console.log(
    `\ndaily session done — fights: ${stats.fights_fought}, keys crafted: ${stats.keys_crafted_if_any}, ` +
      `listings withdrawn: ${stats.listings_withdrawn}, dungeon cleared: ${stats.dungeon_cleared}`
  )
}

await main()