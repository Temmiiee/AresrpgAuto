// Dungeon runner. A key is burned to ENTER a run; a run is character state
// (`dungeon_run = { dungeon, room }`, 1-based). Each room is a NORMAL fight: `start_fight` births
// it, the ordinary fight driver (combat.ts) plays the turns, and `settle_pending` routes the ended
// room back through the dungeon settlement door, which advances the run or ends it. Between rooms
// the chain roots the character at the portal, so this driver only ever ENTERS or STARTS the
// current room's fight -- it never travels while a run is live.
//
// GROUP runs. The ordinary fight join is refused by a dungeon room (its door policy sets DOOR_JOIN),
// so the party joins through the dedicated dungeon door -- and that door requires the joiner to have
// ENTERED the same run (its own key). A group run therefore needs one key per entrant: the leader
// commits the party to a dungeon, every key-holder walks to the portal and enters, then the leader
// starts room 1 and the enterers join. The party only runs a dungeon when it holds at least
// MIN_GROUP_KEYS keys -- never solo.
//
// The roster/indexer trails a transaction by a few seconds, so both steps carry a grace window and
// the started room is remembered; acting on a stale read would re-issue the same door (a harmless
// but noisy abort) or, worse, start the wrong room against the chain's advanced counter.
import type { CharacterRow } from '@aresrpg/protocol'

import { dungeon_city, dungeon_rooms, worlds_by_id } from '../content/catalog.ts'
import { log_debug, log_info, log_warn } from '../shared/logger.ts'
import { active_fight_of, select_character, unavailable_item_ids } from '../state/selectors.ts'
import { custody_of, type ActionContext } from './context.ts'
import { DUNGEON_KEYS, DUNGEON_PARK_MS, key_parked, park_dungeon_key, should_run_dungeons } from './dungeon.ts'
import { safe_travel_to } from './roam.ts'
import { describe_score, DUNGEON_ROUNDS, score_group, type MobGroupRow } from './fight_preview.ts'
import type { Mover } from './travel.ts'

/** After a successful `enter`, wait this long for the roster to reveal `dungeon_run` before
 *  re-reading it. Re-entering is a harmless abort (EAlreadyInRun) but spams the log. */
const ENTER_GRACE_MS = 30_000
/** After a successful `start_fight`, wait this long for the live fight to surface before retrying. */
const START_GRACE_MS = 20_000
/** How long the leader waits for the other key-holders to enter the run before starting room 1
 *  anyway. Anyone still walking joins a later room; the wait only bounds room 1. */
const GROUP_ENTER_WAIT_MS = 90_000
/** A group run needs at least this many keys (one per entrant). Fewer is a solo run, which the party
 *  has stopped doing -- dungeon fights are only worth it fought as a stack. */
const MIN_GROUP_KEYS = 2
/** The win rate below which a room is not worth committing to. */
const MIN_WIN_RATE = 0.8

/** Per-character "last enter submitted" stamp, shared by the leader's runner and the follower step so
 *  a lagging roster never re-issues the same enter door. */
const last_enter_ms_by_char = new Map<string, number>()

const message_of = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export type DungeonOutcome = Readonly<{
  kind: 'entered' | 'started' | 'waiting' | 'traveling' | 'skipped'
  detail: string
  /** When kind === 'started', the fight ID that was created. */
  fight_id?: string
}>

const outcome = (kind: DungeonOutcome['kind'], detail: string, fight_id?: string): DungeonOutcome =>
  Object.freeze({ kind, detail, ...(fight_id ? { fight_id } : {}) })

export type DungeonRunner = Readonly<{
  /** Enter or start the current room, or null when this character has no dungeon business. */
  run_once: (mover: Mover) => Promise<DungeonOutcome | null>
}>

/** The dungeon board derives each seat's mob `level_scalar` as `mix(run_seed, seat) % 101` from the
 *  chain's terminal `&Random` (see `move/sources/dungeon.move` + `move-math/sources/dungeon_data.move`)
 *  — a genuine UNIFORM draw over [0, 100] that no client can predict, because the run's seed is drawn
 *  at `enter` and never exposed to the client. Its EXPECTED value is the mean, 50, so a room preview
 *  must score the mean difficulty; the old `50 + i` merely inflated every mob after the first and
 *  systematically over-estimated how hard the room was, parking keys the party could actually clear.
 *  Per-run variance is the game's own design and cannot be previewed away. */
export const DUNGEON_EXPECTED_SCALAR = 50

