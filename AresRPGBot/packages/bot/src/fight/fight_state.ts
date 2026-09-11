// Raw on-chain fight JSON: normalizing the live shape, reading a fight object, and the small
// cross-phase types (Position/MobInfo/FightOutcome) every other fight/*.ts module needs. Kept
// separate from fight_session.ts (the orchestrator) so fight_progression.ts, fight_discovery.ts,
// fight_turn.ts, and fight_settle.ts can all depend on this one, low-level module without any of
// them depending on each other through it.
import type { BotSdk } from '../auth/sdk_client.ts'
import { sleep } from '../shared/chain_retry.ts'

// `stats` sits at the TOP LEVEL of every fighter (player and mob alike) -- NOT nested under
// `kind.pos0` as this type assumed until 2026-09-05. Confirmed live via a raw JSON dump: a mob's
// `kind.pos0` only ever carried build/loot data (kit/level/loot/mob_type/xp), never max_hp or any
// resistance; those, plus base_ap/base_mp and the stat sheet, live in this shared `stats` object,
// with full resistance names (earth_resistance, not earth_res). Reading pos0.max_hp/pos0.earth_res
// (the old code) silently produced NaN in finish_bonus/element_bonus for every live fight, ever
// since those were written -- no crash, just corrupted candidate scores nobody noticed because
// NaN-tainted comparisons just fall through to something else looking equally arbitrary.
export type FighterStatsJson = {
  max_hp: string | number
  base_ap: string | number
  base_mp: string | number
  earth_resistance: string | number
  fire_resistance: string | number
  water_resistance: string | number
  air_resistance: string | number
  sheet: { agility: string | number; wisdom: string | number }
}
export type FighterJson = {
  team: number
  cell: string | number
  hp: string | number
  mp: string | number
  ap: string | number
  ready: boolean
  settled: boolean
  stats?: FighterStatsJson
  kind: {
    '@variant': string
    character?: string
    pos0?: {
      level?: string | number
      mob_type?: string
      xp?: string | number
      loot?: { item_type: string; chance_bp: string | number }[]
    }
  }
}
export type FightJson = {
  fighters: FighterJson[]
  queue: (string | number)[]
  turn_ptr: string | number
  turn_started_ms: string | number
  ended: boolean
  winner: number | null
  x: number
  z: number
  closed: (string | number)[]
  board: { obstacles: (string | number)[] }
}

export const as_number = (v: string | number): number => (typeof v === 'number' ? v : Number(v))

// The live Fight object's REAL on-chain shape (2026-09-05, after the fight.move rewrite):
// fighters/board/closed/ended/queue/round/winner/turn_seed/turn_started_ms all moved under a
// nested `combat` object instead of sitting at the top level, `turn_ptr` was renamed
// `turn_pointer`, and each fighter's `kind` no longer carries `character`/`owner` inline for
// players -- that now lives in a PARALLEL top-level `authorities` array, matched by the same
// index as `combat.fighters`. Every caller in fight/*.ts was written against the OLD flat shape,
// so this normalizes at the one boundary where raw chain JSON enters the system instead of
// touching every call site -- confirmed live: a real fight's raw JSON has zero top-level
// `fighters`, crashing `fighter_indices` with "undefined is not an object (evaluating
// 'fight.fighters.forEach')".
type RawAuthority = { '@variant': string; character?: string; owner?: string }
type RawFightJson = {
  x: number
  z: number
  authorities?: RawAuthority[]
  combat: {
    fighters: FighterJson[]
    board: { obstacles: (string | number)[] }
    closed: (string | number)[]
    ended: boolean
    winner: number | null
    queue: (string | number)[]
    turn_pointer: string | number
    turn_started_ms: string | number
  }
}
export const normalize_fight_json = (raw: RawFightJson): FightJson => ({
  x: raw.x,
  z: raw.z,
  ended: raw.combat.ended,
  winner: raw.combat.winner,
  queue: raw.combat.queue,
  turn_ptr: raw.combat.turn_pointer,
  turn_started_ms: raw.combat.turn_started_ms,
  closed: raw.combat.closed,
  board: raw.combat.board,
  fighters: raw.combat.fighters.map((f, idx) => {
    const authority = raw.authorities?.[idx]
    return authority?.character ? { ...f, kind: { ...f.kind, character: authority.character } } : f
  }),
})

// A fight object with no live dynamic fields can be closed (deleted) by any participant once
// everyone has settled — fight.move's `close()`. Nothing in this bot ever calls it, so a
// vanished fight_id means something ELSE closed it after we lost track (our own read of `ended`
// lagging behind the object's true latest version long enough that we kept polling a fight that
// had already concluded and been cleaned up). Distinguishing this from a real read failure lets
// the caller drop the dead fight_id instead of retrying it forever.
export class FightNotFoundError extends Error {}

const PROPAGATION_RETRY_DELAYS_MS = [500, 1_000, 2_000, 3_000]
export const read_fight = async (sdk: BotSdk['sdk'], fight_id: string): Promise<FightJson> => {
  for (let attempt = 0; ; attempt += 1) {
    const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [fight_id], include: { json: true } })
    const json = objects[0]?.json
    if (json) return normalize_fight_json(json as unknown as RawFightJson)
    const delay = PROPAGATION_RETRY_DELAYS_MS[attempt]
    if (delay === undefined)
      throw new FightNotFoundError(`Fight object ${fight_id} not found after propagation retries`)
    await sleep(delay)
  }
}

export const fighter_indices = (fight: FightJson): Map<string, number> => {
  const map = new Map<string, number>()
  fight.fighters.forEach((fighter, idx) => {
    if (fighter.kind['@variant'] === 'Player' && fighter.kind.character) map.set(fighter.kind.character, idx)
  })
  return map
}

export type Position = { x: number; z: number }
export type MobInfo = { mob_type: string; level: number }
export type FightOutcome = {
  won: boolean
  fight_id: string
  new_position: Position
  gas_mist: bigint
  xp_gained: Record<string, number>
  turns: number
  mobs: readonly MobInfo[]
  drops: Record<string, number>
}
