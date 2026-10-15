// Pure derivations over the live projection. Nothing here mutates or caches: a selector answers a
// question about the current fact set, and the play loop asks the same questions every pass so a
// changed server push is reflected immediately.
//
// These are the gatekeepers the actions trust: "is this character really mine", "what is still
// alive in this zone", "is the projected state fresh enough to spend money on", and "has enough
// chain time banked to prove this step". They are the only place those laws live.
import {
  character_checkpoint,
  live_mob_groups,
  live_resource_packs,
  travel_proof_ready,
  type CharacterRow,
  type MobGroupRow,
  type ResourcePackRow,
  type ZoneRow,
} from '@aresrpg/protocol'

import { zone_key, type ChainClock, type GameState } from './store.ts'

/** The server's indexing lag ceiling (slots) above which transaction composition is unsafe: the
 *  chain has moved past what the projection knows, so a race is likely. */
export const MAX_INDEXING_LAG = 300

export type Freshness = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>

/** The interval during which a chain timestamp observation is a usable estimate. */
const MAX_SAMPLE_AGE_MS = 15_000

/** Chain time, or null when the observation is missing or has expired. Wall-clock passage never
 *  fabricates chain time (chain_clock.ts law) — it only ages a real observation toward expiry. */
export const chain_now = (clock: ChainClock, monotonic_ms: number): number | null => {
  if (!clock) return null
  const elapsed = monotonic_ms - clock.received_ms
  // Floor: this value feeds `travel_proof_ready`, which rejects a non-integer `now_ms`, so even a
  // stray fraction (e.g. a sub-ms server sample age) would freeze every travel leg.
  return elapsed < 0 || elapsed > MAX_SAMPLE_AGE_MS ? null : Math.floor(clock.chain_ms + elapsed)
}

/** The pre-transaction gate: connected, gameplay unfrozen, projection caught up, chain clock live.
 *  Unknown is treated exactly like stale — the bot never guesses past a missing fact. */
export const freshness = (state: GameState, now_ms: number): Freshness => {
  if (!state.connected) return Object.freeze({ ok: false, reason: 'link not authenticated' })
  if (state.frozen === null) return Object.freeze({ ok: false, reason: 'gameplay state unknown' })
  if (state.frozen) return Object.freeze({ ok: false, reason: 'gameplay frozen by the server' })
  if (state.indexing_lag === null) return Object.freeze({ ok: false, reason: 'indexing lag unknown' })
  if (state.indexing_lag > MAX_INDEXING_LAG)
    return Object.freeze({ ok: false, reason: `indexing lag ${state.indexing_lag} > ${MAX_INDEXING_LAG}` })
  if (chain_now(state.chain_clock, now_ms) === null) return Object.freeze({ ok: false, reason: 'chain clock stale' })
  return Object.freeze({ ok: true })
}

/** The character the bot drives: the configured id when set, else the first row in the roster the
 *  signer owns. Returns null while the roster is empty (the server has not pushed it yet). */
export const select_character = (state: GameState, preferred_id: string | null): CharacterRow | null => {
  if (preferred_id) return state.characters.find(({ id }) => id === preferred_id) ?? null
  return state.characters[0] ?? null
}

/** Ids the kiosk cannot hand out for a fresh extraction (equip / burn / a deposit target): the
 *  account's ACTIVE market listings — re-`list`ing aborts `dynamic_field::add` (`EFieldAlreadyExists`,
 *  code 0) — and every item already worn by one of our characters — it has left the kiosk for that
 *  character's address, so `kiosk::list` reports `EItemNotFound` (code 11). The ONE flat
 *  `packet/inventory` still carries both, so every door that pulls an item out of the kiosk must
 *  exclude them (equip, craft burn, gather deposit target). */
export const unavailable_item_ids = (state: GameState): ReadonlySet<string> => {
  const ids = new Set<string>(state.listings.map((row) => row.id))
  for (const character of state.characters) for (const worn of character.equipment) ids.add(worn.id)
  return ids
}

export const select_zone = (state: GameState, world: string, zx: number, zz: number): ZoneRow | null =>
  state.zones.find((zone) => zone.world === world && zone.zx === zx && zone.zz === zz) ?? null

/** The mob groups still standing in one zone: the seed's population minus the consumed bits. */
export const select_live_mob_groups = (state: GameState, world: string, zx: number, zz: number): readonly MobGroupRow[] => {
  const spawns = state.zone_spawns[zone_key(world, zx, zz)]
  const zone = select_zone(state, world, zx, zz)
  if (!spawns || !zone) return Object.freeze([])
  return live_mob_groups(spawns.mobs, zone)
}

/** The resource packs still standing in one zone, each carrying its remaining node count. */
export const select_live_resource_packs = (
  state: GameState,
  world: string,
  zx: number,
  zz: number
): readonly ResourcePackRow[] => {
  const spawns = state.zone_spawns[zone_key(world, zx, zz)]
  const zone = select_zone(state, world, zx, zz)
  if (!spawns || !zone) return Object.freeze([])
  return live_resource_packs(spawns.resources, zone)
}

/** Every live mob group across the tracked window, tagged with the zone it stands in. */
export const select_window_mob_groups = (
  state: GameState
): readonly Readonly<{ zone: ZoneRow; group: MobGroupRow }>[] => {
  const rows: Readonly<{ zone: ZoneRow; group: MobGroupRow }>[] = []
  for (const zone of state.zones) {
    const spawns = state.zone_spawns[zone_key(zone.world, zone.zx, zone.zz)]
    if (!spawns) continue
    for (const group of live_mob_groups(spawns.mobs, zone)) rows.push(Object.freeze({ zone, group }))
  }
  return Object.freeze(rows)
}

/** Every live resource pack across the tracked window, tagged with the zone it stands in. */
export const select_window_resource_packs = (
  state: GameState
): readonly Readonly<{ zone: ZoneRow; pack: ResourcePackRow }>[] => {
  const rows: Readonly<{ zone: ZoneRow; pack: ResourcePackRow }>[] = []
  for (const zone of state.zones) {
    const spawns = state.zone_spawns[zone_key(zone.world, zone.zx, zone.zz)]
    if (!spawns) continue
    for (const pack of live_resource_packs(spawns.resources, zone)) rows.push(Object.freeze({ zone, pack }))
  }
  return Object.freeze(rows)
}

/** The character's chain-proven checkpoint string, or null when it has no usable checkpoint. */
export const checkpoint_of = (character: CharacterRow): string | null => character_checkpoint(character)

/** The travel gate the chain twin (`world_map::travel_ok`) enforces: enough time has banked since
 *  the last proven checkpoint to cover the leg. The bot waits on this before acting at distance. */
export const travel_ready = (
  character: CharacterRow,
  to_x: number,
  to_z: number,
  now_ms: number,
  pet_now: boolean
): boolean => {
  if (character_checkpoint(character) === null) return false
  return travel_proof_ready({
    from_x: character.x!,
    from_z: character.z!,
    from_ms: character.at_ms ?? 0,
    pet_at_start: character.pet ?? false,
    to_x,
    to_z,
    now_ms,
    pet_now,
  })
}

/** The id of the fight the character is currently seated in, or null. */
export const active_fight_of = (character: CharacterRow): string | null => character.active_fight?.id ?? null