/** Build a previewable MobGroupRow from a dungeon room's authored mob list (expected difficulty). */
export const room_to_mob_group = (room: readonly { mob_type: string }[]): MobGroupRow => ({
  index: 0,
  x: 0,
  z: 0,
  members: room.map((row) => ({ mob_type: row.mob_type, level_scalar: DUNGEON_EXPECTED_SCALAR })),
})

/** Collect available allies for a dungeon fight: other party members in the same world, not in a fight. */
const dungeon_allies = (ctx: ActionContext, character: CharacterRow): readonly CharacterRow[] => {
  const state = ctx.state()
  const party_ids = ctx.party_state?.members ?? []
  return party_ids
    .filter((id) => id !== character.id && !ctx.party_state?.detached.has(id))
    .map((id) => select_character(state, id))
    .filter((c): c is CharacterRow => c !== null && c.world === character.world && !active_fight_of(c) && c.custody !== 'fight')
}

/** The group a COMMIT is for: every non-detached member that will walk to the portal, capped to the
 *  seats the run can field. Deliberately not the transiently-free subset `dungeon_allies` returns --
 *  at commit time members are still travelling or mid-fight, so filtering on that single instant
 *  previewed the dungeon with a shrunken (often leader-only) party, under-scored it and parked a key
 *  the full group could clear. This preview only gates WHETHER to commit; `start_room` re-scores with
 *  the members that actually entered, so an optimistic plan cannot smuggle an unwinnable room past
 *  the honest check. */
const planning_allies = (
  ctx: ActionContext,
  character: CharacterRow,
  seats: number
): readonly CharacterRow[] => {
  const state = ctx.state()
  const party = ctx.party_state
  if (!party) return []
  return party.members
    .filter((id) => id !== character.id && !party.detached.has(id))
    .flatMap((id) => {
      const member = select_character(state, id)
      return member ? [member] : []
    })
    .slice(0, Math.max(0, seats - 1))
}

/** The keys held for `key`, scanning every non-unavailable stack the party shares one kiosk for. */
const held_key_amount = (ctx: ActionContext, key: string): number => {
  const unavailable = unavailable_item_ids(ctx.state())
  let total = 0
  for (const item of ctx.state().inventory) {
    if (item.item_type === key && !unavailable.has(item.id)) total += item.amount
  }
  return total
}

/** How many party members have entered `dungeon` and are sitting on `room` right now. */
const party_entered_count = (ctx: ActionContext, dungeon: string, room: number): number => {
  const state = ctx.state()
  const party = ctx.party_state
  if (!party) return 0
  let count = 0
  for (const id of party.members) {
    if (party.detached.has(id)) continue
    const row = select_character(state, id)
    if (row?.dungeon_run && row.dungeon_run.dungeon === dungeon && row.dungeon_run.room === room) count += 1
  }
  return count
}

/** Walk to the dungeon's city portal, prove the leg, and burn one key to open the run. Shared by the
 *  leader's runner and every follower entering a committed group run (both keep the per-character
 *  `last_enter_ms` grace so a roster lag never re-issues the door). */
