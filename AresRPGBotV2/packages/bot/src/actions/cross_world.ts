// Cross-world gathering — the dedicated detacher.
//
// yakutia holds gathering tiers 4-6 that nauvis does not, but it has no mobs and no cities, so the
// fighting party cannot simply walk there. One designated character periodically DETACHES from the
// side: it walks to the world gate, joins the richer world, gathers its best unlocked tier in a
// matching biome zone, then returns home and rejoins. While it is away the party fights a member
// short — `PartyState.detached` tells the leader's rendezvous to ignore the missing seat, so no
// follower is ever stranded waiting on a character in another world.
//
// The world gate IS the world centre (the same anchor `roam.join_world` uses to change worlds), so a
// trip from a far farm ring costs a real walk out and back; the interval is long enough to amortise
// that and the dwell long enough to bank a stack before the return leg. Nothing here is guessed: a
// world only becomes a target when the character's level clears its entry gate AND one of its
// resources is tier-unlocked AND the matching job tool is actually owned.
import { job_level_from_xp } from '@aresrpg/immutable'
import type { CharacterRow, ItemRow } from '@aresrpg/protocol'

import { config } from '../config.ts'
import { find_resource_zone } from '../content/biomes.ts'
import {
  tier_unlock_level,
  tool_category_of_job,
  worlds,
  type GatheringJob,
  type SeedWorld,
} from '../content/catalog.ts'
import { WORLD_CENTER } from '../content/zone_map.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { active_fight_of, select_character, unavailable_item_ids } from '../state/selectors.ts'
import type { GameState } from '../state/store.ts'
import { custody_of, type ActionContext } from './context.ts'
import { gather_once } from './gather.ts'
import type { PartyState } from './party.ts'
import { safe_travel_to } from './roam.ts'
import type { Mover } from './travel.ts'

/** A resource this character can actually harvest in another world (level met, tier unlocked, tool
 *  owned): the trip target. `item_types` lists every item of that job+tier, any one satisfies it. */
export type CrossWorldTarget = Readonly<{
  world: SeedWorld
  job: GatheringJob
  tier: number
  item_types: readonly string[]
}>

export type CrossWorldOutcome = Readonly<{ handled: boolean; detail: string }>

export type CrossWorldGatherer = Readonly<{
  /** Drive the trip state machine. `handled` true means this pass belongs to the trip and the caller
   *  must not run ordinary play (the detacher is in another world). */
  run_once: (party: PartyState, mover: Mover) => Promise<CrossWorldOutcome>
}>

const message_of = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Once the detacher stands on the gate and can prove the leg, a refused join must not be retried
 *  every pass (each retry is a signed transaction). Mirror roam.ts's cooldown, scaled to a trip. */
const JOIN_RETRY_MS = 60_000

/** A trip's in-world walk to the resource zone is bounded. A world's authored zone can be thousands
 *  of blocks from the gate; once this long passes without landing on one the trip returns home rather
 *  than walking the dwell away (the earlier bug: a 10-minute dwell spent entirely on the approach). */
const TRIP_WALK_LIMIT_MS = 20 * 60_000

const skip = (detail: string): CrossWorldOutcome => Object.freeze({ handled: false, detail })
const act = (detail: string): CrossWorldOutcome => Object.freeze({ handled: true, detail })

/** Whether the character holds (worn or held) the tool a job's gathers require. Mirrors gather.ts. */
const tool_ready = (
  character: CharacterRow,
  inventory: readonly ItemRow[],
  job: GatheringJob,
  unavailable: ReadonlySet<string>
): boolean => {
  const category = tool_category_of_job(job)
  return (
    character.equipment.some((worn) => worn.category === category) ||
    inventory.some((item) => item.category === category && !unavailable.has(item.id))
  )
}

/** The richest OTHER world this character can gather in: the highest resource tier in any world it
 *  qualifies for (entry level met, tier unlocked, job tool owned). Null when no trip would pay. */
