// The bot's single daily session loop: farm spare loot (one group fight per account), craft any
// dungeon keys the party is short of, withdraw every still-open HDV listing this bot created for
// an item type reserved for today's dungeon quest (without buying it back and without re-listing
// it), then run today's daily dungeon quest. Exactly one loop runs at a time -- the fight and
// dungeon SDK sessions are NOT safe under two concurrent loops (kiosk EItemLocked / listing
// race, documented in auto_sell.ts) -- so this is the single entry point the cron calls once a
// day for a single bot account. Bounded: withdrawals only ever delist (never buy, never re-list)
// and only ever for item types the very same reserved set used by auto_sell.ts.
import type { BotSdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { run_one_group_fight } from '../fight/fight_session.ts'
import { run_daily_dungeon_quest } from '../dungeon/dungeon_session.ts'
import { craft_keys_if_possible, owned_key_stack } from '../dungeon/dungeon_keys.ts'
import { read_mastery_row } from '../dungeon/mastery_quest.ts'
import { resolve_leftover_fights } from '../fight/fight_recovery.ts'
import { withdraw_reserved_from_hdv } from '../market/withdraw_reserved_from_hdv.ts'
import { dungeon_by_slug, type DungeonInfo } from '../shared/dungeon_content.ts'
import { resolve_quest_dungeon_slug } from '../shared/dungeon_read.ts'
import { read_position } from '../state/position_state.ts'

export type DailyLoopStats = Readonly<{
  fights_fought: number
  keys_crafted_if_any: number
  listings_withdrawn: number
  dungeon_run: boolean
  dungeon_cleared: boolean
}>

/** Today's quest dungeon, resolved read-only (no quest assignment — assignment happens inside the
 *  dungeon run itself). null when there is nothing to craft keys for. */
const quest_dungeon_info = async (bot: BotSdk): Promise<DungeonInfo | null> => {
  const row = await read_mastery_row(bot, bot.mastery.id)
  if (!row || row.quest_completed) return null
  const slug = resolve_quest_dungeon_slug(bot.sdk, row.quest_dungeon)
  return slug ? (dungeon_by_slug(slug) ?? null) : null
}

/** Runs one full daily session for a single bot account: group fight (spare loot farm) -> keys
 *  crafted if the party doesn't hold enough for today's dungeon -> HDV listings reserved for
 *  today's quest withdrawn -> daily dungeon quest. Throws only if dungeon quest itself fails; the
 *  farm/craft/withdraw steps are best-effort and never abort the day. */
export const run_daily_session = async (
  bot: BotSdk,
  log: (msg: string) => void = console.log
): Promise<DailyLoopStats> => {
  let fights_fought = 0
  let keys_crafted_if_any = 0
  let listings_withdrawn = 0

  // An unsettled Fight keeps every party character inside the Fight object; with the party stuck
  // there, the dungeon quest's borrow aborts EItemNotFound and key/HFV crafts under-borrow too.
  // Resolve any leftover first (same recovery roam/job-farm/dungeon-run use), best-effort: the
  // group fight below re-resolves it anyway if it's still bound to the party.
  try {
    const leftover = await resolve_leftover_fights(bot, log)
    if (leftover.kind === 'settled') log('daily: leftover fight resolved before the day session')
  } catch (err) {
    log(`daily: leftover-fight recovery skipped — ${(err as Error).message}`)
  }

  try {
    await run_one_group_fight(bot, read_position(), log)
    fights_fought += 1
  } catch (err) {
    log(`daily: group fight skipped — ${(err as Error).message}`)
  }

  try {
    const info = await quest_dungeon_info(bot)
    if (info) {
      const have = (await owned_key_stack(bot, info.key))?.amount ?? 0
      if (have < CHARACTERS.length) {
        keys_crafted_if_any = await craft_keys_if_possible(bot, info, CHARACTERS.length - have, log)
        if (keys_crafted_if_any > 0) log(`daily: crafted ${keys_crafted_if_any} dungeon key(s)`)
      }
    }
  } catch (err) {
    log(`daily: key crafting skipped — ${(err as Error).message}`)
  }

  try {
    listings_withdrawn = await withdraw_reserved_from_hdv(bot, log)
    if (listings_withdrawn > 0)
      log(`daily: withdrew ${listings_withdrawn} HDV listing(s) reserved for today's quest`)
  } catch (err) {
    log(`daily: HDV withdrawal skipped — ${(err as Error).message}`)
  }

  const outcome = await run_daily_dungeon_quest(bot, log)
  return {
    fights_fought,
    keys_crafted_if_any,
    listings_withdrawn,
    dungeon_run: true,
    dungeon_cleared: outcome.kind === 'run' && outcome.cleared,
  }
}