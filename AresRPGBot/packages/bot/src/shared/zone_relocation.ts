// Deterministic zone-level prediction and one-shot relocation toward a better zone.
// Mirrors aresrpg_math::zone_math (packages/move-math): a zone's mob level band is a pure
// function of its Chebyshev distance (in blocks) from the world centre — the bot can know a zone
// is beneath the party without any chain read, and can aim for the innermost zone whose top band
// still challenges the party. Walking reuses the exact travel gate the engine's engage proof
// uses (world_map::travel_ok, SPEED_BUDGET/SPEED_SCALE), so the same sleep that satisfies the
// pre-search walk also satisfies every later phase of the next fight.
import type { Position } from '../fight/fight_state.ts'
import { sleep } from './chain_retry.ts'

const ZONE_SIZE = 512
const WORLD_CENTER = 50_000
const LEVEL_RAMP_AT = 20_000
const LEVEL_LOW_CAP = 75
const LEVEL_HIGH_CAP = 100
// World is 100_000 units square, centre at 50_000: zone indices run 0..195.
const ZONE_MAX = Math.floor(100_000 / ZONE_SIZE) - 1
const STEP_CAP = 256

// Mirror of world_map::travel_ok's speed budget (1150 blocks per 100_000 ms) plus the same
// margin fight_discovery.ts uses before engaging a group. Exported so callers that need the
// budget's INVERSE (e.g. farm_migrate's chunked-leg projection) share one owner of the numbers.
export const TRAVEL_SPEED_BUDGET = 1150
export const TRAVEL_SPEED_SCALE = 100_000
export const TRAVEL_WAIT_MARGIN_MS = 4_000

// Mounted-pet speed (world.move PET_NUM/PET_DEN = 3/2 over the base budget — ×1.5, the same twin
// @aresrpg/protocol exposes as PET_SPEED_MULTIPLIER). The chain grants it ONLY across a leg whose
// checkpoint STARTED with a pet equipped (cp.pet) AND still has one now (equipment::pet_equipped);
// callers must fold that both-end truth themselves (read_pet_mounted) before scheduling a leg
// mounted — an honest unmounted plan is always provable, an assumed mount is not.
export const PET_SPEED_NUMERATOR = 3
export const PET_SPEED_DENOMINATOR = 2
export const PET_TRAVEL_SPEED_BUDGET = (TRAVEL_SPEED_BUDGET * PET_SPEED_NUMERATOR) / PET_SPEED_DENOMINATOR

// A zone must top out RELOCATE_MIN_GAP levels below the party average before a walk is worth it.
const RELOCATE_MIN_GAP = 2
// Aim for a zone whose max mob level sits roughly TARGET_HI_BONUS above the party average.
// Conservative on purpose (2026-09-13, live): with an untrained policy a party+6 band overshot —
// the party won fights there but the group RNG kept rolling sets that failed the 60% win floor,
// and the session stalled retrying a single too-hard zone. party+3 keeps the band within what the
// sim floor actually clears while still out-leveling a stale spawn zone. Bumped 4 with the trained
// policy (96/0 live record) and the pool screener — still low enough that winnable groups exist.
const TARGET_HI_BONUS = 4
// How many band levels a too-hard zone backs off per failure — small enough to correct usefully,
// large enough to move out of the dead zone decisively.
const INWARD_STEP = 3

export type ZoneLevels = { lo: number; hi: number }

export const zone_levels = (zone_x: number, zone_z: number): ZoneLevels => {
  const zx = Math.floor(zone_x)
  const zz = Math.floor(zone_z)
  const px = zx * ZONE_SIZE + ZONE_SIZE / 2
  const pz = zz * ZONE_SIZE + ZONE_SIZE / 2
  const distance = Math.max(Math.abs(px - WORLD_CENTER), Math.abs(pz - WORLD_CENTER))
  const capped = Math.min(distance, LEVEL_RAMP_AT)
  // zone_math::ramp floors (u64 integer division): from=0, to=LEVEL_*_CAP.
  return {
    lo: Math.floor((LEVEL_LOW_CAP * capped) / LEVEL_RAMP_AT),
    hi: Math.floor((LEVEL_HIGH_CAP * capped) / LEVEL_RAMP_AT),
  }
}