const enter_run = async (
  ctx: ActionContext,
  mover: Mover,
  character: CharacterRow,
  dungeon: string
): Promise<DungeonOutcome | null> => {
  const dk = DUNGEON_KEYS.find((row) => row.dungeon === dungeon)
  if (!dk) return null
  const world = worlds_by_id[character.world ?? ctx.world] ?? worlds_by_id['nauvis']
  const city = world ? dungeon_city(world, dk.dungeon) : null
  if (!city) {
    log_warn('dungeon', `no city portal for ${dk.dungeon} in ${character.world ?? ctx.world}`)
    return outcome('skipped', `no portal for ${dk.dungeon}`)
  }
  if (character.world !== world.world)
    return outcome('skipped', `in ${character.world ?? 'no world'}; ${dk.dungeon} portal is in ${world.world}`)

  // Room 1 is previewed by the leader before this is ever called (it commits only on a sure win), so
  // re-screening here only doubles the fight sim.
  const last = last_enter_ms_by_char.get(character.id) ?? 0
  if (Date.now() - last < ENTER_GRACE_MS) return outcome('waiting', 'recent enter; waiting for the roster')
  if (!(await safe_travel_to(mover, city.x, city.z))) return outcome('traveling', `walking to the ${city.city} portal`)
  if (!(await mover.prove_ready(city.x, city.z))) {
    const a = mover.anchor()
    const p = mover.pose()
    // Diagnoses a portal leg the chain will not prove (a stale/poisoned anchor, a wrong world):
    // BOT_DEBUG only, so an ordinary run stays quiet.
    log_debug(
      'dungeon',
      `portal leg unproven: anchor=${a ? `${a.world}:${a.x},${a.z}@${a.at_ms}` : 'null'} pose=${p.x},${p.z} target=${city.x},${city.z} can_reach_target=${mover.can_reach(city.x, city.z)} char=${character.world}:${character.x},${character.z}@${character.at_ms} run=${character.dungeon_run ? `${character.dungeon_run.dungeon}:${character.dungeon_run.room}` : 'null'} pet=${character.pet}`
    )
    return outcome('traveling', 'the chain cannot yet prove the portal leg')
  }

  const unavailable = unavailable_item_ids(ctx.state())
  const key_item = ctx
    .state()
    .inventory.find((item) => item.item_type === dk.key && item.amount > 0 && !unavailable.has(item.id))
  if (!key_item) return null
  // Consolidate every other held stack of the same key into the burn target first.
  const merge_sources = ctx
    .state()
    .inventory.filter(
      (item) =>
        item.item_type === dk.key &&
        item.id !== key_item.id &&
        item.amount > 0 &&
        !unavailable.has(item.id) &&
        item.kiosk === key_item.kiosk
    )
    .map((item) => item.id)

  last_enter_ms_by_char.set(character.id, Date.now())
  try {
    const receipt = await ctx.sdk.dungeon.enter({
      character_id: ctx.character_id,
      custody: custody_of(character),
      world: world.world,
      dungeon: dk.dungeon,
      key_id: key_item.id,
      merge_sources,
    })
    ctx.ledger.append({
      kind: 'dungeon_enter',
      digest: receipt.digest,
      detail: { dungeon: dk.dungeon, key: dk.key },
    })
    log_info('dungeon', `${character.name}: entered ${dk.dungeon} (burned ${dk.key})`)
    return outcome('entered', `entered ${dk.dungeon}`)
  } catch (error) {
    log_warn('dungeon', `enter ${dk.dungeon} failed: ${message_of(error)}`)
    return outcome('skipped', `enter failed: ${message_of(error)}`)
  }
}

/** Pick the first dungeon the party can field a GROUP for: at least MIN_GROUP_KEYS keys and
 *  EVERY room preview clears at the entrant seat count. Rooms are judged over DUNGEON_ROUNDS
 *  (a slow clear still clears), and a key with ANY unwinnable room is parked. */
const plan_group_dungeon = (
  ctx: ActionContext,
  character: CharacterRow
): Readonly<{ dungeon: string; world: string; city: string; x: number; z: number; seats: number }> | null => {
  const party = ctx.party_state
  if (!party) return null
  const members = party.members.filter((id) => !party.detached.has(id))
  if (members.length < MIN_GROUP_KEYS) return null
  const world_name = character.world ?? ctx.world
  const world = worlds_by_id[world_name]
  if (!world) return null
  const blacklist = ctx.dungeon_blacklist

  for (const dk of DUNGEON_KEYS) {
    if (key_parked(blacklist, dk.key)) continue
    const keys = held_key_amount(ctx, dk.key)
    if (keys < MIN_GROUP_KEYS) continue
    const city = dungeon_city(world, dk.dungeon)
    if (!city) continue
    const all_rooms = dungeon_rooms(dk.dungeon)
    if (all_rooms.length === 0) continue
    const seats = Math.min(keys, members.length)
    const allies = planning_allies(ctx, character, seats)

    // Preview EVERY room before committing any key. If any room is unwinnable, park the key.
    let all_clear = true
    for (let ri = 0; ri < all_rooms.length; ri++) {
      const room = all_rooms[ri]
      const preview = score_group(character, room_to_mob_group(room), allies, { rounds: DUNGEON_ROUNDS })
      if (preview.win_rate < MIN_WIN_RATE) {
        const pct = (preview.win_rate * 100).toFixed(0)
        log_warn(
          'dungeon',
          `${dk.dungeon} room ${ri + 1}: group preview win_rate=${pct}% (${describe_score(preview)}) < 80% (scored with ${allies.length + 1} of ${seats} seat(s)) -- parking key ${Math.round(DUNGEON_PARK_MS / 60_000)}min`
        )
        park_dungeon_key(blacklist, dk.key)
        all_clear = false
        break
      }
      log_info(
        'dungeon',
        `${character.name}: ${dk.dungeon} room ${ri + 1} group preview: win_rate=${(preview.win_rate * 100).toFixed(0)}%, ${describe_score(preview)}, seats=${seats}, scored=${allies.length + 1}, keys=${keys}`
      )
    }
    if (!all_clear) continue
    return Object.freeze({ dungeon: dk.dungeon, world: world.world, city: city.city, x: city.x, z: city.z, seats })
  }
  return null
}

