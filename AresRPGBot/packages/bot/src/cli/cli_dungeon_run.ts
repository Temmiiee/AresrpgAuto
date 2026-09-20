// bun run src/cli/cli_dungeon_run.ts [--auto|--solo|--party]
//
// One-shot: assign/confirm today's mastery daily quest, and — if the party already holds enough
// keys for the assigned dungeon — clear it room by room. See dungeon/dungeon_session.ts for the
// full flow and its current scope (no automatic key crafting yet).
//
// The mode flag picks who enters (defaults to --auto):
//   --auto   solo whenever the dungeon's mobs sit comfortably under the party's level, else all 4
//   --solo   force a single (strongest) character — only 1 key needed
//   --party  force the whole 4-character party
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { run_daily_dungeon_quest } from '../dungeon/dungeon_session.ts'
import { resolve_leftover_fights } from '../fight/fight_recovery.ts'

const main = async () => {
  const mode = process.argv.includes('--solo') ? 'solo' : process.argv.includes('--party') ? 'party' : 'auto'
  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)
  const log = (msg: string) => console.log(msg)
  const leftover = await resolve_leftover_fights(bot, log)
  if (leftover.kind === 'in_progress') {
    console.log(`party is still inside a fight that recovery couldn't resolve — run the group fight / roam CLI first, then retry the dungeon.`)
    process.exit(1)
  }
  const outcome = await run_daily_dungeon_quest(bot, log, { mode })
  console.log(`\noutcome: ${JSON.stringify(outcome)}`)
}

await main()