/** Chebyshev centre distance a zone would have — the quantity zone level bands ramp on. */
const centre_distance = (zone_x: number, zone_z: number): number =>
  Math.max(
    Math.abs(zone_x * ZONE_SIZE + ZONE_SIZE / 2 - WORLD_CENTER),
    Math.abs(zone_z * ZONE_SIZE + ZONE_SIZE / 2 - WORLD_CENTER)
  )

export const travel_time_ms = (from: Position, to: Position, mounted = false): number => {
  const speed = mounted ? PET_TRAVEL_SPEED_BUDGET : TRAVEL_SPEED_BUDGET
  return Math.ceil((Math.hypot(to.x - from.x, to.z - from.z) * TRAVEL_SPEED_SCALE) / speed) + TRAVEL_WAIT_MARGIN_MS
}

const zone_center = (zone_x: number, zone_z: number): Position => ({
  x: Math.min(100_000, zone_x * ZONE_SIZE + ZONE_SIZE / 2),
  z: Math.min(100_000, zone_z * ZONE_SIZE + ZONE_SIZE / 2),
})

/** The zone on the outward path whose level band tops out near the party's, or null when the
 *  current zone is not worth leaving (already at/above the party, or the world edge caps out too
 *  low). Pure math — no chain calls. Each step takes the in-bounds neighbour that strictly
 *  increases the Chebyshev centre distance, so the walk is monotone and can never oscillate;
 *  because even the world corners reach the level cap, the target is always reachable. */
export const seek_ideal_zone = (position: Position, party_average_level: number): Position | null => {
  const target_hi = Math.max(0, Math.min(party_average_level + TARGET_HI_BONUS, LEVEL_HIGH_CAP - 5))
  const start_x = Math.floor(position.x / ZONE_SIZE)
  const start_z = Math.floor(position.z / ZONE_SIZE)
  const current_hi = zone_levels(start_x, start_z).hi
  if (current_hi + RELOCATE_MIN_GAP >= party_average_level) return null
  if (current_hi >= target_hi) return null

  let wx = start_x
  let wz = start_z
  for (let steps = 0; steps < STEP_CAP; steps += 1) {
    const { hi } = zone_levels(wx, wz)
    if (hi >= target_hi) return zone_center(wx, wz)
    // First strictly-outer neighbour wins (deterministic; distance strictly increases each step).
    let next_x = wx
    let next_z = wz
    let best_distance = centre_distance(wx, wz)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = wx + dx
      const nz = wz + dz
      if (nx < 0 || nx > ZONE_MAX || nz < 0 || nz > ZONE_MAX) continue
      const distance = centre_distance(nx, nz)
      if (distance > best_distance) {
        best_distance = distance
        next_x = nx
        next_z = nz
      }
    }
    if (next_x === wx && next_z === wz) return null
    wx = next_x
    wz = next_z
  }
  return null
}

/** The outermost zone reachable by walking TOWARD the world centre whose top band is at or below
 *  target_max_hi — the highest-value zone this party's win floor can probably clear. Walks the
 *  axis with the larger centre delta one zone toward the centre per step (deterministic and
 *  stable: toward-centre directions never flip, unlike away-from-centre ones, so this never
 *  oscillates — and moving a single axis keeps advancing even on the Chebyshev plateaus along a
 *  world edge, where the dominant delta stays constant). Always terminates: the spawn band is 0.
 *  Returns null when the starting zone is already at or below the target. Pure math — no reads. */
export const seek_easier_zone = (position: Position, target_max_hi: number): Position | null => {
  const start_x = Math.floor(position.x / ZONE_SIZE)
  const start_z = Math.floor(position.z / ZONE_SIZE)
  if (zone_levels(start_x, start_z).hi <= target_max_hi) return null

  let wx = start_x
  let wz = start_z
  for (let steps = 0; steps < STEP_CAP; steps += 1) {
    const { hi } = zone_levels(wx, wz)
    if (hi <= target_max_hi) return zone_center(wx, wz)
    const cx = wx * ZONE_SIZE + ZONE_SIZE / 2
    const cz = wz * ZONE_SIZE + ZONE_SIZE / 2
    // Toward-centre steps are always in bounds (the centre zone is interior), so no clamping.
    if (Math.abs(cx - WORLD_CENTER) >= Math.abs(cz - WORLD_CENTER)) {
      wx += cx >= WORLD_CENTER ? -1 : 1
    } else {
      wz += cz >= WORLD_CENTER ? -1 : 1
    }
  }
  return zone_levels(wx, wz).hi <= target_max_hi ? zone_center(wx, wz) : null
}

