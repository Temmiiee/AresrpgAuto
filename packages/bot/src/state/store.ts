// The bot's ONE duplicate-readable live projection. It folds the authenticated server push
// stream into a frozen snapshot the play loop consults before every decision. It holds FACTS the
// server sent (roster, inventory, world, fight stream, chain clock) and nothing derived — live
// mob groups, resource packs, freshness, and travel budgets are selectors (state/selectors.ts).
//
// The fold is pure: `reduce(state, input) => state`. No timers, no I/O, no reads of module
// globals beyond the packet's own fields. Timestamped facts carry the wall-clock instant they
// landed so a selector can age them honestly.
import {
  type CharacterRow,
  type ClosableFightRow,
  type FightResolutionRow,
  type FightRow,
  type FightStateRow,
  type ItemRow,
  type ListingRow,
  type MasteryOfferRow,
  type MasteryRow,
  type MobGroupRow,
  type ResourcePackRow,
  type ServerPacket,
  type ZoneRow,
} from '@aresrpg/protocol'

/** The chain clock: the latest chain timestamp plus the local instant the sample landed, already
 *  corrected by the server-reported sample age (chain_clock.ts law). */
export type ChainClock = Readonly<{ chain_ms: number; received_ms: number }> | null

/** A tracked zone's seed-derived population (a pure function of the seed) — sent once per seed. */
export type ZoneSpawns = Readonly<{ mobs: readonly MobGroupRow[]; resources: readonly ResourcePackRow[] }>

export type TrackedWindow = Readonly<{
  character_id: string
  world: string
  zones: readonly Readonly<{ zx: number; zz: number }>[]
}>

export type GameState = Readonly<{
  /** true only while a socket is authenticated (the freshness gate reads this) */
  connected: boolean
  characters: readonly CharacterRow[]
  inventory: readonly ItemRow[]
  /** the player's own ACTIVE market listings (item id → LISTED_IN edge). A listed item still
   *  appears in `inventory` but cannot be `kiosk::list`ed again, so it must never be selected
   *  for extraction (equip / craft); the equip PTB would abort in `dynamic_field::add`. */
  listings: readonly ListingRow[]
  /** the tracked zone window's mutable rows (consumption bitmaps) */
  zones: readonly ZoneRow[]
  /** seed population per zone, keyed `world:zx:zz` */
  zone_spawns: Readonly<Record<string, ZoneSpawns>>
  /** the tracked spiral window, replaced whole on every `packet/tracked_zones` */
  tracked: TrackedWindow | null
  fights: readonly FightRow[]
  /** latest raw projected fight per id — the hydration door for the fight runtime */
  fight_states: Readonly<Record<string, FightStateRow>>
  /** the relay's wall-clock witness of each fight's start (ms) */
  fights_started_ms: Readonly<Record<string, number>>
  resolutions: readonly FightResolutionRow[]
  closable: readonly ClosableFightRow[]
  chain_clock: ChainClock
  indexing_lag: number | null
  frozen: boolean | null
  online: number | null
  last_error: Readonly<{ reason: string; id: number | null }> | null
  /** every packet folded so far — a cheap liveness counter for the CLIs */
  packets_seen: number
  /** daily/epoch mastery dungeon quest (if active) */
  mastery: MasteryRow | null
  /** mastery shop offers */
  mastery_offers: readonly MasteryOfferRow[]
}>

export const initial_game_state: GameState = Object.freeze({
  connected: false,
  characters: Object.freeze([]),
  inventory: Object.freeze([]),
  listings: Object.freeze([]),
  zones: Object.freeze([]),
  zone_spawns: Object.freeze({}),
  tracked: null,
  fights: Object.freeze([]),
  fight_states: Object.freeze({}),
  fights_started_ms: Object.freeze({}),
  resolutions: Object.freeze([]),
  closable: Object.freeze([]),
  chain_clock: null,
  indexing_lag: null,
  frozen: null,
  online: null,
  last_error: null,
  packets_seen: 0,
  mastery: null,
  mastery_offers: Object.freeze([]),
})

export type StoreInput =
  | Readonly<{ kind: 'packet'; packet: ServerPacket }>
  /** the socket dropped — the chain clock must expire rather than lie */
  | Readonly<{ kind: 'link_lost' }>

export const zone_key = (world: string, zx: number, zz: number): string => `${world}:${zx}:${zz}`
export const zone_key_of = (row: Readonly<{ world: string; zx: number; zz: number }>): string =>
  zone_key(row.world, row.zx, row.zz)

const chain_clock_from = (
  previous: ChainClock,
  packet: Extract<ServerPacket, { type: 'packet/server_info' }>,
  received_ms: number
): ChainClock => {
  const chain_ms = Number(packet.chain_timestamp_ms)
  // The server reports the sample age with sub-millisecond precision. Keep the clock integer-valued:
  // `chain_now` feeds `travel_proof_ready`, whose `Number.isSafeInteger(now_ms)` guard rejects a
  // fractional `now_ms` outright — so a fractional sample age silently froze EVERY leg (the bot
  // could not walk, gather or engage, and it looked exactly like an indexer/network stall).
  const sample_age_ms = Math.floor(packet.chain_sample_age_ms ?? 0)
  const valid = [Number.isFinite(sample_age_ms), sample_age_ms >= 0, Number.isSafeInteger(chain_ms), chain_ms > 0].every(
    Boolean
  )
  if (!valid) return null
  // A stale sample may not rewind interpolation: keep the newer estimate.
  if (previous && chain_ms <= previous.chain_ms) return previous
  return Object.freeze({ chain_ms, received_ms: received_ms - sample_age_ms })
}

