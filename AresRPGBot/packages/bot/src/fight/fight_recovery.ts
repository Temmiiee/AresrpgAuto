// Cooperative recovery of a party fight a previous process left open — runs BEFORE any
// kiosk-borrowing phase (the daily quest), because an unsettled Fight keeps every party character
// as a dynamic object field of the Fight object (fight.move's FighterKey). With the characters
// inside the Fight, ensure_daily_quest's start_daily_quest aborts 0x2::kiosk::borrow
// EItemNotFound (11) — "character not found in kiosk". A won-and-forgotten fight is exactly what
// flatlined the roam loop 2026-09-16 (the last attack killed the mobs, then the process died
// before the next crank could flip combat.ended, so the party sat in the Fight forever).
//
// Strategy, ordered:
//   1. ended fight  -> settle_all (recovers every unsettled character AND the real rolled loot)
//   2. mid-combat   -> run_one_group_fight resumes it (find_or_create_fight re-reads
//      group-state.local.json and rejoins/readies), finishing + settling in one pass
//   3. object gone  -> stale group-state, clear it and move on
// Any failure degrades to { kind: 'in_progress' } so the caller SKIPS borrow-dependent phases
// this pass (the battle phase resolves the fight on its own) instead of crashing the loop.
import type { BotSdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { message_of, submit_with_retry } from '../shared/chain_retry.ts'
import { read_group_state, write_group_state } from '../state/group_state.ts'
import { read_fight, fighter_indices, FightNotFoundError } from './fight_state.ts'
import { settle_all } from './fight_settle.ts'
import { run_one_group_fight } from './fight_session.ts'

export type LeftoverFightResult =
  | { kind: 'none' }
  | { kind: 'settled'; fight_id: string }
  | { kind: 'in_progress'; fight_id: string }

/** Walks each party character's owner chain up to 2 hops looking for a ::fight::Fight container
 *  (character -> Fight, or character -> wrapper field -> Fight) — the same detection
 *  fight_discovery.ts uses, kept local here to avoid another circular import edge. */
const detect_active_fight_id = async (
  sdk: BotSdk['sdk'],
  log: (msg: string) => void
): Promise<string | null> => {
  const is_fight = (t?: string) => Boolean(t && t.endsWith('::fight::Fight'))
  const owner_id = (object?: { owner?: unknown }): string | null => {
    const owner = (object?.owner as { ObjectOwner?: unknown })?.ObjectOwner
    return typeof owner === 'string' ? owner : null
  }
  const get_with_owner = (objectIds: string[]) =>
    sdk.sui_client.core.getObjects({ objectIds, include: { owner: true, json: true } } as never)
  try {
    for (const c of CHARACTERS) {
      const { objects: r1 } = await get_with_owner([c.id])
      const p1 = owner_id(r1[0])
      if (!p1) continue
      const { objects: r2 } = await get_with_owner([p1])
      if (is_fight(r2[0]?.type)) return p1
      const p2 = owner_id(r2[0])
      if (!p2) continue
      const { objects: r3 } = await sdk.sui_client.core.getObjects({ objectIds: [p2], include: { json: true } })
      if (is_fight(r3[0]?.type)) return p2
    }
    return null
  } catch (error) {
    log(`active-fight detection inconclusive (${message_of(error)}) — assuming none`)
    return null
  }
}

export const resolve_leftover_fights = async (
  bot: BotSdk,
  log: (msg: string) => void = console.log
): Promise<LeftoverFightResult> => {
  let { fight_id } = read_group_state()
  if (!fight_id) fight_id = (await detect_active_fight_id(bot.sdk, log)) ?? undefined
  if (!fight_id) return { kind: 'none' }

  let json
  try {
    json = await read_fight(bot.sdk, fight_id)
  } catch (error) {
    if (error instanceof FightNotFoundError) {
      log(`leftover fight ${fight_id} no longer exists — clearing local state`)
      write_group_state({})
      return { kind: 'none' }
    }
    log(`leftover fight ${fight_id} read failed (${message_of(error)}) — skipping borrow-dependent phases this pass`)
    return { kind: 'in_progress', fight_id }
  }

  const ours = fighter_indices(json)
  if (!CHARACTERS.some((c) => ours.has(c.id))) {
    log(`recorded fight ${fight_id} holds nobody from this party — clearing stale local state`)
    write_group_state({})
    return { kind: 'none' }
  }

  log(`leftover fight ${fight_id} still holds the party (${json.ended ? 'ended, unsettled' : 'mid-combat'}) — ${json.ended ? 'settling' : 'resuming and finishing'} it before the quest phase…`)
  try {
    if (json.ended) {
      await settle_all(bot, fight_id, log)
    } else {
      try {
        await run_one_group_fight(bot, { x: json.x, z: json.z }, log, { can_spend: false })
      } catch (resume_error) {
        // The turn engine couldn't finish it (odd combat boundary, or a fight it can't act on).
        // Forfeiting just the party's open seats atomically removes each character from the
        // Fight (`fight::forfeit` -> dynamic_object::remove -> kiosk.lock, HP resets to 1 in
        // PvM) — costs the fight's XP/loot, but frees the party so every later phase works.
        log(`resume failed (${message_of(resume_error)}) — forfeiting the party's open seats to free them…`)
        const fresh = await read_fight(bot.sdk, fight_id)
        const indices = fighter_indices(fresh)
        const cap = await bot.kiosk_cap()
        if (!cap) throw new Error('No personal kiosk found for this account')
        let forfeited = 0
        for (const c of CHARACTERS) {
          const idx = indices.get(c.id)
          if (idx === undefined || fresh.fighters[idx]!.settled) continue
          log(`${c.name} forfeiting (fighter ${idx})…`)
          await submit_with_retry(
            () =>
              bot.fight.forfeit({
                fight: fight_id,
                fighter_idx: BigInt(idx),
                custody: { kiosk: cap.kioskId, kiosk_cap: cap.objectId },
              }),
            log
          )
          forfeited += 1
        }
        if (forfeited === 0) throw resume_error
      }
    }
    write_group_state({})
    log(`leftover fight ${fight_id} resolved — party back in the kiosk`)
    return { kind: 'settled', fight_id }
  } catch (error) {
    log(`leftover fight recovery failed (${message_of(error)}) — skipping borrow-dependent phases this pass`)
    return { kind: 'in_progress', fight_id }
  }
}