// The address-wide daily quest: assign (or resume) today's target, and read its current state
// without re-triggering assignment. mastery.move's assign() aborts with EQuestAlreadyStarted
// (3103) the moment it's called twice in the same chain epoch -- a real, EXPECTED outcome once
// this bot has already started today's quest, not a failure. `mastery.start()`'s SDK wrapper has
// no read-only counterpart, so the fallback path here reads the Mastery object's own fields
// directly (a plain owned object, not a dynamic field -- simpler than dungeon_read.ts's DF read).
import type { MasteryRow } from '@aresrpg/protocol'

import type { BotSdk } from '../auth/sdk_client.ts'
import { message_of } from '../shared/chain_retry.ts'
import { WORLD, LEADER } from '../config/party_config.ts'

const EQUEST_ALREADY_STARTED = 3103

const as_optional_u64 = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** Reads the Mastery object's own fields directly -- null if it doesn't exist yet (this
 *  account has never started a daily quest at all). */
export const read_mastery_row = async (bot: BotSdk, mastery_id: string): Promise<MasteryRow | null> => {
  const { objects } = await bot.sdk.sui_client.core.getObjects({ objectIds: [mastery_id], include: { json: true } })
  const json = objects[0]?.json as Record<string, unknown> | undefined
  if (!json || typeof json.owner !== 'string') return null
  return Object.freeze({
    id: mastery_id,
    owner: String(json.owner),
    points: String(json.points ?? '0'),
    last_completed_epoch: as_optional_u64(json.last_completed_epoch),
    quest_epoch: String(json.quest_epoch ?? '0'),
    quest_started_ms: String(json.quest_started_ms ?? '0'),
    quest_world: String(json.quest_world ?? ''),
    quest_dungeon: String(json.quest_dungeon ?? ''),
    quest_reward: Number(json.quest_reward ?? 0),
    quest_completed: Boolean(json.quest_completed),
  })
}

/** Starts today's quest if none is assigned yet this epoch, or just reads the already-assigned
 *  one otherwise -- either way, returns the current row. Throws only on a real, unexpected
 *  failure (not the ordinary "already started today" case). */
export const ensure_daily_quest = async (bot: BotSdk, log: (msg: string) => void): Promise<MasteryRow> => {
  try {
    const { mastery } = await bot.mastery.start({ world: WORLD, character_id: LEADER.id })
    log(`daily quest assigned/confirmed: ${mastery.quest_world} dungeon (reward ${mastery.quest_reward} point(s))`)
    return mastery
  } catch (error) {
    if (!new RegExp(`abort code:\\s*${EQUEST_ALREADY_STARTED}\\b`).test(message_of(error))) throw error
    const existing = await read_mastery_row(bot, bot.mastery.id)
    if (!existing) throw new Error(`mastery.start reported "already started" but ${bot.mastery.id} isn't readable`)
    log(`daily quest already assigned this epoch (completed=${existing.quest_completed})`)
    return existing
  }
}
