// Mastery quest automation: the daily/epoch dungeon completion quest.
// If an active mastery quest points to a dungeon we can clear, prioritize it.

import type { GameState, MasteryRow } from '../state/store.ts'
import { dungeon_rooms, dungeon_city, worlds_by_id } from '../content/catalog.ts'
import { DUNGEON_KEYS, held_key_amount, key_parked } from './dungeon.ts'
import { score_group, DUNGEON_ROUNDS, MIN_WIN_RATE, describe_score } from './fight_preview.ts'
import { room_to_mob_group } from './dungeon_run.ts'
import type { CharacterRow } from '@aresrpg/protocol'
import { log_info, log_warn } from '../shared/logger.ts'
import { unavailable_item_ids } from '../state/selectors.ts'
import type { ActionContext } from './context.ts'

/** Check if there's an active (uncompleted) mastery quest for a dungeon. */
export const active_mastery_quest = (state: GameState): MasteryRow | null => {
  const m = state.mastery
  if (!m || m.quest_completed) return null
  // Only care about the dungeon quest; ignore epoch/points.
  return m
}

/** Find the minimum seats needed to clear ALL rooms of a dungeon at the mastery quest's world.
 *  Returns null if no seat count works (even at max available). */
export const find_min_seats_for_mastery = (
  ctx: ActionContext,
  leader: CharacterRow,
  dungeon: string,
  world_name: string,
  max_seats: number
): number | null => {
  const world = worlds_by_id[world_name]
  if (!world) return null
  const all_rooms = dungeon_rooms(dungeon)
  if (all_rooms.length === 0) return null

  for (let seats = 2; seats <= max_seats; seats++) {
    const allies = available_allies(ctx, leader, seats, world_name)
    let all_clear = true
    for (const room of all_rooms) {
      const preview = score_group(leader, room_to_mob_group(room), allies, { rounds: DUNGEON_ROUNDS })
      if (preview.win_rate < MIN_WIN_RATE) {
        all_clear = false
        break
      }
    }
    if (all_clear) return seats
  }
  return null
}

/** Available allies for a dungeon fight at a given seat count (same logic as planning_allies). */
const available_allies = (
  ctx: ActionContext,
  leader: CharacterRow,
  seats: number,
  world_name: string
): readonly CharacterRow[] => {
  const party = ctx.party_state
  if (!party) return []
  const members = party.members.filter((id) => !party.detached.has(id))
  const state = ctx.state()
  return members
    .filter((id) => id !== leader.id)
    .map((id) => state.characters.find((c) => c.id === id))
    .filter((c): c is CharacterRow => c !== undefined && c.world === world_name)
    .slice(0, seats - 1)
}

/** Check if we have keys for the mastery dungeon and it's not parked. */
export const mastery_dungeon_ready = (
  ctx: ActionContext,
  leader: CharacterRow,
  dungeon: string
): { dk: (typeof DUNGEON_KEYS)[number]; keys: number; seats: number } | null => {
  const dk = DUNGEON_KEYS.find((row) => row.dungeon === dungeon)
  if (!dk) return null
  const blacklist = ctx.dungeon_blacklist
  if (key_parked(blacklist, dk.key)) return null
  const keys = held_key_amount(ctx.state().inventory, unavailable_item_ids(ctx.state()), dk.key)
  if (keys < 2) return null // MIN_GROUP_KEYS
  const members = ctx.party_state?.members.filter((id) => !ctx.party_state?.detached.has(id)) ?? []
  const max_seats = Math.min(keys, members.length)
  if (max_seats < 2) return null
  return { dk, keys, seats: max_seats }
}

/** Main entry: if mastery quest is active and doable, return a plan to run it.
 *  Returns null if no active quest, quest already done, or dungeon not viable. */
export const plan_mastery_dungeon = (
  ctx: ActionContext,
  leader: CharacterRow
): Readonly<{ dungeon: string; world: string; city: string; x: number; z: number; seats: number }> | null => {
  const quest = active_mastery_quest(ctx.state())
  if (!quest) return null

  const world_name = leader.world ?? ctx.world
  const ready = mastery_dungeon_ready(ctx, leader, quest.quest_dungeon)
  if (!ready) return null

  const min_seats = find_min_seats_for_mastery(ctx, leader, quest.quest_dungeon, world_name, ready.seats)
  if (!min_seats) {
    log_warn('mastery', `${quest.quest_dungeon}: mastery quest active but no seat count clears all rooms (max ${ready.seats})`)
    return null
  }

  const world = worlds_by_id[world_name]
  if (!world) return null
  const city = dungeon_city(world, quest.quest_dungeon)
  if (!city) return null

  const allies = available_allies(ctx, leader, min_seats, world_name)
  // Final full-room log at chosen seats.
  const all_rooms = dungeon_rooms(quest.quest_dungeon)
  for (let ri = 0; ri < all_rooms.length; ri++) {
    const room = all_rooms[ri]
    const preview = score_group(leader, room_to_mob_group(room), allies, { rounds: DUNGEON_ROUNDS })
    log_info(
      'mastery',
      `${leader.name}: MASTERY ${quest.quest_dungeon} room ${ri + 1} preview: win_rate=${(preview.win_rate * 100).toFixed(0)}%, ${describe_score(preview)}, seats=${min_seats}`
    )
  }
  log_info('mastery', `${leader.name}: MASTERY quest for ${quest.quest_dungeon} — committing ${min_seats} seat(s) (reward: ${quest.quest_reward} pts)`)

  return Object.freeze({
    dungeon: quest.quest_dungeon,
    world: world.world,
    city: city.city,
    x: city.x,
    z: city.z,
    seats: min_seats,
  })
}

/** Check if the current party's committed dungeon matches the mastery quest. */
export const is_mastery_dungeon = (state: GameState, dungeon: string): boolean => {
  const m = state.mastery
  return !!m && !m.quest_completed && m.quest_dungeon === dungeon
}