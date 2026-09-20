// Runs the account's daily mastery quest end to end: assign/confirm today's target dungeon,
// make sure the whole party can actually enter it, walk every room in order (reusing
// fight/fight_turn.ts's live turn-decision loop unchanged — a dungeon room fight is an ordinary
// Fight object underneath, just tagged, so turns work identically), and settle each room with
// the mastery quest wired in so completion happens automatically once the last room is won.
//
// If the party doesn't already hold enough keys, this crafts what it can (dungeon_keys.ts,
// bounded to exactly how many keys are still needed — never more) before giving up.
import type { BotSdk } from '../auth/sdk_client.ts'
import { CHARACTERS, LEADER, PARTY_ID, WORLD } from '../config/party_config.ts'
import { message_of, sleep, submit_with_retry } from '../shared/chain_retry.ts'
import { read_position, write_position } from '../state/position_state.ts'
import { prepare_party, type PartyPrep } from '../fight/fight_progression.ts'
import { run_turn_loop } from '../fight/fight_turn.ts'
import { fighter_indices, read_fight, type FightJson } from '../fight/fight_state.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import {
  dungeon_by_slug,
  dungeon_max_mob_level,
  key_recipe,
  room_mobs,
  type DungeonInfo,
} from '../shared/dungeon_content.ts'
import { read_dungeon_run, resolve_quest_dungeon_slug } from '../shared/dungeon_read.ts'
import { craft_keys_if_possible, owned_key_stack } from './dungeon_keys.ts'
import { ensure_daily_quest } from './mastery_quest.ts'
import { settle_dungeon_room } from './dungeon_settle.ts'
import { withdraw_listed_items_of_types } from '../market/withdraw_reserved_from_hdv.ts'

// Who enters a dungeon. Defaults to the whole party; `solo` narrows it to the strongest single
// character when a low-level dungeon doesn't need four keys' worth of power.
export type DungeonParty = readonly (typeof CHARACTERS)[number][]

// Same travel-time-gate physics as fight/fight_discovery.ts's engage wait (world_map::travel_ok
// is the same door either way) — duplicated rather than imported since fight_discovery.ts treats
// them as private constants of its own open-world flow.
const SPEED_BUDGET = 1150
const SPEED_SCALE = 100_000
const WAIT_MARGIN_MS = 4_000

/** Conservative on purpose: position.local.json tracks x/z only, no "as of when" timestamp, so
 *  this waits the FULL travel time every call rather than crediting any elapsed time since the
 *  party's last confirmed position — a real character who moved more recently than this assumes
 *  just waits a little longer than strictly necessary, never too little (which would abort). */
const wait_for_travel_to = async (target_x: number, target_z: number, log: (msg: string) => void): Promise<void> => {
  const position = read_position()
  const distance = Math.hypot(target_x - position.x, target_z - position.z)
  const wait_ms = Math.ceil((distance * SPEED_SCALE) / SPEED_BUDGET) + WAIT_MARGIN_MS
  if (wait_ms > 0) {
    log(`waiting ${(wait_ms / 1000).toFixed(1)}s for travel time…`)
    await sleep(wait_ms)
  }
}

/** Every participant not already mid-run enters (burning one unit off the shared key stack each,
 *  in order); anyone already on a matching run is left alone (resume, not re-entered). */
const enter_dungeon_for_party = async (
  bot: BotSdk,
  info: DungeonInfo,
  key_item_id: string,
  participants: DungeonParty,
  log: (msg: string) => void
): Promise<void> => {
  for (const c of participants) {
    const existing = await read_dungeon_run(bot.sdk, c.id)
    if (existing) {
      if (existing.dungeon !== info.dungeon)
        throw new Error(
          `${c.name} already has a live run in "${existing.dungeon}" (room ${existing.room}) — not "${info.dungeon}". Resolve that run by hand before running a different dungeon.`
        )
      log(`${c.name} already entered ${info.dungeon} (room ${existing.room}) — resuming, not re-entering`)
      continue
    }
    log(`${c.name} entering ${info.dungeon}…`)
    await submit_with_retry(
      () => bot.dungeon.enter({ character_id: c.id, world: info.world, dungeon: info.dungeon, key_id: key_item_id }),
      log
    )
    await sleep(1_500)
  }
  // enter() moves the character to the portal — the party's tracked position follows, same as
  // every other door that proves travel.
  write_position({ x: info.portal_x, z: info.portal_z })
}

/** Starts (first participant) or joins (everyone else among the participants) the run's CURRENT
 *  room, then readies everyone up — mirrors fight/fight_session.ts's join_and_ready, adapted to
 *  the dungeon join door. A solo run is exactly this with a single participant: the fight starts
 *  with one seat and the turn loop passes for the mob-only turns (same as a solo ambush). */
