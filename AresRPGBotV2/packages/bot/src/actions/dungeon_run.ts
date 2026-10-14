// Dungeon runner (solo leader). A key is burned to ENTER a run; a run is character state
// (`dungeon_run = { dungeon, room }`, 1-based). Each room is a NORMAL fight: `start_fight` births
// it, the ordinary fight driver (combat.ts) plays the turns, and `settle_pending` routes the ended
// room back through the dungeon settlement door, which advances the run or ends it. Between rooms
// the chain roots the character at the portal, so this driver only ever ENTERS or STARTS the
// current room's fight — it never travels while a run is live.
//
// The roster/indexer trails a transaction by a few seconds, so both steps carry a grace window and
// the started room is remembered; acting on a stale read would re-issue the same door (a harmless
// but noisy abort) or, worse, start the wrong room against the chain's advanced counter.
import type { CharacterRow } from '@aresrpg/protocol'

import { dungeon_city, dungeon_rooms, worlds_by_id } from '../content/catalog.ts'
import { log_debug, log_info, log_warn } from '../shared/logger.ts'
import { active_fight_of, select_character, unavailable_item_ids } from '../state/selectors.ts'
import { custody_of, type ActionContext } from './context.ts'
import { DUNGEON_KEYS, held_dungeon_key, should_run_dungeons } from './dungeon.ts'
import { safe_travel_to } from './roam.ts'
import type { Mover } from './travel.ts'

/** After a successful `enter`, wait this long for the roster to reveal `dungeon_run` before
 *  re-reading it. Re-entering is a harmless abort (EAlreadyInRun) but spams the log. */
const ENTER_GRACE_MS = 30_000
/** After a successful `start_fight`, wait this long for the live fight to surface before retrying. */
const START_GRACE_MS = 20_000

const message_of = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export type DungeonOutcome = Readonly<{
  kind: 'entered' | 'started' | 'waiting' | 'traveling' | 'skipped'
  detail: string
}>

const outcome = (kind: DungeonOutcome['kind'], detail: string): DungeonOutcome =>
  Object.freeze({ kind, detail })

export type DungeonRunner = Readonly<{
  /** Enter or start the current room, or null when this character has no dungeon business. */
  run_once: (mover: Mover) => Promise<DungeonOutcome | null>
}>

export const create_dungeon_runner = (ctx: ActionContext): DungeonRunner => {
  let last_enter_ms = 0
  let last_start_ms = 0
  /** The (dungeon, room) whose fight we already opened, so a stale read never opens it twice. */
  let started: Readonly<{ dungeon: string; room: number }> | null = null

  const abandon = async (character: CharacterRow, why: string): Promise<void> => {
    try {
      await ctx.sdk.dungeon.abandon({ character_id: ctx.character_id, custody: custody_of(character) })
      log_warn('dungeon', `${ctx.character_id}: abandoned run — ${why}`)
    } catch (error) {
      log_warn('dungeon', `abandon failed: ${message_of(error)}`)
    }
  }

  /** Stage the run's current room: birth its fight (the turns are driven elsewhere). */
  const start_room = async (character: CharacterRow): Promise<DungeonOutcome> => {
    const run = character.dungeon_run!
    if (started && started.dungeon === run.dungeon && started.room === run.room)
      return outcome('waiting', `room ${run.room} fight already staged`)
    if (Date.now() - last_start_ms < START_GRACE_MS) return outcome('waiting', 'recent start; waiting')
    const room = dungeon_rooms(run.dungeon)[run.room - 1]
    if (!room) {
      // The run sits at a room the seed does not describe: unroot rather than hang forever.
      await abandon(character, `${run.dungeon} room ${run.room} has no authored mobs`)
      return outcome('skipped', `${run.dungeon} room ${run.room} unknown`)
    }
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
      ctx.ledger.append({
        kind: 'dungeon_start',
        digest: receipt.digest,
        detail: { dungeon: run.dungeon, room: run.room, mobs: room.map((row) => row.mob_type) },
      })
      log_info('dungeon', `${run.dungeon} room ${run.room} (${room.length} mobs) -> fight ${receipt.fight}`)
      return outcome('started', `${run.dungeon} room ${run.room} fight ${receipt.fight}`)
    } catch (error) {
      log_warn('dungeon', `start ${run.dungeon} room ${run.room} failed: ${message_of(error)}`)
      return outcome('skipped', `start failed: ${message_of(error)}`)
    }
  }

  /** Walk to the dungeon's city portal, prove the leg, and burn one key to open the run. */
  const enter = async (mover: Mover, character: CharacterRow, key: string): Promise<DungeonOutcome | null> => {
    const dk = DUNGEON_KEYS.find((row) => row.key === key)
    if (!dk) return null
    const world = worlds_by_id[ctx.world] ?? worlds_by_id['nauvis']
    const city = world ? dungeon_city(world, dk.dungeon) : null
    if (!city) {
      log_warn('dungeon', `no city portal for ${dk.dungeon} in ${ctx.world}`)
      return outcome('skipped', `no portal for ${dk.dungeon}`)
    }
    if (character.world !== world.world)
      return outcome('skipped', `in ${character.world ?? 'no world'}; ${dk.dungeon} portal is in ${world.world}`)
    if (Date.now() - last_enter_ms < ENTER_GRACE_MS) return outcome('waiting', 'recent enter; waiting for the roster')
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
      .inventory.find((item) => item.item_type === key && item.amount > 0 && !unavailable.has(item.id))
    if (!key_item) return null
    // Consolidate every other held stack of the same key into the burn target first.
    const merge_sources = ctx
      .state()
      .inventory.filter(
        (item) =>
          item.item_type === key &&
          item.id !== key_item.id &&
          item.amount > 0 &&
          !unavailable.has(item.id) &&
          item.kiosk === key_item.kiosk
      )
      .map((item) => item.id)

    last_enter_ms = Date.now()
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
        detail: { dungeon: dk.dungeon, city: city.city, key },
      })
      log_info('dungeon', `entered ${dk.dungeon} at ${city.city} (burned ${key})`)
      return outcome('entered', `entered ${dk.dungeon}`)
    } catch (error) {
      log_warn('dungeon', `enter ${dk.dungeon} failed: ${message_of(error)}`)
      return outcome('skipped', `enter failed: ${message_of(error)}`)
    }
  }

  const run_once = async (mover: Mover): Promise<DungeonOutcome | null> => {
    const state = ctx.state()
    const character = select_character(state, ctx.character_id)
    if (!character) return null
    if (!should_run_dungeons(character)) return null
    if (character.ambush) return null
    // A live fight (step 2) and an ended-but-unsettled fight (step 1) own their own beats.
    if (active_fight_of(character)) return null
    if (character.custody === 'fight') return outcome('skipped', 'custody locked to a fight')

    if (character.dungeon_run) return await start_room(character)

    // No live run: only a held key opens one.
    const key = held_dungeon_key(state.inventory, unavailable_item_ids(state))
    if (!key) return null
    return await enter(mover, character, key)
  }

  return Object.freeze({ run_once })
}