export const cross_world_target = (
  character: CharacterRow,
  state: GameState,
  home: string
): CrossWorldTarget | null => {
  const unavailable = unavailable_item_ids(state)
  const jobs = character.jobs ?? {}
  let best: Readonly<{ world: SeedWorld; job: GatheringJob; tier: number }> | null = null
  for (const world of worlds) {
    if (world.world === home) continue
    if (config.cross_world_world && world.world !== config.cross_world_world) continue
    if (world.entry_level > character.level) continue
    if (world.resources.length === 0) continue
    for (const resource of world.resources) {
      if (tier_unlock_level(resource.tier) > job_level_from_xp(Number(jobs[resource.job] ?? 0))) continue
      if (!tool_ready(character, state.inventory, resource.job, unavailable)) continue
      if (
        !best ||
        resource.tier > best.tier ||
        (resource.tier === best.tier && world.entry_level > best.world.entry_level)
      )
        best = Object.freeze({ world, job: resource.job, tier: resource.tier })
    }
  }
  if (!best) return null
  const item_types = best.world.resources
    .filter((resource) => resource.job === best.job && resource.tier === best.tier)
    .map((resource) => resource.item_type)
  return Object.freeze({
    world: best.world,
    job: best.job,
    tier: best.tier,
    item_types: Object.freeze(item_types),
  })
}

type Phase = 'idle' | 'outbound' | 'gathering' | 'inbound'