/** A follower's half of a committed group run: walk to the dungeon and enter it (burning its own
 *  key), so its run exists and the dungeon door will accept its join to each room fight. Also
 *  abandons a run the leader is no longer driving, so a follower that could not join a room never
 *  sits rooted at a portal. */
export const follower_dungeon_step = async (ctx: ActionContext, mover: Mover): Promise<boolean> => {
  const character = select_character(ctx.state(), ctx.character_id)
  if (!character) return false
  if (character.id === ctx.party_state?.leader_id) return false
  if (character.ambush) return false
  if (active_fight_of(character)) return false
  if (character.custody === 'fight') return false

  const group = ctx.party_state?.dungeon ?? null

  const leader_id = ctx.party_state?.leader_id ?? null
  const leader_dungeon = leader_id ? (select_character(ctx.state(), leader_id)?.dungeon_run?.dungeon ?? null) : null
  // A run neither the committed group nor the leader is driving (it ended, or switched dungeons):
  // give it up rather than stay rooted at the portal. A run that MATCHES the leader's is kept -- the
  // follower is still needed for that room fight (this is also how a restart mid-run resumes).
  if (
    character.dungeon_run &&
    character.dungeon_run.dungeon !== group?.dungeon &&
    character.dungeon_run.dungeon !== leader_dungeon
  ) {
    try {
      await ctx.sdk.dungeon.abandon({ character_id: ctx.character_id, custody: custody_of(character) })
      log_info('dungeon', `${character.name}: abandoned a stale ${character.dungeon_run.dungeon} run`)
    } catch (error) {
      log_debug('dungeon', `${character.name}: stale-run abandon skipped (${message_of(error)})`)
    }
    return true
  }

  if (!group || character.dungeon_run) return false
  if ((character.world ?? ctx.world) !== group.world) return false
  const dk = DUNGEON_KEYS.find((row) => row.dungeon === group.dungeon)
  if (!dk) return false
  if (held_key_amount(ctx, dk.key) <= 0) return false
  const result = await enter_run(ctx, mover, character, group.dungeon)
  return result !== null
}