const engage_and_ready_room = async (
  bot: BotSdk,
  info: DungeonInfo,
  room: number,
  participants: DungeonParty,
  log: (msg: string) => void
): Promise<string> => {
  const mob_types = room_mobs(info, room)
  log(`room ${room}/${info.room_count}: ${mob_types.join(', ')}`)
  const [starter, ...joiners] = participants
  const engaged = await submit_with_retry(
    () =>
      bot.dungeon.start_fight({
        character_id: starter!.id,
        world: info.world,
        dungeon: info.dungeon,
        mob_types,
        access: 1,
      }),
    log
  )
  const fight_id = engaged.fight
  await sleep(1_500)

  for (const c of joiners) {
    log(`${c.name} joining room ${room}…`)
    await submit_with_retry(
      () => bot.dungeon.join_fight({ fight: fight_id, character_id: c.id, party: PARTY_ID ?? undefined }),
      log
    )
    await sleep(1_500)
  }

  let state_json: FightJson = await read_fight(bot.sdk, fight_id)
  if (state_json.queue.length === 0) {
    const indices = fighter_indices(state_json)
    for (const c of participants) {
      state_json = await read_fight(bot.sdk, fight_id)
      if (state_json.queue.length > 0) break
      const idx = indices.get(c.id)
      if (idx === undefined || state_json.fighters[idx]!.ready) continue
      log(`${c.name} readying…`)
      await submit_with_retry(() => bot.fight.ready({ fight: fight_id, fighter_idx: BigInt(idx) }), log)
      await sleep(1_500)
    }
  }

  return fight_id
}

export type DailyQuestOutcome =
  | { kind: 'already_completed' }
  | { kind: 'no_active_dungeon_target' }
  | { kind: 'not_enough_keys'; dungeon: string; have: number; need: number }
  | { kind: 'run'; dungeon: string; cleared: boolean; rooms_cleared: number }

/** Runs the account's daily mastery quest to completion (or as far as the party can get) —
 *  assigns/confirms it, checks keys, enters, and clears rooms one at a time until the run ends
 *  (won the last room, lost a room, or ran out of keys mid-resume).
 *
 *  `mode` picks who enters:
 *   - 'party' — every character (4 keys, every seat filled).
 *   - 'solo' — the single strongest character (1 key).
 *   - 'auto'  (default) — SOLO when the dungeon is well under the party's power (see
 *     dungeon_max_mob_level: the level_max ranges are the OPEN-WORLD caps per mob_type; in-quest
 *     mobs are calibrated to the key level, so a cap comfortably inside `party_max + 4` means one
 *     character is plenty and sending all four wastes three keys), otherwise the full party. */
