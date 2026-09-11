// Settles a dungeon room fight for the whole party in one batched transaction — mirrors
// fight/fight_settle.ts's settle_all (same loot-authentication reasoning, fight_loot.ts), but
// through dungeon.move's settle door so the character's DungeonRun advances (won, more rooms
// left), ends (won the last room), or ends (lost) automatically — see dungeon_session.ts for the
// loop that reacts to which of those happened.
//
// KNOWN GAP, same root cause as fight_settle.ts's (see README's "CI" section and that file's own
// header): the dungeon.settle() SDK wrapper doesn't return drops_rolled at all (that patch was
// only ever applied to fight.ts's settle, not dungeon.ts's) — so dungeon room loot isn't logged
// here. The loot itself is still correctly awarded on-chain; only this bot's own visibility into
// exactly what dropped is missing for dungeon rooms specifically.
import type { BotSdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { message_of, submit_with_retry } from '../shared/chain_retry.ts'
import { fighter_indices, read_fight } from '../fight/fight_state.ts'
import { possible_loot_item_types, record_fight_loot_rarity } from '../fight/fight_loot.ts'
import type { DungeonInfo } from '../shared/dungeon_content.ts'

export const settle_dungeon_room = async (
  bot: BotSdk,
  info: DungeonInfo,
  fight_id: string,
  mastery: Readonly<{ id: string; fighter_idx: bigint }> | null,
  log: (msg: string) => void
): Promise<void> => {
  const { sdk, dungeon, kiosk_cap } = bot

  const state_json = await read_fight(sdk, fight_id).catch((error: unknown) => {
    log(`dungeon settle: couldn't re-read fight state (${message_of(error)}) — treating as already concluded`)
    return null
  })
  if (!state_json) return
  record_fight_loot_rarity(state_json)

  const indices = fighter_indices(state_json)
  const unsettled = CHARACTERS.filter((c) => {
    const idx = indices.get(c.id)
    return idx !== undefined && !state_json.fighters[idx]!.settled
  })
  if (unsettled.length === 0) return

  log(`settling dungeon room for ${unsettled.map((c) => c.name).join(', ')} (one transaction)…`)
  const loot = [...possible_loot_item_types(state_json)].map((item_type) => ({ item_type, existing: null }))
  const settlements = unsettled.map((c) => ({ fighter_idx: BigInt(indices.get(c.id)!), loot }))
  const cap = await kiosk_cap()
  if (!cap) throw new Error('No personal kiosk found for this account')

  await submit_with_retry(
    () =>
      dungeon.settle({
        fight: fight_id,
        dungeon: info.dungeon,
        settlements,
        custody: { kiosk: cap.kioskId, kiosk_cap: cap.objectId },
        mastery,
        last: true,
      }),
    log
  )
}
