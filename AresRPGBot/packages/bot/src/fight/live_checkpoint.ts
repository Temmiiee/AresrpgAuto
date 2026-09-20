// Converts the live on-chain Fight object's raw JSON into a full HydratedFightCheckpoint so
// lookahead.ts's rollout can run against a REAL in-progress fight, not just simulator-built
// ones. APPROXIMATE by design (ship-today tradeoff, 2026-09-01): no equipment/gear is read
// (weapon: null, folded_stats: neutral center — matches build_setup's own defaults when omitted)
// and spell levels are treated as the self-learned default (spell_levels: {}) — the SAME
// approximation spell_catalog.ts already makes everywhere else in this bot, not a new gap this
// file introduces. If a character actually has gear equipped or has raised spells, the rollout
// will underestimate their power; the caller (fight_session.ts) wraps every use of this in a
// try/catch with the existing tested greedy logic as a fallback, so a wrong assumption here
// degrades to "no worse than before," never a crash or a corrupted real decision.
import { create_character_source, player_max_hp } from '@aresrpg/fight'
import type {
  FightBoard,
  FightContract,
  Fighter,
  HydratedFightCheckpoint,
  KitSpell,
  MobLoot,
  MobSnapshot,
  SpellLevel,
  SpellEffect,
} from '@aresrpg/fight'

import { all_spell_sources } from '../ai/sim_content.ts'
import type { SimPartyMember } from '../ai/simulate.ts'

const SPELLS = all_spell_sources()

const as_bigint = (v: unknown, field = '?'): bigint => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  if (typeof v === 'string') return BigInt(v)
  throw new Error(`live_checkpoint: expected an integer for ${field}, got ${typeof v}`)
}
const as_bigint_array = (v: unknown): bigint[] => (Array.isArray(v) ? v.map((x) => as_bigint(x)) : [])
const record = (v: unknown): Record<string, unknown> => v as Record<string, unknown>

const to_spell_effect = (raw: unknown): SpellEffect => {
  const e = record(raw)
  return {
    kind: as_bigint(e.kind),
    element: String(e.element ?? ''),
    value: as_bigint(e.value),
    value_max: as_bigint(e.value_max ?? e.value),
    area_shape: as_bigint(e.area_shape ?? 0),
    area_size: as_bigint(e.area_size ?? 0),
    target_filter: as_bigint(e.target_filter ?? 0),
    chance_bp: as_bigint(e.chance_bp ?? 10_000),
    turns: as_bigint(e.turns ?? 0),
    stat: as_bigint(e.stat ?? 0),
  }
}
const to_spell_level = (raw: unknown): SpellLevel => {
  const l = record(raw)
  return {
    ap_cost: as_bigint(l.ap_cost),
    range_min: as_bigint(l.range_min),
    range_max: as_bigint(l.range_max),
    modifiable_range: Boolean(l.modifiable_range),
    line_of_sight: Boolean(l.line_of_sight),
    line_launch: Boolean(l.line_launch),
    free_cell: Boolean(l.free_cell),
    casts_per_turn: as_bigint(l.casts_per_turn ?? 0),
    casts_per_target: as_bigint(l.casts_per_target ?? 0),
    cooldown_turns: as_bigint(l.cooldown_turns ?? 0),
    crit_1_in: as_bigint(l.crit_1_in ?? 0),
    effects: Array.isArray(l.effects) ? l.effects.map(to_spell_effect) : [],
    crit_effects: Array.isArray(l.crit_effects) ? l.crit_effects.map(to_spell_effect) : [],
  }
}
const to_kit_spell = (raw: unknown): KitSpell => {
  const k = record(raw)
  return { name: String(k.name), ordinal: as_bigint(k.ordinal ?? 1), level: to_spell_level(k.level) }
}
const to_mob_loot = (raw: unknown): MobLoot => {
  const l = record(raw)
  return {
    item_type: String(l.item_type),
    chance_bp: as_bigint(l.chance_bp),
    min_qty: as_bigint(l.min_qty),
    max_qty: as_bigint(l.max_qty),
  }
}

