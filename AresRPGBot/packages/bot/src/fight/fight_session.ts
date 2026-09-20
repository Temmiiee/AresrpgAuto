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

/** Resolves to `'ready'` when the fight is playable and the party is readied, or `'abandoned'`
 *  when the fight was already force-started at placement's 60s deadline with only a PARTIAL
 *  party seated — in which case this function forfeits the party's open seats on-chain to free
 *  everyone (a half-seated fight can never seat the missing character again: join aborts 1706
 *  forever, so it is structurally unsealable and playing turns only burns SUI on seal_end 1730).
 *  A FULL protectors' fight is never abandoned here — see the branch below. */
const join_and_ready = async (
  bot: BotSdk,
  fight_id: string,
  log: (msg: string) => void
): Promise<'ready' | 'abandoned'> => {
  const { sdk, fight, kiosk_cap } = bot
  let state_json = await read_fight(sdk, fight_id)
  if (state_json.ended) return 'ready'

  const leader_idx = fighter_indices(state_json).get(LEADER.id)
  if (leader_idx === undefined) throw new Error('Leader is not seated in this fight — cannot recover automatically')
  const { team } = state_json.fighters[leader_idx]!

  // Placement is a strict on-chain race: combat.move force-starts the fight 60s after engage
  // (PLACEMENT_FORCE_MS) even with only the leader seated, once anyone readies -- after that,
  // join_gate's `in_placement` check is permanently false and any join attempt aborts with
  // ENotPlacement (1706), no matter how many retries. `queue.length > 0` is this file's existing
  // signal for "already started" (checked below, before readying). Two very different situations
  // share that signal, and they need opposite treatment:
  //
  //   * FULL party seated (all CHARACTERS have a fighter seat) -> a normal, winnable fight
  //     (resource protector etc.). Keep playing it to the end -- NEVER forfeit it.
  //   * PARTIAL party seated (placement's 60s window elapsed before someone could join) -> the
  //     missing character can never seat now (join aborts 1706 forever), so the fight is
  //     structurally unsealable (seal_end aborts 1730) and playing turns only burns SUI on doomed
  //     1706 tries. Forfeit the OPEN seats to free the party, then drop the fight_id -- this is the
  //     ONLY recoverable outcome for a half-seated fight, but it only ever targets the doomed half-
  //     party case, never a full protectors' fight. (2026-09-05, live: a seatless memorien on a
  //     resumed fight turned every turn into a 1706 and the final seal_end into a 1730 that killed
  //     the whole process with exit code 1.)
  const forfeit_open_seats = async (): Promise<void> => {
    const cap = await kiosk_cap()
    if (!cap) throw new Error('No personal kiosk found for this account')
    for (const c of CHARACTERS) {
      const idx = fighter_indices(state_json).get(c.id)
      if (idx === undefined) continue
      log(`${c.name} forfeiting (fighter ${idx})…`)
      await submit_with_retry(
        () =>
          fight.forfeit({
            fight: fight_id,
            fighter_idx: BigInt(idx),
            custody: { kiosk: cap.kioskId, kiosk_cap: cap.objectId },
          }),
        log
      )
    }
  }
  if (state_json.queue.length > 0) {
    if (fighter_indices(state_json).size < CHARACTERS.length) {
      log(`fight already started WITHOUT the full party seated (placement's 60s window elapsed) — forfeiting the party's open seats to free everyone (this half-seated fight is unsealable on-chain)…`)
      await forfeit_open_seats()
      return 'abandoned'
    }
    log(`fight already started with the full party seated — continuing to fight it out (protectors are played to the end, never forfeited)`)
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
  if (state_json.queue.length > 0) {
    // The fight force-started while the join was in flight. A full party means a normal
    // protectors' fight — play it. A partial one is the unsealable half-seated case; forfeit.
    if (fighter_indices(state_json).size >= CHARACTERS.length) return 'ready'
    log(`fight started with a partial party during join (placement's 60s window elapsed) — forfeiting the party's open seats…`)
    await forfeit_open_seats()
    return 'abandoned'
  }
  const indices = fighter_indices(state_json)
  const unready = CHARACTERS.flatMap((c) => {
    const idx = indices.get(c.id)
    if (idx === undefined || state_json.fighters[idx]!.ready) return []
    return [BigInt(idx)]
  })
  if (unready.length === 0) return 'ready'
  log(`${unready.length} fighter(s) readying (one transaction)…`)
  await submit_with_retry(() => fight.ready_many({ fight: fight_id, fighter_indices: unready }), log)
  return 'ready'
}

/** Runs exactly one group fight starting from `position`. Throws on unrecoverable errors (the
 *  caller — the session loop — is expected to log and continue rather than crash the process).
 *  Pass `opts.can_spend: false` when resuming a leftover fight: the party is already seated
 *  inside it, so prepare_party's kiosk-based stat/spell spends must be skipped. */
export const run_one_group_fight = async (
  bot: BotSdk,
  position: Position,
  log: (msg: string) => void = console.log,
  opts: { can_spend?: boolean } = {}
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

  const prep = await prepare_party(bot, log, opts.can_spend !== false)

  const found = await find_or_create_fight(bot, position, zx, zz, world, world_content, prep, log)
  if (found.kind === 'retried') return found.outcome
  const { fight_id, mobs } = found

  // A vanished fight_id (join phase or turn loop, either can hit it) means the fight already
  // concluded and was closed by something other than this process — drop the dead fight_id so
  // the next attempt searches fresh instead of resuming a fight that no longer exists.
  let final_state: FightJson
  let turns: number
  try {
    // `join_and_ready` only returns `'abandoned'` when the placement window's 60s deadline force-
    // started the fight WITH ONLY A PARTIAL PARTY seated, and it has ALREADY forfeited the open
    // seats on-chain to free everyone. Drop local fight state and return an abandoned outcome
    // here -- a NO-OP, never a defeat -- instead of stepping into the turn loop: the seated
    // seats are gone, so turns would only re-abort 1706 and the final seal_end would seal the
    // on-chain object (seal_end aborts 1730 on an empty fight), killing the whole process with
    // exit code 1 (live: 2026-09-05 resumed half-party fight). Protectores are NEVER abandoned
    // here -- they were abandoned by nobody; run_turn_loop is only reached for a full protectors'
    // fight (which is played to the end, never forfeited).
    const status = await join_and_ready(bot, fight_id, log)
    if (status === 'abandoned') {
      log(`fight abandoned (placement's deadline started it half-seated, seats already forfeited on-chain) — dropping local state, will search fresh`)
      write_group_state({})
      return {
        won: false,
        fight_id,
        new_position: position,
        gas_mist: 0n,
        xp_gained: {},
        turns: 0,
        mobs: [],
        drops: {},
      }
    }
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
