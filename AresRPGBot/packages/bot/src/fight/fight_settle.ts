// Phase 5 of a group fight: settle every character and report the outcome.
import type { BotSdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { message_of, submit_with_retry } from '../shared/chain_retry.ts'
import { fighter_indices, read_fight } from './fight_state.ts'
import { possible_loot_item_types, record_fight_loot_rarity } from './fight_loot.ts'

// fight.settle() batches every fighter's settlement into ONE transaction (settlements: [{
// fighter_idx, loot }]) -- it does NOT take a single flat {fighter_idx, loot} (confirmed live
// 2026-09-05: the old one-call-per-character shape threw "undefined is not an object (evaluating
// 'settlements.length')" for every character, every time). All 4 characters share one personal
// kiosk (config/party_config.ts), so one kiosk_cap can authorize settling all of them together --
// same batching win as join_many.
export const settle_all = async (
  bot: BotSdk,
  fight_id: string,
  log: (msg: string) => void
): Promise<{ drops: Record<string, number> }> => {
  const { sdk, fight, kiosk_cap } = bot
  const drops: Record<string, number> = {}

  const state_json = await read_fight(sdk, fight_id).catch((error: unknown) => {
    log(`settle: couldn't re-read fight state (${message_of(error)}) — treating as already concluded`)
    return null
  })
  if (!state_json) return { drops }
  record_fight_loot_rarity(state_json)

  const indices = fighter_indices(state_json)
  const unsettled = CHARACTERS.filter((c) => {
    const idx = indices.get(c.id)
    return idx !== undefined && !state_json.fighters[idx]!.settled
  })
  if (unsettled.length === 0) return { drops }

  log(`settling ${unsettled.map((c) => c.name).join(', ')} (one transaction)…`)
  const loot = [...possible_loot_item_types(state_json)].map((item_type) => ({ item_type, existing: null }))
  const settlements = unsettled.map((c) => ({ fighter_idx: BigInt(indices.get(c.id)!), loot }))
  const cap = await kiosk_cap()
  if (!cap) throw new Error('No personal kiosk found for this account')

  let all_settled = true
  try {
    // drops_rolled comes straight off this exact settle transaction's own DropsRolled event(s) --
    // NOT a re-read of fight state before or after. Reading state BEFORE settle always shows the
    // pre-roll (empty) snapshot, since fight.move only rolls loot INSIDE the settle call itself
    // (see possible_loot_item_types' header comment); reading AFTER doesn't work either, because
    // this batched call settles every seat at once and is therefore almost always also the LAST
    // settler, which closes (deletes) the fight object in the same transaction. Confirmed live
    // (2026-09-05): 8 straight wins all reported "drops: none" despite real, non-zero drop
    // chances on every mob killed -- the event is the only place this data is still observable.
    //
    // KNOWN GAP (2026-09-06, left as-is on purpose -- see README's "CI" section): FightReceipt
    // only carries drops_rolled because packages/sdk/src/fight.ts has a LOCAL, uncommitted patch
    // on this machine reading fight.move's DropsRolled event -- never upstreamed to
    // aresrpg/aresrpg. A fresh clone of the game repo (CI, or anyone else's checkout) has no
    // drops_rolled field at all, so this line fails to typecheck there. Real and live-verified
    // here; not portable anywhere else until that patch is upstreamed.
    const { drops_rolled } = await submit_with_retry(
      () =>
        fight.settle({
          fight: fight_id,
          settlements,
          custody: { kiosk: cap.kioskId, kiosk_cap: cap.objectId },
        }),
      log
    )
    for (const { drops: fighter_drops } of drops_rolled ?? [])
      for (const { item_type, qty } of fighter_drops) drops[item_type] = (drops[item_type] ?? 0) + qty
  } catch (error) {
    log(`settle threw, re-checking on-chain state: ${message_of(error)}`)
    const recheck = await read_fight(sdk, fight_id).catch((reread_error: unknown) => {
      log(`settle: re-read after failure also failed (${message_of(reread_error)}) — assuming NOT settled`)
      return null
    })
    const recheck_indices = recheck ? fighter_indices(recheck) : null
    const still_unsettled = unsettled.filter((c) => {
      const idx = recheck_indices?.get(c.id)
      return idx === undefined || !recheck!.fighters[idx]!.settled
    })
    if (still_unsettled.length > 0) {
      all_settled = false
      log(`  ${still_unsettled.map((c) => c.name).join(', ')} NOT settled — will need a retry run`)
    } else {
      log('  settled successfully despite the error')
    }
  }

  if (!all_settled)
    throw new Error(`some characters still need settling — fight_id ${fight_id} kept in group-state.local.json`)
  return { drops }
}