// `kind.pos0` only ever carries build/loot data (kit/level/loot/mob_type/xp) -- max_hp, base
// ap/mp and every resistance live on the FIGHTER's own top-level `stats` object instead (shared
// shape with player fighters), with full resistance names (earth_resistance, not earth_res).
// Confirmed live via a raw JSON dump (2026-09-05): reading pos0.max_hp/pos0.earth_res (this file's
// previous assumption) was always undefined, throwing "expected an integer, got undefined" on
// every single turn and silently forcing the (still correct, just less accurate) greedy fallback
// for the whole fight.
const to_mob_snapshot = (pos0: unknown, stats: unknown, idx: number): MobSnapshot => {
  const p = record(pos0)
  const s = record(stats)
  const sheet = record(s.sheet)
  return {
    mob_type: String(p.mob_type ?? ''),
    level: as_bigint(p.level ?? 1),
    max_hp: as_bigint(s.max_hp, `fighters[${idx}].stats.max_hp`),
    ap: as_bigint(s.base_ap ?? 6),
    mp: as_bigint(s.base_mp ?? 3),
    agility: as_bigint(sheet.agility ?? 0),
    wisdom: as_bigint(sheet.wisdom ?? 0),
    earth_res: as_bigint(s.earth_resistance, `fighters[${idx}].stats.earth_resistance`),
    fire_res: as_bigint(s.fire_resistance, `fighters[${idx}].stats.fire_resistance`),
    water_res: as_bigint(s.water_resistance, `fighters[${idx}].stats.water_resistance`),
    air_res: as_bigint(s.air_resistance, `fighters[${idx}].stats.air_resistance`),
    kit: Array.isArray(p.kit) ? p.kit.map(to_kit_spell) : [],
    xp: as_bigint(p.xp ?? 0),
    loot: Array.isArray(p.loot) ? p.loot.map(to_mob_loot) : [],
  }
}

const to_board = (raw: unknown): FightBoard => {
  const b = record(raw)
  return {
    width: as_bigint(b.width ?? 20),
    height: as_bigint(b.height ?? 20),
    shape_mask: as_bigint_array(b.shape_mask),
    obstacles: as_bigint_array(b.obstacles),
    holes: as_bigint_array(b.holes),
    start_cells_a: as_bigint_array(b.start_cells_a),
    start_cells_b: as_bigint_array(b.start_cells_b),
  }
}

/** The contract's identity/access fields — split from the phase/turn fields below purely so
 *  neither literal drags live_state_to_checkpoint's cyclomatic over the repo ratchet. */
const to_contract_identity = (
  raw: Record<string, unknown>
): Pick<
  FightContract,
  'id' | 'world' | 'x' | 'z' | 'board' | 'closed' | 'access_a' | 'access_b' | 'opener_a' | 'opener_b'
> => ({
  id: String(raw.id ?? 'live'),
  world: String(raw.world ?? ''),
  x: as_bigint(raw.x ?? 0),
  z: as_bigint(raw.z ?? 0),
  board: to_board(raw.board),
  closed: as_bigint_array(raw.closed),
  access_a: as_bigint(raw.access_a ?? 0),
  access_b: as_bigint(raw.access_b ?? 255),
  opener_a: raw.opener_a ? String(raw.opener_a) : null,
  opener_b: raw.opener_b ? String(raw.opener_b) : null,
})

const to_contract_phase = (
  raw: Record<string, unknown>,
  fighters: Fighter[]
): Pick<
  FightContract,
  | 'fighters'
  | 'zones'
  | 'queue'
  | 'turn_ptr'
  | 'round'
  | 'ended'
  | 'winner'
  | 'dungeon'
  | 'dungeon_room'
  | 'managed'
  | 'wagered'
  | 'drops_rolled'
  | 'turn_seed'
  | 'turn_slot'
  | 'turn_casts'
  | 'placement_ms'
  | 'started_ms'
  | 'ended_ms'
  | 'turn_started_ms'
> => ({
  fighters,
  zones: [],
  queue: as_bigint_array(raw.queue),
  turn_ptr: as_bigint(raw.turn_ptr ?? 0),
  round: as_bigint(raw.round ?? 1),
  ended: Boolean(raw.ended),
  winner: raw.winner === null || raw.winner === undefined ? null : as_bigint(raw.winner),
  dungeon: null,
  dungeon_room: null,
  managed: Boolean(raw.managed),
  wagered: Boolean(raw.wagered),
  drops_rolled: Boolean(raw.drops_rolled),
  turn_seed: as_bigint(raw.turn_seed ?? 0),
  turn_slot: as_bigint(raw.turn_slot ?? 0),
  turn_casts: [],
  placement_ms: as_bigint(raw.placement_ms ?? 0),
  started_ms: null,
  ended_ms: null,
  turn_started_ms: as_bigint(raw.turn_started_ms ?? 0),
})