const upsert_by = <T extends { id: string }>(rows: readonly T[], row: T): readonly T[] => {
  const index = rows.findIndex((existing) => existing.id === row.id)
  if (index < 0) return Object.freeze([...rows, row])
  const next = [...rows]
  next[index] = row
  return Object.freeze(next)
}

const upsert_zone = (rows: readonly ZoneRow[], row: ZoneRow): readonly ZoneRow[] => {
  const index = rows.findIndex((existing) => zone_key_of(existing) === zone_key_of(row))
  if (index < 0) return Object.freeze([...rows, row])
  const next = [...rows]
  next[index] = row
  return Object.freeze(next)
}

const upsert_fight = (rows: readonly FightRow[], row: FightRow): readonly FightRow[] => {
  const index = rows.findIndex((existing) => existing.id === row.id)
  if (index < 0) return Object.freeze([...rows, row])
  const next = [...rows]
  next[index] = row
  return Object.freeze(next)
}

const reduce_packet = (state: GameState, packet: ServerPacket): GameState => {
  const seen = state.packets_seen + 1
  switch (packet.type) {
    case 'packet/characters':
      return { ...state, characters: Object.freeze(packet.characters), packets_seen: seen }
    case 'packet/inventory':
      return { ...state, inventory: Object.freeze(packet.items), packets_seen: seen }
    case 'packet/listings':
      return { ...state, listings: Object.freeze(packet.listings), packets_seen: seen }
    case 'packet/item_updated':
      return { ...state, inventory: upsert_by(state.inventory, packet.item), packets_seen: seen }
    case 'packet/item_removed':
      return {
        ...state,
        inventory: Object.freeze(state.inventory.filter((item) => item.id !== packet.item)),
        packets_seen: seen,
      }
    case 'packet/tracked_zones':
      return {
        ...state,
        tracked: Object.freeze({
          character_id: packet.character_id,
          world: packet.world,
          zones: Object.freeze(packet.zones.map((zone) => Object.freeze({ zx: zone.zx, zz: zone.zz }))),
        }),
        zones: Object.freeze(state.zones.filter((zone) => zone.world === packet.world)),
        packets_seen: seen,
      }
    case 'packet/zones':
      return { ...state, zones: packet.zones.reduce(upsert_zone, state.zones), packets_seen: seen }
    case 'packet/zone_spawns':
      return {
        ...state,
        zone_spawns: Object.freeze({
          ...state.zone_spawns,
          [zone_key(packet.world, packet.zx, packet.zz)]: Object.freeze({
            mobs: Object.freeze(packet.mobs),
            resources: Object.freeze(packet.resources),
          }),
        }),
        packets_seen: seen,
      }
    case 'packet/fights':
      return { ...state, fights: Object.freeze(packet.fights), packets_seen: seen }
    case 'packet/fight_created':
      return { ...state, fights: upsert_fight(state.fights, packet.fight), packets_seen: seen }
    case 'packet/fight_phase':
      return {
        ...state,
        fights: Object.freeze(
          state.fights.map((fight) => (fight.id === packet.fight ? { ...fight, phase: packet.phase } : fight))
        ),
        packets_seen: seen,
      }
    case 'packet/fight_resolutions':
      return { ...state, resolutions: Object.freeze(packet.resolutions), packets_seen: seen }
    case 'packet/closable_fights':
      return { ...state, closable: Object.freeze(packet.fights), packets_seen: seen }
    case 'packet/fight_state':
      return {
        ...state,
        fight_states: Object.freeze({ ...state.fight_states, [packet.fight]: packet.state }),
        packets_seen: seen,
      }
    case 'packet/fight_started': {
      const at_ms = Number(packet.started_ms)
      return {
        ...state,
        fights_started_ms: Object.freeze({
          ...state.fights_started_ms,
          [packet.fight]: Number.isSafeInteger(at_ms) ? at_ms : Date.now(),
        }),
        packets_seen: seen,
      }
    }
    case 'packet/fight_ended':
      return { ...state, packets_seen: seen }
    case 'packet/server_info':
      return {
        ...state,
        chain_clock: chain_clock_from(state.chain_clock, packet, Date.now()),
        indexing_lag: packet.indexing_lag,
        online: packet.online,
        packets_seen: seen,
      }
    case 'packet/game_state':
      return { ...state, frozen: packet.frozen, packets_seen: seen }
    case 'packet/connection_accepted':
      return { ...state, connected: true, packets_seen: seen }
    case 'packet/error':
      return {
        ...state,
        last_error: Object.freeze({ reason: packet.reason, id: packet.id ?? null }),
        packets_seen: seen,
      }
    case 'packet/mastery':
      return {
        ...state,
        mastery: packet.mastery,
        mastery_offers: Object.freeze(packet.offers ?? []),
        packets_seen: seen,
      }
    default:
      // Every other server packet is folded by a domain the bot does not drive
      // (market, party, trade, chat, dungeon, …). It still proves liveness.
      return { ...state, packets_seen: seen }
  }
}

export const reduce = (state: GameState, input: StoreInput): GameState => {
  if (input.kind === 'link_lost') return { ...state, connected: false, chain_clock: null }
  return reduce_packet(state, input.packet)
}