export const create_cross_world_gatherer = (ctx: ActionContext, home: string): CrossWorldGatherer => {
  let phase: Phase = 'idle'
  /** When the previous trip finished. Seeded at construction so a fresh boot does NOT detach on its
   *  very first idle pass: `0` made `Date.now() - 0 >= interval` true immediately, so archero left
   *  for yakutia seconds after every restart and the party fought the whole first interval at 3
   *  seats. Seeding with `now` gives the party a full interval at home before the first trip. */
  let last_trip_ms = Date.now()
  let arrived_ms = 0
  /** When the dwell clock started — i.e. when the character first stood on a zone to harvest. `0`
   *  while the trip is still walking to one, so the dwell never pays for the approach. */
  let harvest_ms = 0
  let last_join_ms = 0

  const set_detached = (party: PartyState, on: boolean): void => {
    if (on) party.detached.add(ctx.character_id)
    else party.detached.delete(ctx.character_id)
  }

  /** Walk to the world gate and switch worlds. Returns true only once the chain accepted the join. */
  const join_world = async (mover: Mover, character: CharacterRow, world: string): Promise<boolean> => {
    if (!(await safe_travel_to(mover, WORLD_CENTER, WORLD_CENTER))) return false
    if (!(await mover.prove_ready(WORLD_CENTER, WORLD_CENTER))) return false
    if (Date.now() - last_join_ms < JOIN_RETRY_MS) return false
    last_join_ms = Date.now()
    try {
      const receipt = await ctx.sdk.character.join_world({
        character_id: ctx.character_id,
        world,
        custody: custody_of(character),
      })
      ctx.ledger.append({
        kind: 'world_join',
        digest: receipt.digest,
        detail: { world, first_join: receipt.joined.first_join, cross_world: true },
      })
      log_info('cross_world', `joined ${world}${receipt.joined.first_join ? ' (first join)' : ''}`)
      return true
    } catch (error) {
      log_warn('cross_world', `join ${world} failed: ${message_of(error)}`)
      return false
    }
  }

  /** Walk to a known zone for the target item, discover it, then harvest its best live pack. */
  const gather_in_world = async (
    mover: Mover,
    target: CrossWorldTarget
  ): Promise<Readonly<{ at_zone: boolean; detail: string }>> => {
    const pose = mover.pose()
    const anchor_item = target.item_types[0]
    const zone = anchor_item
      ? find_resource_zone(target.world.world, anchor_item, pose.x, pose.z, 200)
      : null
    if (zone) {
      const here = Math.abs(pose.x - zone.x) <= 16 && Math.abs(pose.z - zone.z) <= 16
      if (!here) {
        if (!(await safe_travel_to(mover, zone.x, zone.z)))
          return Object.freeze({ at_zone: false, detail: `walking to ${zone.zx}:${zone.zz}` })
        if (!(await mover.prove_ready(zone.x, zone.z)))
          return Object.freeze({ at_zone: false, detail: 'the chain cannot yet prove the zone leg' })
        await mover.ensure_zone(false)
        return Object.freeze({ at_zone: true, detail: `arrived ${zone.zx}:${zone.zz} (${zone.biome})` })
      }
    } else {
      // No zone of the target resource was found in range: discover the zone we stand in so the
      // tracked window starts populating and `gather_once` can pick whatever the world does offer.
      await mover.ensure_zone(false)
      return Object.freeze({ at_zone: true, detail: 'discovering the local zone' })
    }
    const gathered = await gather_once(ctx, mover, target.job)
    return Object.freeze({
      at_zone: true,
      detail:
        gathered.kind === 'gathered'
          ? `gathered ${gathered.item_type} ×${gathered.quantity}`
          : `gathering: ${gathered.reason}`,
    })
  }

  const run_once = async (party: PartyState, mover: Mover): Promise<CrossWorldOutcome> => {
    const state = ctx.state()
    const character = select_character(state, ctx.character_id)
    if (!character) return skip('no roster')
    if (character.name.toLowerCase() !== config.cross_world_gatherer) return skip('not the detacher')
    if (character.ambush) return skip('a protector verdict is pending')
    if (character.dungeon_run) return skip('a dungeon run is staging')
    if (active_fight_of(character)) return skip('already in a fight')
    if (character.custody === 'fight') return skip('custody locked to a fight')

    if (phase === 'idle') {
      set_detached(party, false)
      if (config.cross_world_interval_ms === 0) return skip('cross-world trips disabled')
      if (Date.now() - last_trip_ms < config.cross_world_interval_ms) return skip('cooling down')
      const target = cross_world_target(character, state, home)
      if (!target) return skip('no reachable cross-world resource')
      phase = 'outbound'
      arrived_ms = 0
      set_detached(party, true)
      log_info(
        'cross_world',
        `${character.name}: detaching for a trip to ${target.world.world} — T${target.tier} ${target.job} (${target.item_types.join(', ')})`
      )
      return act(`trip to ${target.world.world}`)
    }

    if (phase === 'outbound') {
      set_detached(party, true)
      const target = cross_world_target(character, state, home)
      if (!target) {
        phase = 'idle'
        set_detached(party, false)
        return act('trip aborted — no reachable target')
      }
      if (character.world === target.world.world) {
        phase = 'gathering'
        arrived_ms = Date.now()
        harvest_ms = 0
        log_info('cross_world', `arrived in ${target.world.world}; locating a ${target.job} zone`)
        return act(`arrived in ${target.world.world}`)
      }
      const ok = await join_world(mover, character, target.world.world)
      return act(ok ? `joined ${target.world.world}` : 'walking to the world gate')
    }

    if (phase === 'gathering') {
      set_detached(party, true)
      const target = cross_world_target(character, state, home)
      if (!target || character.world !== target.world.world) {
        phase = 'outbound'
        return act('re-homing to the target world')
      }
      // The dwell counts HARVEST time, not the walk: it starts only once a zone is reached. A walk
      // that never lands is bounded so the trip still returns home instead of soaking forever.
      if (harvest_ms === 0 && Date.now() - arrived_ms >= TRIP_WALK_LIMIT_MS) {
        phase = 'inbound'
        log_info('cross_world', 'no resource zone reached — returning home')
        return act('returning home')
      }
      if (harvest_ms !== 0 && Date.now() - harvest_ms >= config.cross_world_dwell_ms) {
        phase = 'inbound'
        log_info('cross_world', 'dwell complete — returning home')
        return act('returning home')
      }
      const harvest = await gather_in_world(mover, target)
      if (harvest.at_zone && harvest_ms === 0) {
        harvest_ms = Date.now()
        log_info(
          'cross_world',
          `harvesting ${target.job} in ${target.world.world} for ${Math.round(config.cross_world_dwell_ms / 60_000)}m`
        )
      }
      return act(harvest.detail)
    }

    // inbound
    set_detached(party, true)
    if (character.world === home) {
      phase = 'idle'
      last_trip_ms = Date.now()
      set_detached(party, false)
      log_info('cross_world', `${character.name}: back in ${home}; rejoining the party`)
      return act(`back in ${home}`)
    }
    const ok = await join_world(mover, character, home)
    return act(ok ? `joined ${home}` : 'walking to the world gate')
  }

  return Object.freeze({ run_once })
}