const to_fighters = (
  raw_fighters: unknown,
  sim_party_stats: ReadonlyMap<string, SimPartyMember>,
  sources: Record<string, ReturnType<typeof create_character_source>>
): Fighter[] => {
  const rows = Array.isArray(raw_fighters) ? raw_fighters : []
  const by_character = sources
  return rows.map((rf, idx) => {
    const f = record(rf)
    const kind_raw = record(f.kind)
    const variant = String(kind_raw['@variant'])
    const hp = as_bigint(f.hp, `fighters[${idx}].hp`)
    if (variant === 'Player') {
      const character = String(kind_raw.character)
      const member = sim_party_stats.get(character)
      if (!member) throw new Error(`live_checkpoint: no known stats for character ${character}`)
      if (!by_character[character])
        by_character[character] = create_character_source({
          classe: member.classe,
          level: BigInt(member.level),
          vitality: BigInt(member.vitality),
          wisdom: BigInt(member.wisdom),
          strength: BigInt(member.strength),
          intelligence: BigInt(member.intelligence),
          chance: BigInt(member.chance),
          agility: BigInt(member.agility),
          weapon: member.weapon ?? null,
          spell_levels: Object.fromEntries(
            Object.entries(member.spell_levels ?? {}).map(([name, lvl]) => [name, BigInt(lvl)])
          ),
          // folded_stats omitted on purpose — see file header.
        })
      return {
        team: as_bigint(f.team, `fighters[${idx}].team`),
        kind: { type: 'player', character, owner: String(kind_raw.owner ?? ''), level: BigInt(member.level) },
        cell: as_bigint(f.cell, `fighters[${idx}].cell`),
        ready: Boolean(f.ready),
        dead: hp <= 0n,
        settled: Boolean(f.settled),
        forfeited: Boolean(f.forfeited),
        hp,
        ap: as_bigint(f.ap, `fighters[${idx}].ap`),
        mp: as_bigint(f.mp, `fighters[${idx}].mp`),
        drops: [],
        effects: [],
        cooldowns: [],
      }
    }
    const snapshot = to_mob_snapshot(kind_raw.pos0, f.stats, idx)
    return {
      team: as_bigint(f.team, `fighters[${idx}].team`),
      kind: { type: 'mob', snapshot },
      cell: as_bigint(f.cell, `fighters[${idx}].cell`),
      ready: Boolean(f.ready),
      dead: hp <= 0n,
      settled: Boolean(f.settled),
      forfeited: Boolean(f.forfeited),
      hp,
      ap: as_bigint(f.ap, `fighters[${idx}].ap`),
      mp: as_bigint(f.mp, `fighters[${idx}].mp`),
      drops: [],
      effects: [],
      cooldowns: [],
    }
  })
}

/** Builds a full checkpoint from the live Fight object's raw JSON (the SAME shape read_fight
 *  already fetches — pass the parsed object straight through) plus what we already know about
 *  our own party's build (sim_party_stats, already maintained in fight_session.ts for the
 *  pre-engage simulated screening). Throws on any unexpected shape instead of guessing further
 *  — the caller is expected to catch and fall back. */
export const live_state_to_checkpoint = (
  raw_fight_json: unknown,
  sim_party_stats: ReadonlyMap<string, SimPartyMember>
): HydratedFightCheckpoint => {
  const raw = record(raw_fight_json)
  const sources: Record<string, ReturnType<typeof create_character_source>> = {}
  const fighters = to_fighters(raw.fighters, sim_party_stats, sources)
  const contract: FightContract = { ...to_contract_identity(raw), ...to_contract_phase(raw, fighters) }
  return { contract, sources: { players: sources, spells: SPELLS } }
}

export const live_max_hp_by_character = (sim_party_stats: ReadonlyMap<string, SimPartyMember>): Map<string, bigint> => {
  const result = new Map<string, bigint>()
  for (const [id, member] of sim_party_stats) {
    const source = create_character_source({
      classe: member.classe,
      level: BigInt(member.level),
      vitality: BigInt(member.vitality),
      wisdom: BigInt(member.wisdom),
      strength: BigInt(member.strength),
      intelligence: BigInt(member.intelligence),
      chance: BigInt(member.chance),
      agility: BigInt(member.agility),
      weapon: member.weapon ?? null,
    })
    result.set(id, player_max_hp(source))
  }
  return result
}
