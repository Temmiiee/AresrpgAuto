// The reusable group-fight engine — one call runs exactly one fight (search, difficulty check,
// engage, join, ready, turn loop, settle) and returns a full outcome report. Both the
// single-fight CLI and the looping session CLI call this; the logic lives in exactly one place.
//
// Split into one module per phase (fight_progression.ts -> fight_discovery.ts -> join_and_ready
// below -> fight_turn.ts -> fight_settle.ts), purely for readability — each phase runs exactly
// once, in this exact order, same as when it was all one file; nothing here changes what the bot
// actually does. fight_discovery.ts calls back into this file's run_one_group_fight on two
// specific on-chain races (see its own header) — a deliberate, safe circular import (see there).
import { living_content } from '@aresrpg/sdk'
import { world_content_id, world_id as derive_world_id } from '@aresrpg/sdk/seed-ids'

import type { BotSdk } from '../auth/sdk_client.ts'
import { write_group_state } from '../state/group_state.ts'
import { read_hp_state, write_hp_state, type HpState } from '../state/hp_state.ts'
import { CHARACTERS, LEADER, PARTY_ID, WORLD } from '../config/party_config.ts'
import { message_of, sleep, submit_with_retry } from '../shared/chain_retry.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import { auto_equip_available_gear } from '../market/auto_equip.ts'
import {
  as_number,
  fighter_indices,
  read_fight,
  FightNotFoundError,
  type FighterStatsJson,
  type FighterJson,
  type FightJson,
  type Position,
  type MobInfo,
  type FightOutcome,
} from './fight_state.ts'
import { prepare_party } from './fight_progression.ts'
import { find_or_create_fight } from './fight_discovery.ts'
import { run_turn_loop, DECISION_POLICY_SOURCE } from './fight_turn.ts'
import { settle_all } from './fight_settle.ts'

export { normalize_fight_json, FightNotFoundError } from './fight_state.ts'
export type { FighterStatsJson, FighterJson, FightJson, Position, MobInfo, FightOutcome }

// ── Phase 3: join every not-yet-seated character and ready up. ──────────────────────────────

const join_and_ready = async (bot: BotSdk, fight_id: string, log: (msg: string) => void): Promise<void> => {
  const { sdk, fight, kiosk_cap } = bot
  let state_json = await read_fight(sdk, fight_id)
  if (state_json.ended) return

  const leader_idx = fighter_indices(state_json).get(LEADER.id)
  if (leader_idx === undefined) throw new Error('Leader is not seated in this fight — cannot recover automatically')
  const { team } = state_json.fighters[leader_idx]!

  // Placement is a strict on-chain race: combat.move force-starts the fight 60s after engage
  // (PLACEMENT_FORCE_MS) even with only the leader seated, once anyone readies -- after that,
  // join_gate's `in_placement` check is permanently false and any join attempt aborts with
  // ENotPlacement (1706), no matter how many retries. `queue.length > 0` is this file's existing
  // signal for "already started" (checked below, before readying) -- checking it here too, before
  // spending a transaction on a join that's guaranteed to abort, turns a hard crash into a
  // graceful "fight fewer than the full party" instead (2026-09-05, live: a leftover solo fight
  // from earlier in this session crossed the 60s window before the other three could join).
  if (state_json.queue.length > 0) {
    log(`fight already started without the full party seated (placement's 60s window elapsed) — continuing with whoever joined`)
  } else {
    const missing = CHARACTERS.filter((c) => !c.leader && !fighter_indices(state_json).has(c.id))
    if (missing.length > 0) {
      log(`${missing.map((c) => c.name).join(', ')} joining (grouped, one transaction)…`)
      const cap = await kiosk_cap()
      if (!cap) throw new Error('No personal kiosk found for this account')
      await submit_with_retry(
        () =>
          fight.join_many({
            fight: fight_id,
            character_ids: missing.map((c) => c.id),
            team,
            party: PARTY_ID ?? undefined,
            custody: { kiosk: cap.kioskId, kiosk_cap: cap.objectId },
          }),
        log
      )
      await sleep(1_500)
    }
  }

  state_json = await read_fight(sdk, fight_id)
  if (state_json.queue.length > 0) return
  const indices = fighter_indices(state_json)
  for (const c of CHARACTERS) {
    state_json = await read_fight(sdk, fight_id)
    if (state_json.queue.length > 0) break
    const idx = indices.get(c.id)
    if (idx === undefined || state_json.fighters[idx]!.ready) continue
    log(`${c.name} readying…`)
    await submit_with_retry(() => fight.ready({ fight: fight_id, fighter_idx: BigInt(idx) }), log)
    await sleep(1_500)
  }
}