export const run_daily_dungeon_quest = async (
  bot: BotSdk,
  log: (msg: string) => void = console.log,
  { mode = 'auto' }: { mode?: 'party' | 'solo' | 'auto' } = {}
): Promise<DailyQuestOutcome> => {
  const mastery = await ensure_daily_quest(bot, log)
  if (mastery.quest_completed) {
    log('daily quest already completed this epoch — nothing to do')
    return { kind: 'already_completed' }
  }

  const dungeon_slug = resolve_quest_dungeon_slug(bot.sdk, mastery.quest_dungeon)
  if (!dungeon_slug) {
    log(`today's quest_dungeon (${mastery.quest_dungeon}) doesn't match any dungeon this bot knows about`)
    return { kind: 'no_active_dungeon_target' }
  }
  const info = dungeon_by_slug(dungeon_slug)
  if (!info) throw new Error(`resolved dungeon slug "${dungeon_slug}" but dungeon_content.ts has no entry for it`)
  log(`today's quest: clear ${info.dungeon} (${info.room_count} rooms, world ${info.world})`)

  const prep: PartyPrep = await prepare_party(bot, log)

  // Decide who enters BEFORE touching any key: solo needs 1, the party needs 4.
  let participants: DungeonParty = CHARACTERS
  if (mode === 'solo' || (mode === 'auto' && dungeon_max_mob_level(info) <= max_party_level(prep) + 4)) {
    participants = [strongest_character(prep)]
    log(
      `${info.dungeon} max mob level ${dungeon_max_mob_level(info)} vs. party ${max_party_level(prep)} ` +
        `— ${mode} mode, sending one character (${participants[0]!.name})`
    )
  } else {
    log(`${info.dungeon} needs the whole party — sending all ${CHARACTERS.length} characters`)
  }

  // The key and every ingredient must be FREE to borrow — a listed object is LOCKED and any
  // craft/enter touching it aborts (kiosk::borrow abort 11). The auto-seller now reserves these
  // types going forward, but stacks listed before that policy existed are still standing, so pull
  // the bot's own open listings for exactly these types back before counting/crafting/entering.
  const recipe = key_recipe(info.key)
  await withdraw_listed_items_of_types(bot, new Set<string>([info.key, ...Object.keys(recipe ?? {})]), log)

  let key_stack = await owned_key_stack(bot, info.key)
  let have = key_stack?.amount ?? 0
  if (have < participants.length) {
    log(`only ${have}/${participants.length} "${info.key}" available — trying to craft the rest…`)
    await craft_keys_if_possible(bot, info, participants.length - have, log)
    key_stack = await owned_key_stack(bot, info.key)
    have = key_stack?.amount ?? 0
  }
  if (have < participants.length) {
    log(`still only ${have}/${participants.length} "${info.key}" — not entering`)
    return { kind: 'not_enough_keys', dungeon: info.dungeon, have, need: participants.length }
  }

  await wait_for_travel_to(info.portal_x, info.portal_z, log)
  await enter_dungeon_for_party(bot, info, key_stack!.item_id, participants, log)

  // Solo vs. party: the first participant is the character whose run state we read/settle
  // (in a solo run the leader may not be in the dungeon at all).
  const runner_id = participants[0]!.id
  let rooms_cleared = 0
  let cleared = false
  for (;;) {
    const run = await read_dungeon_run(bot.sdk, runner_id)
    if (!run) break // no live run left: either just cleared the last room, or lost one
    const fight_id = await engage_and_ready_room(bot, info, run.room, participants, log)
    const { final_state } = await run_turn_loop(bot, fight_id, prep, log)
    const won = final_state.winner === 0
    const runner_idx = fighter_indices(final_state).get(runner_id)
    await settle_dungeon_room(
      bot,
      info,
      fight_id,
      runner_idx !== undefined ? { id: bot.mastery.id, fighter_idx: BigInt(runner_idx) } : null,
      log
    )
    log(`room ${run.room}/${info.room_count} ${won ? 'WON' : 'LOST'}`)

    // The settle door advanced the run on-chain (won, more rooms left) or ended it (lost, or won
    // the last room) — but a concurrent process, or a settle that silently no-oped (dungeon_settle
    // skips when the fight already reads as fully settled), can leave the run live. Verify the
    // runner's ACTUAL run state before declaring anything ended: if it didn't move, the run is
    // still active and the character is rooted — soldiering on would loop prove_move 305 forever.
    await verify_room_settled(bot, runner_id, run.room, info.room_count, won, log)
    if (!won) break
    rooms_cleared += 1
    if (run.room >= info.room_count) {
      cleared = true
      break
    }
  }

  log(cleared ? `${info.dungeon} cleared (${rooms_cleared}/${info.room_count} rooms)` : `${info.dungeon} run ended after ${rooms_cleared}/${info.room_count} rooms`)
  return { kind: 'run', dungeon: info.dungeon, cleared, rooms_cleared }
}

const max_party_level = (prep: PartyPrep): number =>
  Math.max(0, ...[...prep.sim_party_stats.values()].map((m) => m.level))

/** The single strongest participant for a solo run: highest level, leader as a tie-break. */
export const strongest_character = (prep: PartyPrep): (typeof CHARACTERS)[number] => {
  const members = [...prep.sim_party_stats.values()]
  const best = members.reduce((a, b) => (b.level > a.level ? b : a), members[0]!)
  return CHARACTERS.find((c) => c.name === best.name) ?? LEADER
}

/** After a dungeon room's settle tx, confirm the runner's run moved exactly as the outcome
 *  demands — gone when lost (or the last room won), advanced to `room + 1` when a non-final room
 *  was won. Propagation can lag a beat, so this retries the read briefly before giving up. Any
 *  mismatch throws a descriptive error (the run is still live and the character rooted) rather
 *  than letting the caller log a cheerful "run ended" that isn't true. */
const verify_room_settled = async (
  bot: BotSdk,
  runner_id: string,
  room: number,
  room_count: number,
  won: boolean,
  log: (msg: string) => void,
  attempts = 5
): Promise<void> => {
  const expect_gone = !won || room >= room_count
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const run = await read_dungeon_run(bot.sdk, runner_id).catch(() => null)
    if (expect_gone) {
      if (!run) return
    } else if (run && run.room === room + 1) {
      return
    }
    if (attempt < attempts) {
      log(
        `room ${room} settle not confirmed on-chain yet (${run ? `still at room ${run.room}` : 'run read pending'}) — waiting…`
      )
      await sleep(1_500)
    }
  }
  const state = await read_dungeon_run(bot.sdk, runner_id).catch(() => null)
  if (expect_gone) {
    throw new Error(
      `dungeon room ${room} settle did not END the run on-chain — runner still holds ${state ? `"${state.dungeon}" room ${state.room}` : 'a live run'}. ` +
        `Another process may be re-entering/re-engaging this account; refusing to continue so the run can be resolved.`
    )
  }
  throw new Error(
    `dungeon room ${room} settle did not ADVANCE the run on-chain — runner still at room ${state?.room ?? '?'} (expected ${room + 1}). ` +
      `Another process may be re-entering/re-engaging this account; refusing to continue so the run can be resolved.`
  )
}
