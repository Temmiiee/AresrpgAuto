// First-discovery sweeping — the roamer's extra lever during a pass: claim still-undiscovered
// zones near the party.
//
// Why: every searched zone is a shared `0x2::dynamic_field::...`-free derived object (zone.move:
// `ZoneKey` under the World UID), created ONCE by whoever searches it first (zone.move::create,
// `fresh: true` in ZoneSearched). A fresh zone carries a FULL population — all its mob groups
// and resource packs untouched — which is exactly the "more monsters and resources" a drained
// zone no longer has, and the first discovery is a leaderboard category. A zone that already
// exists for whatever reason is simply skipped (someone else claimed it, or we already searched
// it before — the derived object id is stable, so existence is checkable offline with one
// batched getObjects over the whole candidate ring, free and gasless).
//
// Discovery costs EXACTLY one real transaction (zone.move::create, only when the zone is
// genuinely new) — the walk in between (world_map::prove_move at search time) uses the same
// travel-gate sleep relocation already relies on, so walking costs nothing but wall-clock.
//
// Band discipline: the sweep only claims zones the party would actually fight — band hi within
// the same target the relocation phase aims for (party_avg + TARGET_HI_BONUS) and not beneath
// the relocation floor (party_avg - RELOCATE_MIN_GAP) — so a claimed zone doesn't immediately
// get walked away from, and never stalls on a too-hard population either.
import type { BotSdk } from '../auth/sdk_client.ts'
import { living_content } from '@aresrpg/sdk'
import { zone_id, world_id } from '@aresrpg/sdk/seed-ids'
import type { Position } from '../fight/fight_state.ts'
import { message_of, sleep } from './chain_retry.ts'
import { zone_levels, travel_time_ms } from './zone_relocation.ts'
import { read_pet_mounted } from './pet_mount.ts'
import { LEADER, WORLD } from '../config/party_config.ts'

const ZONE_SIZE = 512
const WORLD_EDGE = 100_000
const ZONE_MAX = Math.floor(WORLD_EDGE / ZONE_SIZE) - 1
// Mirrors zone_relocation's band targets so a claimed zone is one the party actually farms
// (and the relocation phase won't immediately walk away from it).
const CLAIM_HI_BONUS = 4
const CLAIM_FLOOR_GAP = 3
// Search outer rings first only when the inner ones are exhausted: radius 1, then 2, then 3.
// A wider sweep reaches farther undiscovered zones per pass (fresh untouched populations the
// party then battles/harvests next expedition) while staying bounded so a sweep never marches
// for minutes on the off-chance of a claim.
const MAX_RING = 3

const zone_center = (zx: number, zz: number): Position => ({
  x: Math.min(WORLD_EDGE, zx * ZONE_SIZE + ZONE_SIZE / 2),
  z: Math.min(WORLD_EDGE, zz * ZONE_SIZE + ZONE_SIZE / 2),
})

const zone_of_xz = (position: Position): { zx: number; zz: number } => ({
  zx: Math.floor(position.x / ZONE_SIZE),
  zz: Math.floor(position.z / ZONE_SIZE),
})

/** Which of the given (zx, zz) zones already exist on-chain — one batched getObjects over their
 *  derived ids (the stable `ZoneKey` formula). Free: no transactions, no per-zone dry-runs. */
const read_zone_existence = async (
  sdk: BotSdk['sdk'],
  game_original: string,
  world: string,
  zones: readonly { zx: number; zz: number }[]
): Promise<ReadonlySet<string>> => {
  const { content_root } = living_content(sdk, 'Zone discovery sweep')
  const world_object = world_id(content_root, game_original, world)
  const { objects } = await sdk.sui_client.core.getObjects({
    objectIds: zones.map(({ zx, zz }) => zone_id(world_object, game_original, zx, zz)),
    include: { json: true },
  })
  const exist = new Set<string>()
  objects.forEach((object, i) => {
    if (object && !(object instanceof Error)) exist.add(`${zones[i]!.zx},${zones[i]!.zz}`)
  })
  return exist
}

/** One claim attempt per expedition: walks to the nearest undiscovered in-band zone and searches
 *  it as a first discovery. Returns the new position when something was claimed, else null
 *  (nothing new nearby, or someone was faster on the walk). Never throws on an already-taken
 *  zone — that's the ordinary happy-path miss, not a failure. */
export const discover_sweep = async (
  bot: BotSdk,
  position: Position,
  party_average_level: number,
  log: (msg: string) => void
): Promise<Position | null> => {
  const { sdk, character } = bot
  const game_original = sdk.game_type_package
  if (!game_original) throw new Error('Zone discovery sweep unavailable: pins.json has no original game package')

  const { zx: sx, zz: sz } = zone_of_xz(position)
  const target_hi = Math.max(0, Math.min(party_average_level + CLAIM_HI_BONUS, 95))
  const floor_hi = Math.max(0, Math.ceil(party_average_level - CLAIM_FLOOR_GAP))

  const ring_zones: { zx: number; zz: number }[] = []
  for (let radius = 1; radius <= MAX_RING; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
        const zx = sx + dx
        const zz = sz + dz
        if (zx < 0 || zx > ZONE_MAX || zz < 0 || zz > ZONE_MAX) continue
        const { hi } = zone_levels(zx, zz)
        if (hi > target_hi || hi < floor_hi) continue
        ring_zones.push({ zx, zz })
      }
    }
    if (ring_zones.length > 0) break
  }
  if (ring_zones.length === 0) return null

  const existing = await read_zone_existence(sdk, game_original, WORLD, ring_zones)
  const candidates = ring_zones
    .filter(({ zx, zz }) => !existing.has(`${zx},${zz}`))
    .sort((a, b) => Math.hypot(a.zx - sx, a.zz - sz) - Math.hypot(b.zx - sx, b.zz - sz))
  if (candidates.length === 0) {
    log(`discovery: no undiscovered in-band zone within ${MAX_RING} block(s) — ring all taken or out of band`)
    return null
  }

  const claim = candidates[0]!
  const target = zone_center(claim.zx, claim.zz)
  const { lo, hi } = zone_levels(claim.zx, claim.zz)
  // The leader does the walking — a mounted pet (both-end) shortens the claim walk ×1.5. A read
  // failure degrades to unmounted: the honest slow plan is always provable.
  let pet_mounted = false
  try {
    pet_mounted = await read_pet_mounted(bot, LEADER.id, WORLD)
  } catch (error) {
    log(`pet mount read failed (${message_of(error)}) — sweeping unmounted`)
  }
  const wait_ms = travel_time_ms(position, target, pet_mounted)
  log(
    `discovery: walking ~${Math.round(Math.hypot(target.x - position.x, target.z - position.z))} blocks to undiscovered zone (${claim.zx},${claim.zz}) (band lv ${lo}..${hi}) — ≈${Math.ceil(wait_ms / 1000)}s${pet_mounted ? ' (riding a pet)' : ''}…`
  )
  await sleep(wait_ms)

  try {
    await character.search_zone({
      character_id: LEADER.id,
      world: WORLD,
      x: Math.round(target.x),
      z: Math.round(target.z),
      refresh: false,
    })
    log(`discovery: ` + `NEW zone (${claim.zx},${claim.zz}) — first discovery claimed, fresh population (mobs + resources)`)
    return target
  } catch (error) {
    const message = message_of(error)
    if (/EObjectAlreadyExists|derived_object::claim/i.test(message)) {
      log(`discovery: zone (${claim.zx},${claim.zz}) was claimed by someone else on the walk — skipping`)
      return null
    }
    throw error
  }
}