/** Runs exactly one group fight starting from `position`. Throws on unrecoverable errors (the
 *  caller — the session loop — is expected to log and continue rather than crash the process). */
export const run_one_group_fight = async (
  bot: BotSdk,
  position: Position,
  log: (msg: string) => void = console.log
): Promise<FightOutcome> => {
  const { sdk } = bot
  log(`combat policy: ${DECISION_POLICY_SOURCE}`)
  const zone_size = 512
  const zx = Math.floor(position.x / zone_size)
  const zz = Math.floor(position.z / zone_size)

  const { content_root, seed_package_original } = living_content(sdk, 'Group fight session')
  const game_original = sdk.game_type_package!
  const world_content = world_content_id(content_root, seed_package_original, WORLD)
  const world = derive_world_id(content_root, game_original, WORLD)
  await sdk.hydrate_unknown([world, world_content])

  const prep = await prepare_party(bot, log)

  const found = await find_or_create_fight(bot, position, zx, zz, world, world_content, prep, log)
  if (found.kind === 'retried') return found.outcome
  const { fight_id, mobs } = found

  // A vanished fight_id (join phase or turn loop, either can hit it) means the fight already
  // concluded and was closed by something other than this process — drop the dead fight_id so
  // the next attempt searches fresh instead of resuming a fight that no longer exists.
  let final_state: FightJson
  let turns: number
  try {
    await join_and_ready(bot, fight_id, log)
    ;({ final_state, turns } = await run_turn_loop(bot, fight_id, prep, log))
  } catch (error) {
    if (error instanceof FightNotFoundError) {
      write_group_state({})
      throw new Error(
        `${error.message} — it already concluded (won or lost) and was cleaned up elsewhere; local state cleared, will search fresh next run`,
        { cause: error }
      )
    }
    throw error
  }

  const won = final_state.winner === 0
  const new_position: Position = { x: final_state.x, z: final_state.z }

  // Record each character's hp-at-fight-end for the next run's HP-regen gate.
  {
    const now = Date.now()
    const hp_state: HpState = read_hp_state()
    const indices = fighter_indices(final_state)
    for (const c of CHARACTERS) {
      const idx = indices.get(c.id)
      const character_max_hp = prep.max_hp.get(c.id)
      if (idx === undefined || character_max_hp === undefined) continue
      hp_state[c.id] = { hp: as_number(final_state.fighters[idx]!.hp), at_ms: now, max_hp: character_max_hp }
    }
    write_hp_state(hp_state)
  }

  log(`fight ended (${won ? 'WON' : 'LOST'}) — settling all ${CHARACTERS.length} characters…`)
  const { drops } = await settle_all(bot, fight_id, log)
  write_group_state({})

  // Best-effort and non-fatal: the fight already succeeded by this point (won/lost, settled,
  // drops known), so an equip hiccup — even a transient one — should never turn a real result
  // into a thrown error the caller has to retry from scratch.
  try {
    await auto_equip_available_gear(bot, log)
  } catch (error) {
    log(`auto-equip skipped this fight (${message_of(error)})`)
  }

  const gas_mist = bot.fight.gas_spent(fight_id)
  const xp_gained: Record<string, number> = {}
  for (const c of CHARACTERS) {
    const live = await read_live_character_stats(sdk, c.id)
    const xp_before_val = prep.xp_before.get(c.id) ?? 0
    const xp_current = Number(live.experience)
    const xp_before_num = Number(xp_before_val)
    xp_gained[c.name] = xp_current - xp_before_num
  }

  return { won, fight_id, new_position, gas_mist, xp_gained, turns, mobs, drops }
}