/** Walks (sleeps the full travel gate) toward the first zone on our outward ray that challenges
 *  the party, returning the position to search there — or null when the current zone is fine.
 *  No transactions are spent moving: the next search_zone tx proves the walk from the position
 *  already recorded on-chain. For deterministic relocation the calling fight loop still waits
 *  travel_time_ms here, exactly as it waits before engaging an in-zone group. */
export const maybe_relocate_zone = async (
  position: Position,
  levels: Map<string, number>,
  log: (msg: string) => void,
  mounted = false
): Promise<Position | null> => {
  if (levels.size === 0) return null
  let sum = 0
  for (const level of levels.values()) sum += level
  const party_average = sum / levels.size
  const target = seek_ideal_zone(position, party_average)
  if (target === null) return null

  const from = zone_levels(Math.floor(position.x / ZONE_SIZE), Math.floor(position.z / ZONE_SIZE))
  const to = zone_levels(Math.floor(target.x / ZONE_SIZE), Math.floor(target.z / ZONE_SIZE))
  const blocks = Math.hypot(target.x - position.x, target.z - position.z)
  const wait_ms = travel_time_ms(position, target, mounted)
  log(
    `zone lv ${from.lo}..${from.hi} is beneath the party (avg lv ${party_average.toFixed(1)}) — walking ~${Math.round(blocks)} blocks to a zone topping out at lv ${to.hi} (≈${Math.ceil(wait_ms / 1000)}s)${mounted ? ' — riding a pet' : ''}…`
  )
  await sleep(wait_ms)
  return target
}

/** Counterpart of maybe_relocate_zone for zones that are TOO HARD: after the sim win floor (or
 *  the within-reach check) rejects every group, backs off inward to the outermost zone whose top
 *  band is at most party_level - 1 (capped at current_hi - INWARD_STEP), then returns the position
 *  to search there. Bound to at most party-1 on purpose so the outward relocation never re-fires
 *  and ping-pongs (outward needs current_hi + 3 < party; party-1 + 3 ≥ party). No transactions. */
export const maybe_back_off_zone = async (
  position: Position,
  levels: Map<string, number>,
  log: (msg: string) => void,
  mounted = false
): Promise<Position | null> => {
  if (levels.size === 0) return null
  let sum = 0
  for (const level of levels.values()) sum += level
  const party_average = sum / levels.size
  const zx = Math.floor(position.x / ZONE_SIZE)
  const zz = Math.floor(position.z / ZONE_SIZE)
  const current = zone_levels(zx, zz)
  // Inward target capped below by the zone level where the outward relocation stops firing:
  // relocation walks while current.hi + RELOCATE_MIN_GAP < party, i.e. it re-fires for any zone
  // weaker than ceil(party - RELOCATE_MIN_GAP). Backing off to anything weaker than that would
  // just get walked straight back out next fight — the ping-pong this whole module exists to
  // avoid. So: aim at party-1, never stronger than current-STEP, never weaker than party-GAP.
  const desired_hi = Math.min(current.hi - INWARD_STEP, Math.max(1, Math.ceil(party_average - 1)))
  const floor_hi = Math.max(1, Math.ceil(party_average - RELOCATE_MIN_GAP))
  const target_hi = Math.max(floor_hi, desired_hi)
  if (target_hi >= current.hi) return null

  const target = seek_easier_zone(position, target_hi)
  if (target === null) return null

  const to = zone_levels(Math.floor(target.x / ZONE_SIZE), Math.floor(target.z / ZONE_SIZE))
  const blocks = Math.hypot(target.x - position.x, target.z - position.z)
  const wait_ms = travel_time_ms(position, target, mounted)
  log(
    `nothing worth fighting here (lv ${current.lo}..${current.hi}) — backing off ~${Math.round(blocks)} blocks inward to a zone topping out at lv ${to.hi} (≈${Math.ceil(wait_ms / 1000)}s)${mounted ? ' — riding a pet' : ''}…`
  )
  await sleep(wait_ms)
  return target
}