export const create_dungeon_runner = (ctx: ActionContext): DungeonRunner => {
  let last_start_ms = 0
  /** The (dungeon, room) whose fight we already opened. */
  let started: Readonly<{ dungeon: string; room: number }> | null = null
  /** True once THIS runner has entered the committed group run, so a null `dungeon_run` reads as
   *  "the run ended" rather than "we have not entered yet". */
  let entered_group = false

  /** Stage the run's current room: birth its fight (the turns are driven elsewhere). */
  const start_room = async (character: CharacterRow): Promise<DungeonOutcome> => {
    const run = character.dungeon_run!
    if (started && started.dungeon === run.dungeon && started.room === run.room) return outcome('waiting', 'room already started')
    if (Date.now() - last_start_ms < START_GRACE_MS) return outcome('waiting', 'recent start; waiting for the fight')

    const room = dungeon_rooms(run.dungeon)[run.room - 1]
    if (!room) {
      log_warn('dungeon', `${run.dungeon} room ${run.room} has no authored mobs -- abandoning run`)
      await abandon(ctx)
      return outcome('skipped', `no mobs authored for ${run.dungeon} room ${run.room}`)
    }

    const allies = dungeon_allies(ctx, character).filter((ally) => ally.dungeon_run?.dungeon === run.dungeon)
    const preview = score_group(character, room_to_mob_group(room), allies, { rounds: DUNGEON_ROUNDS })
    if (preview.win_rate < MIN_WIN_RATE) {
      log_warn(
        'dungeon',
        `${run.dungeon} room ${run.room}: preview win_rate=${(preview.win_rate * 100).toFixed(0)}% (${describe_score(preview)}) < 80% -- abandoning run`
      )
      await abandon(ctx)
      return outcome('skipped', `preview win_rate ${(preview.win_rate * 100).toFixed(0)}% -- abandoned`)
    }
    log_info(
      'dungeon',
      `${run.dungeon} room ${run.room} preview: win_rate=${(preview.win_rate * 100).toFixed(0)}%, ${describe_score(preview)}, turns=${preview.turns.toFixed(1)}, xp/turn=${Math.round(preview.xp_per_turn)}`
    )

    last_start_ms = Date.now()
    try {
      const receipt = await ctx.sdk.dungeon.start_fight({
        character_id: ctx.character_id,
        custody: custody_of(character),
        world: character.world ?? ctx.world,
        dungeon: run.dungeon,
        mob_types: room.map((row) => row.mob_type),
        access: 0,
      })
      started = Object.freeze({ dungeon: run.dungeon, room: run.room })
      ctx.ledger.append({ kind: 'dungeon_start', digest: receipt.digest, detail: { dungeon: run.dungeon, room: run.room } })
      log_info('dungeon', `${run.dungeon} room ${run.room} (${room.length} mobs) -> fight ${receipt.fight}`)
      return outcome('started', `${run.dungeon} room ${run.room} fight ${receipt.fight}`, receipt.fight)
    } catch (error) {
      log_warn('dungeon', `start ${run.dungeon} room ${run.room} failed: ${message_of(error)}`)
      return outcome('skipped', `start failed: ${message_of(error)}`)
    }
  }

  const run_once = async (mover: Mover): Promise<DungeonOutcome | null> => {
    const character = select_character(ctx.state(), ctx.character_id)
    if (!character) return null
    if (!should_run_dungeons(character, ctx)) return null
    if (character.ambush) return null
    if (active_fight_of(character)) return null
    if (character.custody === 'fight') return outcome('skipped', 'custody locked to a fight')

    const group = ctx.party_state?.dungeon ?? null

    // A committed group run whose fight is over: if we entered it and the run has since cleared,
    // release the party so it can go back to roaming.
    if (group && entered_group && !character.dungeon_run) {
      const last = last_enter_ms_by_char.get(character.id) ?? 0
      if (Date.now() - last >= ENTER_GRACE_MS) {
        log_info('dungeon', `${character.name}: group run of ${group.dungeon} finished`)
        ctx.party_state.dungeon = null
        entered_group = false
      }
    }

    if (character.dungeon_run) {
      const run = character.dungeon_run
      // Room 1 of a group run: give the other key-holders a bounded window to walk over and enter,
      // so the room is fought at the committed seat count instead of solo.
      if (group && group.dungeon === run.dungeon && run.room === 1) {
        const present = party_entered_count(ctx, run.dungeon, 1)
        if (present < group.seats && Date.now() - group.committed_ms < GROUP_ENTER_WAIT_MS) {
          return outcome('waiting', `waiting for ${group.seats - present} more enterer(s) in ${run.dungeon}`)
        }
        if (present < group.seats) {
          log_warn('dungeon', `${character.name}: ${group.seats - present} enterer(s) never arrived; starting ${run.dungeon} room 1 with ${present}`)
        }
      }
      return await start_room(character)
    }

    // No live run. Is the party already committed to a group run?
    const committed = ctx.party_state?.dungeon ?? null
    if (committed) {
      if (character.world && character.world !== committed.world) {
        log_warn('dungeon', `${character.name}: in ${character.world}; cannot enter ${committed.dungeon} in ${committed.world} -- releasing the party`)
        ctx.party_state.dungeon = null
        return null
      }
      const result = await enter_run(ctx, mover, character, committed.dungeon)
      if (result?.kind === 'entered') entered_group = true
      if (result === null) {
        log_warn('dungeon', `${character.name}: no key left for committed ${committed.dungeon} -- releasing the party`)
        ctx.party_state.dungeon = null
      }
      return result
    }

    // Not committed: commit only when the party can field a group (>= MIN_GROUP_KEYS keys).
    if (!ctx.party_state || ctx.party_state.members.length < MIN_GROUP_KEYS) return null
    const plan = plan_group_dungeon(ctx, character)
    if (!plan) return null
    ctx.party_state.dungeon = Object.freeze({ ...plan, committed_ms: Date.now() })
    log_info('dungeon', `${character.name}: committing the party to ${plan.dungeon} (${plan.seats} seat(s))`)
    const result = await enter_run(ctx, mover, character, plan.dungeon)
    if (result?.kind === 'entered') entered_group = true
    if (result === null) ctx.party_state.dungeon = null
    return result
  }

  return Object.freeze({ run_once })
}

/** Give up the run rather than keep a character rooted at the portal forever. */
const abandon = async (ctx: ActionContext): Promise<void> => {
  const character = select_character(ctx.state(), ctx.character_id)
  if (!character) return
  try {
    await ctx.sdk.dungeon.abandon({ character_id: ctx.character_id, custody: custody_of(character) })
  } catch (error) {
    log_warn('dungeon', `abandon failed: ${message_of(error)}`)
  }
}
