// bun run src/cli/cli_dungeon_run.ts
//
// One-shot: assign/confirm today's mastery daily quest, and — if the party already holds enough
// keys for the assigned dungeon — clear it room by room. See dungeon/dungeon_session.ts for the
// full flow and its current scope (no automatic key crafting yet).
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { run_daily_dungeon_quest } from '../dungeon/dungeon_session.ts'

const main = async () => {
  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  const outcome = await run_daily_dungeon_quest(bot)
  console.log(`\noutcome: ${JSON.stringify(outcome)}`)
}

await main()
