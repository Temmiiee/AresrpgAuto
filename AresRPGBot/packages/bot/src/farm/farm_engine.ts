// The reusable gather + craft engine behind the job-farm and roaming CLIs.
//
// Encapsulates a full "harvest the besieged neighbourhood" phase: the per-character movement
// model, tool-holder roster derived from equipped tools, per-job tier ceilings, zone probe cache,
// in-zone/ring zone search, one harvest round across every session, and the craft pass that turns
// gathered materials into job XP (also the only path to XP for the non-producing professions).
// The caller supplies a BotSdk (created fresh per phase so the SDK's object-cache staleness that
// plagues long-lived instances — see cli_group_session's notes) never leaks between a battle
// phase and a harvest phase; movement is re-seeded from on-chain checkpoints at each create.
//
// Design notes (shared with the former cli_job_farm):
//  - Probes ride the chain's own gate order (gathering.move: prove_move -> ENoTool -> ETierLocked
//    -> roll). A reject aborts BEFORE consume_resource_node, and the SDK dry-run-rejects before
//    submitting, so a failed probe never costs gas, never consumes a node, and ENoTool vs
//    ETierLocked cleanly separates "this character has no X tool" (2203) from "it has the tool
//    but the pack's tier is above its job level" (2204).
//  - Ambushes (2%, protector_mob_type) are fought with the solo-validated machinery:
//    resolve_ambush -> ready (one seat starts it) -> run_turn_loop (empty commits for non-party
//    actors) -> settle_all; the character's checkpoint is wherever the fight left it.
//  - Movement budget (world_map.move: SPEED_SCALE/SPEED_BUDGET ms per world unit) accrues from
//    each character's own checkpoint; the local model tracks position + at_ms (root after a
//    move). ETravelTooFar (305/1724) just means wait for budget. ENothingThere (1302) during a
//    gather means the pack is drained (by us or someone else) - mark it and move on.
//  - The zone's resource_pack_at view aborts ENothingThere both past the last pack AND on a
//    fully-consumed mid-zone pack, so packs are enumerated once right after the search (fresh
//    zone, nothing consumed) with a consecutive-miss stop, and remaining-node counts are tracked
//    locally from then on.
//  - Crafting reuses the ingredient-stack batching proven in tool_craft.ts: one getObjects for
//    amounts, 1 kiosk id per ingredient type, output merged via the `existing` stack. Recipes
//    carry an explicit `job` in seed/content/recipes.json (flours/powders are 'resource'-category
//    recipes where content_rules falls back on the authored job), so recipes are read straight
//    from that file rather than through recipe_of(), which drops the job field. `water` is not
//    gatherable (mob drops only) - craft passes are opportunistic on it.
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { bcs } from '@mysten/sui/bcs'
import {
  craft_job_of,
  craft_required_level,
  gatherable_of,
  item_is_stackable,
  job_level_from_xp,
  max_tier_for_level,
  type GatheringJob,
} from '@aresrpg/immutable'
import { ZONE_RESEARCH_TTL_MS, ZONE_SIZE, zone_of } from '@aresrpg/protocol'
import { living_content } from '@aresrpg/sdk'
import { world_content_id, world_id as derive_world_id } from '@aresrpg/sdk/seed-ids'

import type { BotSdk } from '../auth/sdk_client.ts'
import { message_of, sleep, submit_with_retry } from '../shared/chain_retry.ts'
import { send_discord_embed } from '../shared/discord_notify.ts'
import { read_resource_pack, read_zone_searched_at, type ResourcePackView } from '../shared/zone_read.ts'
import { FARM_MIGRATE_MAX_TRAVEL_MS, chunked_landing, farm_regions, nearest_region, next_region } from './farm_migrate.ts'
import { PET_TRAVEL_SPEED_BUDGET } from '../shared/zone_relocation.ts'
import { read_equipped_items } from '../fight/equipped_weapon.ts'
import { PET_SLOT } from '../shared/pet_mount.ts'
import { read_sellable_items, type SellableItem } from '../market/kiosk_inventory.ts'
import { withdraw_listed_items_of_types } from '../market/withdraw_reserved_from_hdv.ts'
import {
  craft_starter_tool,
  gathering_job_of_tool,
  merge_recipe_ingredient_stacks,
  read_held_tools,
  STARTER_TOOL_OF_JOB,
} from '../forge/tool_craft.ts'
import {
  is_objective_recipe,
  min_craft_value_sui,
  order_craft_jobs,
  pending_objectives,
  read_craft_objectives_config,
  recipe_of_list,
  reserved_resources,
  select_craft_recipe,
} from '../shared/craft_objectives.ts'
import { get_item_price } from '../market/item_valuation.ts'
import { auto_equip_available_gear } from '../market/auto_equip.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import type { Position } from '../fight/fight_state.ts'
import { read_position } from '../state/position_state.ts'
import { fighter_indices, read_fight } from '../fight/fight_state.ts'
import { prepare_party } from '../fight/fight_progression.ts'
import { run_turn_loop } from '../fight/fight_turn.ts'
import { settle_all } from '../fight/fight_settle.ts'
import { read_character_checkpoint } from '../../../sdk/src/character_checkpoint.ts'
import { CHARACTERS, LEADER, WORLD } from '../config/party_config.ts'

// src/farm is 4 levels under the repo root, same depth as src/cli (dungeon_content.ts's
// "../../../../seed/content/..." path).
const RECIPES_PATH = fileURLToPath(new URL('../../../../seed/content/recipes.json', import.meta.url))
const ITEMS_PATH = fileURLToPath(new URL('../../../../seed/content/items.json', import.meta.url))

export const PRODUCING_JOBS = Object.freeze(['FARMER', 'HERBALIST', 'MINER']) as readonly GatheringJob[]

// world_map.move: budget accrues SPEED_SCALE/SPEED_BUDGET ms per world unit, from a character's
// own checkpoint at_ms. Same constants fight_discovery.ts uses for travel waits.
const SPEED_BUDGET = 1150
const SPEED_SCALE = 100_000
// Conservative upper-bound root (gather_time_ms(level 1) = 12s; higher job levels root shorter,
// so this is always safe) -- used in the local movement model after any prove_move-style touch.
const ROOT_MS = 12_000
// zone_math.move caps a zone at RES_PACKS_MAX=42 live packs; probe a little past that so a freshly
// created zone's full spread is never clipped, and stop after this many consecutive ENothingThere
// misses when the zone is partly consumed.
export const PACKS_PROBE_MAX = 48
const CONSECUTIVE_PACK_MISSES = 4

export const ROAM_RETRY_MS = 300_000
export const NAP_CHUNK_MS = 60_000
export const CRAFT_EVERY_GATHERS = 8
export const CRAFT_MAX_ATTEMPTS = 60
// 24/7 cadence: besides the gather threshold, a time-based craft pass keeps job xp flowing even
// while sessions wait between zone rerolls; a failed roam re-tries after this long instead of
// hot-looping read probes, and the loop naps in ≤60s chunks so that craft timer keeps firing.
export const CRAFT_EVERY_MS = 120_000

type RawRecipe = { output_type: string; inputs: Record<string, number>; job: string }

const read_recipes = (): RawRecipe[] => JSON.parse(readFileSync(RECIPES_PATH, 'utf8')) as RawRecipe[]

type RawItem = { item_type: string; name: string; category: string; level: number }

const read_items = (): RawItem[] => JSON.parse(readFileSync(ITEMS_PATH, 'utf8')) as RawItem[]

type DiscordLevelUp = { character_id: string; name: string; job: string; level: number; previous_level: number }

// The on-chain craft job of a recipe (craft_batch.move) is content_rules::craft_job_of(output
// category), falling back to the recipe's authored `job`. Replicated here so recipes whose seed
// job is null (all gear) still land under the profession that actually earns their xp.
const raw_item_category = new Map<string, string>(read_items().map((item) => [item.item_type, item.category]))

const raw_item_level = new Map<string, number>(read_items().map((item) => [item.item_type, item.level]))

// Gear the party can actually wear: armor, accessories and weapons — but NOT tools (handled by
// tool_craft.ts) nor pets/relics/titles. Used to make the craft pass prefer equippable gear over
// powders/compounds when the character's job level allows it — otherwise every pass burned the
// materials on a 7-slot powder recipe and gear (2-4 slots) never got crafted.
const GEAR_CATEGORIES = new Set<string>([
  'hat', 'cloak', 'belt', 'boots',
  'amulet', 'ring',
  'daggers', 'spear', 'bow', 'axe', 'sword',
])

const recipe_job = (recipe: RawRecipe): string => craft_job_of(raw_item_category.get(recipe.output_type) ?? '') ?? recipe.job

export type Movement = { x: number; z: number; at_ms: number; pet: boolean }
export type SpawnedPack = ResourcePackView & { remaining: number }
export type SpawnedZone = { zx: number; zz: number; packs: SpawnedPack[]; searched_at_ms: number | null }

export type Session = {
  c: (typeof CHARACTERS)[number]
  job: GatheringJob
  zone: SpawnedZone | null
  anchor: { x: number; z: number }
  done: boolean
  /** When this session may move again: a drained zone's reroll TTL expiry, or a roam retry. */
  waiting_until: number
  /** True when the last session_zone run found NOTHING farmable for this job anywhere in reach
   *  (no pack, no reseed pending). The job-farm CLI reads it to decide a region migration. */
  drained: boolean
}

export type FarmEngineDeps = {
  bot: BotSdk
  log: (msg: string) => void
  /** Written position when no checkpoint is readable (also the wrote-back anchor on exit). */
  initial?: Position
  /** Let a fully drained farm relocate to the next city region instead of napping through the 2h
   *  reseed. The roaming CLI leaves it off — roam moves the whole party by level band already. */
  migrate_on_drain?: boolean
}

export type FarmEngine = {
  sessions: Session[]
  movement: Map<string, Movement>
  craft_due: boolean
  holders: Map<GatheringJob, (typeof CHARACTERS)[number][]>
  max_tier: Map<string, Map<GatheringJob, number>>
  job_level: Map<string, Map<string, number>>
  locked_tiers: Map<string, Set<number>>
  gathers: number
  /** Craft passes that produced at least one item this engine's lifetime. */
  crafts_succeeded: number
  /** Craft passes admitted but unable to afford even one attempt's ingredients. */
  crafts_blocked: number
  /** Craft transactions that threw (submitted but aborted, or not submitted at all). */
  crafts_failed: number
  /** Ingredient shortfalls for each job's preferred target recipe (supply-run planner input). */
  missing_materials: () => Promise<Map<string, number>>
  refresh_holders: () => Promise<void>
  /** One harvest pass across EVERY character session. Returns the number of gathers landed. */
  harvest_round: () => Promise<number>
  craft_pass_if_due: () => Promise<void>
  refresh_capabilities: () => Promise<void>
  /** Walk the farm to the next city region when every session is drained (migrate_on_drain only).
   *  Claims the landing zone as a first discovery; re-anchors every session there. */
  relocate_if_stalled: () => Promise<{ relocated: boolean; target: Position | null }>
}

// Enoki freshness starts a new SDK per phase — but the engine still exposes enough state for a
// calling CLI to report on, and can be re-seated onto a fresh bot when that's needed.
export const create_farm_engine = async (
  deps: FarmEngineDeps
): Promise<FarmEngine> => {
  const { bot, log } = deps
  const migrate_on_drain = deps.migrate_on_drain ?? false
  // City regions the farm has migrated to this engine's lifetime — drives the rotation so a farm
  // moves thebes → the_ruins → fuwage → … instead of oscillating between two nearest regions.
  const migrated = new Set<string>()

  // Every read RPC in this engine goes through the same transient-safe path as writes: a bursty
  // public-RPC 429 (RESOURCE_EXHAUSTED) is pure backpressure, not a bug, and an unhandled reject
  // from one killed the whole farm live — grpc-web "Too Many Requests" on a BatchGetObjects right
  // after the startup tool checks. submit_with_retry retries with backoff and only rethrows a
  // genuinely persistent failure.
  const read = <T>(action: () => Promise<T>): Promise<T> => submit_with_retry(action, log)

  const { content_root, seed_package_original } = await read(() =>
    Promise.resolve(living_content(bot.sdk, 'Farm engine session'))
  )
  const game_original = bot.sdk.game_type_package!
  const world_content = world_content_id(content_root, seed_package_original, WORLD)
  const world = derive_world_id(content_root, game_original, WORLD)
  await read(() => bot.sdk.hydrate_unknown([world, world_content]))

  // Per-character movement model. A fresh boot presumes every character was rooted long ago; a
  // character still rooted from a previous session is caught by ETravelTooFar and re-slept.
  const initial = deps.initial ?? read_position()
  const movement = new Map<string, Movement>()
  // Per-character pet-equip snapshot (the "pet" slot of the EquipmentKey) — the bot never equips or
  // unequips pets mid-session, so the chain's `pet_now` equals this for every leg the engine walks
  // itself, and the movement model mirrors prove_move's `cp.pet = pet_now` after each move.
  const pet_equipped = new Map<string, boolean>()
  for (const c of CHARACTERS) {
    const checkpoint = await read(() =>
      read_character_checkpoint(bot.sdk.sui_client.core as never, bot.sdk.game_type_package, c.id, WORLD)
    ).catch((error) => error)
    const worn = await read(() => read_equipped_items(bot.sdk as never, c.id)).catch((error) => {
      log(`${c.name}: pet-equip read failed (${message_of(error)}) — this leg planned unmounted`)
      return []
    })
    const equipped = worn.some((row) => row.slot === PET_SLOT)
    pet_equipped.set(c.id, equipped)
    // `pet` = the ×1.5 both-end truth for the FIRST leg from this boot: pet was on at the last
    // checkpoint (cp.pet) AND is on now. After the first proved move it flips to `equipped`.
    movement.set(c.id, {
      x: checkpoint?.x ?? initial.x,
      z: checkpoint?.z ?? initial.z,
      at_ms: Date.now(),
      pet: (checkpoint?.pet ?? false) && equipped,
    })
  }

  let holders = new Map<GatheringJob, (typeof CHARACTERS)[number][]>()
  const stack_pins = new Map<string, { id: string; kiosk_id: string }>()
  const locked_tiers = new Map<string, Set<number>>()
  // Per (character, job) the highest pack tier that character's job level can reach — the ceiling
  // the harvest round farms UP TO, so the fewest, most valuable gathers buy the xp.
  const max_tier = new Map<string, Map<GatheringJob, number>>()
  // Per (character, job) the raw job level (from job_level_from_xp) — used to gate which craft
  // recipes the character can afford, so the pass never wastes a dry-run on a level abort.
  const job_level = new Map<string, Map<string, number>>()
  let shelf: { items: readonly SellableItem[] } | null = null
  let gathers = 0
  let gathers_since_craft = 0
  let crafts_succeeded = 0
  let crafts_blocked = 0
  let crafts_failed = 0

  // XpReader — same local-widening convention as spell_book.ts/kiosk_listings.ts: the bot reads
  // dynamic fields through the gRPC-core pair core.getDynamicField + core.listDynamicFields
  // (item_snapshot.ts is the reference), NOT the v1 REST name getDynamicFieldObject.
  type XpReader = {
    getDynamicField: (input: {
      parentId: string
      name: Readonly<{ type: string; bcs: Uint8Array }>
    }) => Promise<{
      dynamicField: { value: { bcs: Uint8Array } }
    }>
  }

  // Reads a character's on-chain xp for a gathering job — progression.move's JobXpKey dynamic
  // field on the character, whose value is an inline u64 (the field's BCS value bytes ARE the
  // 8-byte u64). Absent field = zero xp = level 1. This is the cheapest truthful signal for
  // "how high a tier can this character farm" — max_tier_for_level below inverts the same
  // tier_unlock_level law the farming move enforces.
  const read_job_xp = async (character_id: string, job: string): Promise<number> => {
    const type_package = bot.sdk.game_type_package
    if (!type_package) return 0
    const core = bot.sdk.sui_client.core as unknown as XpReader
    const name = Object.freeze({
      type: `${type_package}::progression::JobXpKey`,
      // JobXpKey is a positional struct whose only field is the String — the key bytes ARE the
      // wrapped String's bytes, so serialize the job label directly.
      bcs: bcs.String.serialize(job).toBytes(),
    })
    try {
      const { dynamicField } = await core.getDynamicField({ parentId: character_id, name })
      return Number(bcs.u64().parse(dynamicField.value.bcs))
    } catch (error) {
      // Absent key = 0 xp = the level-1 floor. Anything else must not degrade to a silent 0 —
      // a broken read here wrong pinched every character to tier 1 once (the v1 getDynamicFieldObject
      // name that this gRPC core does not implement threw on every call).
      if (!/not found|does not exist|no dynamic field/i.test(message_of(error)))
        console.warn(`  [xp] ${character_id} ${job}: ${message_of(error)} — assuming level 1`)
      return 0
    }
  }

  // Recipes by the craft job that actually earns their xp (recipe_job above), straight from the
  // seed file — gear recipes without an authored job land under their category's profession.
  const all_recipes = read_recipes()
  const recipes_by_job = new Map<string, RawRecipe[]>()
  for (const recipe of all_recipes) {
    const job = recipe_job(recipe)
    if (!job) continue // no category mapping and no authored job — nothing trains a job here
    const bucket = recipes_by_job.get(job) ?? []
    bucket.push(recipe)
    recipes_by_job.set(job, bucket)
  }
  const craft_jobs = (): readonly string[] => [...recipes_by_job.keys()].sort()

  // Craft-objective drive (craft_objectives.local.json). While a target is pending, its recipe's
  // ingredients are RESERVED from every other craft (so a party holding gnawed_branch can't burn
  // them on old_hoe while a pickaxe is the goal), its own recipe is crafted first once doable,
  // and missing_materials reports its shortfall so the roamer farms exactly those mats. The
  // configured value floor also stops the pass spending materials + SUI on junk gear
  // (lorito_hat__molted), and job_priority orders which craft-job pass spends first.
  const objectives_config = read_craft_objectives_config()
  const craft_value_floor = min_craft_value_sui(objectives_config)
  // The craft job a recipe trains (output category -> profession, authored job fallback). Recipes
  // pulled straight from the seed don't all carry a usable job for gear, so map once up front.
  const craft_job_of_output = new Map<string, string>(all_recipes.map((r) => [r.output_type, recipe_job(r)]))
  // Non-stackable outputs crafted this session — an equipped tool left the kiosk but is still
  // "owned", so it must satisfy (and un-reserve) a tool objective.
  const crafted_non_stackable = new Map<string, number>()
  // Tools equipped BEFORE this session: they live on the characters' own addresses (equip sends
  // the item out of the kiosk), so a kiosk+session-craft count alone reports an already-worn
  // quartzbound_pickaxe as "owned: 0" and the objective would stay pending (and keep reserving +
  // re-crafting its mats) forever. Captured once from read_held_tools at startup — the roster is
  // static for the session, so a fresh count only matters if the roster changes.
  const equipped_tools_owned = new Map<string, number>()

  // Party-owned quantity per item_type: kiosk stack amounts, plus non-stackables crafted in this
  // session, plus tools already equipped before the session. The needle for objective completion /
  // reservation.
  const owned_of = (items: readonly SellableItem[], amount_of: ReadonlyMap<string, number>): Map<string, number> => {
    const owned = new Map<string, number>()
    for (const item of items) {
      owned.set(item.item_type, (owned.get(item.item_type) ?? 0) + (amount_of.get(item.id) ?? 0))
    }
    for (const [output_type, count] of crafted_non_stackable) {
      owned.set(output_type, (owned.get(output_type) ?? 0) + count)
    }
    for (const [output_type, count] of equipped_tools_owned) {
      owned.set(output_type, (owned.get(output_type) ?? 0) + count)
    }
    return owned
  }

  // Is a recipe worth the party's materials? Same laws as select_craft_recipe's valuable bucket:
  // equippable gear/keys whose estimated SUI price clears the floor (junk excluded), gear further
  // capped at the party combat level so we never forge gear nobody can wear yet.
  const passes_value_gate = (recipe: RawRecipe, max_party_level: number): boolean => {
    const category = raw_item_category.get(recipe.output_type) ?? ''
    const is_gear = GEAR_CATEGORIES.has(category)
    if (!is_gear && category !== 'key') return false
    if (is_gear && (raw_item_level.get(recipe.output_type) ?? 0) > max_party_level) return false
    return get_item_price(recipe.output_type).unit_price_sui >= craft_value_floor
  }

  // (Re)computes max_tier per (character, job). Called at startup and after gathering/crafting:
  // gathering moves job xp directly, so a tier unlocked mid-session must be taken in the next
  // round instead of sitting idle. Also populates job_level for EVERY job a recipe can train —
  // crafting an item of another profession earns that profession's xp, so the pass gating below
  // must know every craft job level, not just the producing trio. While here, notices any job
  // level that increased since the last refresh and reports it as a Discord embed + log line.
  const character_name = new Map<string, string>(CHARACTERS.map((c) => [c.id as string, c.name]))
  const collected_level_ups: Omit<DiscordLevelUp, 'name'>[] = []
  const report_level_ups = async (): Promise<void> => {
    if (collected_level_ups.length === 0) return
    const rows = [...collected_level_ups]
    collected_level_ups.length = 0
    for (const row of rows) {
      log(
        `${character_name.get(row.character_id)} reached ${row.job} level ${row.level} ` +
          `(was ${row.previous_level}) — +${row.level - row.previous_level}`
      )
    }
    await send_discord_embed({
      title: '⬆️ Job level up!',
      color: 0x2ecc71,
      fields: rows.map((row) => ({
        name: `${character_name.get(row.character_id)} — ${row.job}`,
        value: `Level **${row.previous_level} → ${row.level}** (+${row.level - row.previous_level})`,
        inline: true,
      })),
    }).catch((error) => console.warn(`${message_of(error)} — level-up webhook failed`))
  }

  // Inverts progression's tier_unlock_level (tier→unlock-level law) into the biggest TIER a
  // character's job level can farm — max_tier_for_level lives beside that law in immutable.
  const refresh_capabilities = async (): Promise<void> => {
    const rows = await Promise.all(
      CHARACTERS.flatMap((c) =>
        [...craft_jobs()].map(async (job): Promise<[string, string, number, number]> => {
          const xp = await read(() => read_job_xp(c.id, job))
          const lvl = job_level_from_xp(xp)
          return [c.id, job, lvl, max_tier_for_level(lvl)]
        })
      )
    )
    for (const [char_id, job, lvl, tier] of rows) {
      if (PRODUCING_JOBS.includes(job as GatheringJob)) {
        let by_job = max_tier.get(char_id)
        if (!by_job) {
          by_job = new Map()
          max_tier.set(char_id, by_job)
        }
        by_job.set(job as GatheringJob, tier)
        // A tier can have been rejected before the previous level-up. Do not let that stale lock
        // hide it after the character becomes able to gather it.
        const locked = locked_tiers.get(char_id)
        if (locked) {
          for (const locked_tier of locked) {
            if (locked_tier <= tier) locked.delete(locked_tier)
          }
        }
      }
      let by_job_lvl = job_level.get(char_id)
      if (!by_job_lvl) {
        by_job_lvl = new Map()
        job_level.set(char_id, by_job_lvl)
      }
      // Level grew since the last refresh (baseline levels at startup are never "ups") — queue the
      // Discord report. Gathering/Craft XP lands only in the passes between refreshes.
      const previous = by_job_lvl.get(job)
      if (previous !== undefined && lvl > previous) {
        collected_level_ups.push({ character_id: char_id, job, level: lvl, previous_level: previous })
      }
      by_job_lvl.set(job, lvl)
    }
    await report_level_ups()
  }

  // Re-derives the per-job roster from who actually WEARS each tool (equipped items are owned by
  // the character's own address — see read_held_tools). If a character came up bare (the party
  // has more members than first-crafted tools), it makes ONE more starter tool for the job with
  // the fewest hands, re-equips, and re-reads so every character ends up on a job. This replaces
  // the old probe-by-gather discovery entirely.
  const refresh_holders = async (): Promise<void> => {
    const held = await read(() => read_held_tools(bot, (msg) => console.log(`  [tools] ${msg}`)))
    const bare = CHARACTERS.filter((c) => {
      const tools = held.get(c.id) ?? new Set<string>()
      return ![...tools].some((tool) => gathering_job_of_tool(tool) !== null)
    })
    if (bare.length > 0) {
      const hands = new Map<GatheringJob, number>(PRODUCING_JOBS.map((job) => [job, 0]))
      for (const tools of held.values()) {
        for (const tool of tools) {
          const job = gathering_job_of_tool(tool)
          if (job) hands.set(job, (hands.get(job) ?? 0) + 1)
        }
      }
      for (const c of bare) {
        // Fewest hands first so duplicate tools stay balanced — but the chosen craft can fail
        // (missing ingredient), so fall through the rest of the starter trio before leaving the
        // character bare. A character must wear SOME tool; sharing a job is the intended 4 chars /
        // 3 jobs topology.
        const by_hands = [...PRODUCING_JOBS].sort((a, b) => (hands.get(a) ?? 0) - (hands.get(b) ?? 0))
        for (const job of by_hands) {
          const outcome = await craft_starter_tool(bot, STARTER_TOOL_OF_JOB[job], (msg) =>
            console.log(`  [tools] ${msg}`)
          )
          if (outcome && outcome.succeeded > 0) {
            hands.set(job, (hands.get(job) ?? 0) + 1)
            break
          }
        }
      }
      await read(() => auto_equip_available_gear(bot, (msg) => console.log(`  [equip] ${msg}`)))
    }
    // Fresh read AFTER any extra crafts + equips: this map is the authoritative roster for the
    // whole session (a character's first equipped tool wins if it somehow wears two).
    const final_held = await read(() => read_held_tools(bot, (msg) => console.log(`  [tools] ${msg}`)))
    // Count equipped tool instances across the party so an already-worn objective tool (e.g. a
    // quartzbound_pickaxe from a previous session) satisfies its objective instead of being
    // re-crafted and re-reserved forever (the ownership needle owned_of is keyed on).
    equipped_tools_owned.clear()
    for (const tools of final_held.values()) {
      for (const tool of tools) {
        equipped_tools_owned.set(tool, (equipped_tools_owned.get(tool) ?? 0) + 1)
      }
    }
    holders = new Map<GatheringJob, (typeof CHARACTERS)[number][]>()
    for (const c of CHARACTERS) {
      const tools = final_held.get(c.id) ?? new Set<string>()
      const assigned = [...tools].map((tool) => gathering_job_of_tool(tool)).find((job) => job !== null)
      if (!assigned) continue
      const roster = holders.get(assigned) ?? []
      roster.push(c)
      holders.set(assigned, roster)
    }
  }

  const refresh_shelf = async (): Promise<void> => {
    shelf = { items: await read(() => read_sellable_items(bot)) }
  }
  await refresh_shelf()
  await refresh_holders()
  await refresh_capabilities()

  // One id per item_type -- gathering merges into the existing stack (existing), minting only
  // when none exists yet. A stale id (e.g. the stack was consumed by a craft) surfaces as an
  // unresolvable-object abort on the next gather; the refresh below re-pins it.
  const existing_stack = (item_type: string): { id: string; kiosk_id: string } | null => {
    const pinned = stack_pins.get(item_type)
    if (pinned) return pinned
    const item = shelf?.items.find((i) => i.item_type === item_type)
    return item ? { id: item.id, kiosk_id: item.kiosk_id } : null
  }
  const existing_stack_id = (item_type: string): string | null => existing_stack(item_type)?.id ?? null

  const enumerate_packs = async (zx: number, zz: number): Promise<SpawnedPack[]> => {
    const packs: SpawnedPack[] = []
    let consecutive_misses = 0
    for (let index = 0; index < PACKS_PROBE_MAX; index += 1) {
      try {
        const pack = await read(() => read_resource_pack(bot.sdk, world, world_content, zx, zz, index))
        packs.push({ ...pack, remaining: pack.nodes })
        consecutive_misses = 0
      } catch (error) {
        // 1302 = ENothingThere past the last live pack. A "not found" object is a zone our party
        // can't read yet (never searched) or a pack another party just consumed mid-scan — treat
        // it as a miss too rather than killing the whole farm.
        if (!/abort code:\s*1302\b|not found|RPC timed out/i.test(message_of(error))) throw error
        consecutive_misses += 1
        if (consecutive_misses >= CONSECUTIVE_PACK_MISSES) break
      }
    }
    return packs
  }

  // The one place every gather attempt funnels through.
  type GatherOutcome =
    | { kind: 'gathered'; ambushed: boolean; quantity: number }
    | { kind: 'no_tool' }
    | { kind: 'locked' }
    | { kind: 'drained' }
    | { kind: 'travel' }
    | { kind: 'unknown' }

  const attempt_gather = async (c: (typeof CHARACTERS)[number], pack: SpawnedPack): Promise<GatherOutcome> => {
    const mob = gatherable_of(pack.item_type)
    if (!mob) return { kind: 'unknown' }
    try {
      // On-chain the character moves (prove_move) to the pack first, so the movement model updates
      // on every abort AFTER it -- only ETravelTooSoon (305/1724) means prove_move itself failed
      // and the character stayed put.
      const { quantity, ambushed } = await submit_with_retry(
        () =>
          bot.character.gather({
            character_id: c.id,
            world: WORLD,
            zone_x: Math.floor(pack.x / ZONE_SIZE),
            zone_z: Math.floor(pack.z / ZONE_SIZE),
            pack_index: Number(pack.index),
            item_type: pack.item_type,
            rare_item_type: mob.rare_item_type,
            existing: existing_stack_id(pack.item_type),
            existing_rare: existing_stack_id(mob.rare_item_type),
          }),
        log
      )
      const me = movement.get(c.id)!
      me.x = pack.x
      me.z = pack.z
      me.at_ms = Date.now() + ROOT_MS
      return { kind: 'gathered', ambushed, quantity }
    } catch (error) {
      const msg = message_of(error)
      // prove_move ran first, so these aborts happen with the character already standing at the
      // pack and rooted there -- reflect it in the movement model, or the next travel wait
      // under-sleeps from the old position.
      const moved_then_failed = (): void => {
        const me = movement.get(c.id)!
        me.x = pack.x
        me.z = pack.z
        me.at_ms = Date.now() + ROOT_MS
      }
      if (/abort code:\s*2203\b/i.test(msg)) {
        moved_then_failed()
        return { kind: 'no_tool' }
      }
      if (/abort code:\s*2204\b/i.test(msg)) {
        moved_then_failed()
        return { kind: 'locked' }
      }
      if (/abort code:\s*1302\b/i.test(msg)) {
        moved_then_failed()
        return { kind: 'drained' }
      }
      if (/abort code:\s*(1724|305)\b/i.test(msg)) return { kind: 'travel' }
      // The unexpected branch is the one that must SPEAK — normal aborts each returned their
      // discriminant above; the failure still travels through a sanctioned channel here.
      console.warn(`gather at pack #${pack.index} failed unexpectedly: ${msg}`)
      await refresh_shelf()
      return { kind: 'unknown' }
    }
  }

  const wait_for = async (c: (typeof CHARACTERS)[number], pack: SpawnedPack): Promise<void> => {
    const me = movement.get(c.id)!
    const dist = Math.hypot(pack.x - me.x, pack.z - me.z)
    const arrival = me.at_ms + Math.ceil((dist * SPEED_SCALE) / SPEED_BUDGET)
    const wait = arrival - Date.now()
    if (wait > 0) {
      log(`${c.name} walks ~${Math.round(dist)}u to (${pack.x},${pack.z}) — ~${Math.ceil(wait / 1000)}s`)
      await sleep(wait)
    }
  }

  // Ambush (2% protector roll on a successful gather): fight it with the solo-validated
  // machinery. The ambushed character is already seated by resolve_ambush; a one-seat fight
  // starts on their single ready, and run_turn_loop empty-commits for the mob's turns.
  const fight_ambush = async (
    c: (typeof CHARACTERS)[number],
    mob: NonNullable<ReturnType<typeof gatherable_of>>
  ): Promise<void> => {
    log(`${c.name} was ambushed by ${mob.protector} — fighting…`)
    const { fight } = await submit_with_retry(
      () => bot.character.resolve_ambush({ character_id: c.id, protector_mob_type: mob.protector }),
      log
    )
    const state = await read(() => read_fight(bot.sdk, fight))
    const idx = fighter_indices(state).get(c.id)
    if (idx === undefined) throw new Error(`ambush fight ${fight} has no seat for ${c.name}`)
    await submit_with_retry(() => bot.fight.ready({ fight, fighter_idx: BigInt(idx) }), log)
    const prep = await read(() => prepare_party(bot, log))
    const { final_state, turns } = await run_turn_loop(bot, fight, prep, log)
    const { drops } = await settle_all(bot, fight, log)
    const me = movement.get(c.id)!
    me.x = final_state.x
    me.z = final_state.z
    me.at_ms = Date.now() + ROOT_MS
    const drop_list =
      Object.entries(drops)
        .map(([t, q]) => `${t} x${q}`)
        .join(', ') || 'none'
    log(`${c.name} concluded the ambush in ${turns} turns — drops: ${drop_list}`)
  }

  const do_craft_pass = async (
    job: string,
    c: (typeof CHARACTERS)[number],
    max_party_level: number
  ): Promise<{ ok: boolean; error?: string }> => {
    let items = shelf?.items ?? []
    if (items.length === 0) return { ok: true }

    const candidate_recipes = recipes_by_job.get(job) ?? []
    if (candidate_recipes.length === 0) return { ok: true }

    const char_level = job_level.get(c.id)?.get(job) ?? 1

    // Amounts up front: selection now weighs material quantity (craft objectives reserve their
    // ingredients, junk gear is value-gated), and the same read jumps in again after the stack
    // consolidation below (merging changes object ids).
    const { objects: amount_objects } = await read(() =>
      bot.sdk.sui_client.core.getObjects({ objectIds: items.map((i) => i.id), include: { json: true } })
    )
    const amount_of = new Map<string, number>()
    amount_objects.forEach((o, i) => {
      amount_of.set(items[i]!.id, Number((o as { json?: { amount?: string | number } } | undefined)?.json?.amount ?? 0))
    })

    // Only recipes the character can AFFORD (full quantity of every ingredient across the kiosk)
    // are candidates — the old ">=1 instance of each type" check admitted a recipe like
    // wheatspun_sinew on a single rabbit_sinew, then blocked on the same pass round after round
    // while the picker kept re-spending the decision on a recipe it could never try.
    const doable_recipes: { recipe: RawRecipe; required: number }[] = []
    for (const recipe of candidate_recipes) {
      const required = craft_required_level(Object.keys(recipe.inputs).length)
      if (required > char_level) continue
      const affordable = Object.entries(recipe.inputs).every(([ingredient, qty]) => {
        const total = items
          .filter((i) => i.item_type === ingredient)
          .reduce((sum, i) => sum + (amount_of.get(i.id) ?? 0), 0)
        return total >= qty
      })
      if (affordable) doable_recipes.push({ recipe, required })
    }
    if (doable_recipes.length === 0) return { ok: true }

    // Craft objectives + reservations + value gate. A pending objective's recipe is crafted FIRST
    // once doable, and its ingredient types are reserved from every other recipe so the mats can't
    // leak into low-value crafts. Gear below the configured value floor (e.g. lorito_hat__molted,
    // lv 3) is never selected — the pass crafts powders (or sits out) rather than burn mats + SUI
    // on junk; keys and equippable high-value gear are preferred over the powder grind. The exact
    // ladder lives in select_craft_recipe (craft_objectives.ts); the supply planner mirrors it.
    const owned = owned_of(items, amount_of)
    const pending = pending_objectives(objectives_config.objectives, owned)
    const reserved = reserved_resources(all_recipes, pending, owned)
    const picked = select_craft_recipe({
      job,
      candidates: doable_recipes.map(({ recipe, required }) => ({ ...recipe, required_level: required })),
      objective: pending.find((o) => craft_job_of_output.get(o.output_type) === job),
      reserved,
      value_floor_sui: craft_value_floor,
      party_max_level: max_party_level,
      gear_categories: GEAR_CATEGORIES,
      category_of: (t) => raw_item_category.get(t),
      output_level_of: (t) => raw_item_level.get(t) ?? 0,
      unit_price_sui_of: (t) => get_item_price(t).unit_price_sui,
    })
    if (!picked) {
      // Nothing worth this job's materials right now (all doable gear is below the value floor and
      // no powder/compound is doable) — sit out rather than craft junk.
      return { ok: true }
    }
    const recipe = picked

    // Consolidate ingredient stacks if split in kiosk
    items = await merge_recipe_ingredient_stacks(bot, items, recipe.inputs, log)
    shelf = { items }

    const { objects } = await read(() =>
      bot.sdk.sui_client.core.getObjects({ objectIds: items.map((i) => i.id), include: { json: true } })
    )
    amount_of.clear()
    objects.forEach((o, i) => {
      const json = (o as { json?: { amount?: string | number } } | undefined)?.json
      amount_of.set(items[i]!.id, Number(json?.amount ?? 0))
    })

    const ingredient_stack = (item_type: string): { id: string; amount: number } | null => {
      let best: SellableItem | null = null
      for (const item of items) {
        if (item.item_type !== item_type) continue
        if (best === null || (amount_of.get(item.id) ?? 0) > (amount_of.get(best.id) ?? 0)) best = item
      }
      return best ? { id: best.id, amount: amount_of.get(best.id) ?? 0 } : null
    }

    const chosen = Object.keys(recipe.inputs).map(ingredient_stack)
    const max_affordable = Math.min(
      ...Object.entries(recipe.inputs).map(([ingredient, qty], i) => Math.floor((chosen[i]?.amount ?? 0) / qty))
    )
    if (max_affordable < 1) {
      crafts_blocked += 1
      log(
        `${c.name}: not enough ${job} materials for 1 attempt of ${recipe.output_type} (need ` +
        `${Object.entries(recipe.inputs)
          .map(([t, q]) => `${t} x${q}`)
          .join(', ')}, have ` +
        `${Object.entries(recipe.inputs)
          .map(([t]) => `${t}=${ingredient_stack(t)?.amount ?? 0}`)
          .join(', ')})`
      )
      return { ok: true }
    }

    // Equipment and tools (non-stackables) require attempts = 1 on-chain AND a null output target
    // (assert_output_target forces target_template.is_none() for unique outputs) — the old code
    // passed the craft's user-context stack into `existing` here, which a non-stackable already in
    // the kiosk (e.g. a starter old_hoe) aborts with EOutputTarget(2323). Only a truly stackable
    // output merges into its existing stack.
    const is_stackable_output = item_is_stackable(raw_item_category.get(recipe.output_type) ?? '')
    const attempts = is_stackable_output ? Math.min(max_affordable, CRAFT_MAX_ATTEMPTS) : Math.min(1, max_affordable)
    // A listed ingredient or output stack is LOCKED — the craft would abort (kiosk::borrow 11).
    // Pull the bot's own open listings for exactly this recipe's items first (no-op when clean).
    await withdraw_listed_items_of_types(
      bot,
      new Set<string>([recipe.output_type, ...Object.keys(recipe.inputs)]),
      log
    )
    const existing = is_stackable_output ? existing_stack_id(recipe.output_type) : null
    log(
      `${c.name} crafts ${recipe.output_type} (${job}) x${attempts} from ${Object.entries(recipe.inputs)
        .map(([t, q]) => `${t} x${q}`)
        .join(', ')}`
    )
    try {
      const outcome = await submit_with_retry(
        () =>
          bot.character.craft({
            character_id: c.id,
            output_type: recipe.output_type,
            input_item_ids: chosen.map((s) => s!.id),
            existing,
            attempts,
          }),
        log
      )
      if (outcome.successes > 0) {
        crafts_succeeded += 1
        // A successful non-stackable craft is one more owned copy even after auto_equip moves it
        // off the shelf — satisfies (and un-reserves) a matching objective.
        if (!item_is_stackable(raw_item_category.get(recipe.output_type) ?? '')) {
          crafted_non_stackable.set(
            recipe.output_type,
            (crafted_non_stackable.get(recipe.output_type) ?? 0) + outcome.successes
          )
        }
      }
      log(
        `  ${recipe.output_type}: ${outcome.successes}/${outcome.attempts} succeeded (+${outcome.job_xp_gained} job xp)`
      )
      return { ok: true }
    } catch (error) {
      const message = message_of(error)
      crafts_failed += 1
      log(`craft ${recipe.output_type} failed this pass (${message}) — retried after more gathers`)
      return { ok: false, error: message }
    }
  }

  // Which ingredient types the NEXT craft pass would want but can't afford — the supply-run
  // planner's input. Unlike do_craft_pass (which only inspects recipes the party already holds ≥1
  // of every ingredient for), this picks each job's preferred target recipe by level alone, so a
  // completely un-stackable target (e.g. no gnawed_branch at all) is still reported as a shortage
  // and the roamer knows exactly what to go farm. Quantities are the shortfall for ONE attempt of
  // each job's preferred recipe.
  const missing_materials = async (): Promise<Map<string, number>> => {
    const missing = new Map<string, number>()
    const items = shelf?.items ?? []
    if (items.length === 0) return missing

    const { objects } = await read(() =>
      bot.sdk.sui_client.core.getObjects({ objectIds: items.map((i) => i.id), include: { json: true } })
    )
    const amount_of = new Map<string, number>()
    objects.forEach((o, i) => {
      const json = (o as { json?: { amount?: string | number } } | undefined)?.json
      amount_of.set(items[i]!.id, Number(json?.amount ?? 0))
    })
    const have_of = (item_type: string): number =>
      items.filter((i) => i.item_type === item_type).reduce((sum, i) => sum + (amount_of.get(i.id) ?? 0), 0)

    // Objectives redirect the planner to what the target actually needs (so a pending pickaxe
    // means the roamer farms gnawed_branch -> thebes), and their reserved ingredients can't be
    // reported on behalf of other recipes — the same rules the craft pass itself follows.
    const owned = owned_of(items, amount_of)
    const pending = pending_objectives(objectives_config.objectives, owned)
    const reserved = reserved_resources(all_recipes, pending, owned)

    const party_levels = await Promise.all(
      CHARACTERS.map((c) =>
        read(() => read_live_character_stats(bot.sdk, c.id).then((s) => s.level).catch(() => 0))
      )
    )
    const max_party_level = Math.max(0, ...party_levels)

    // A missing ingredient that is itself a crafted output does the roamer no good reported
    // wholesale (a TANNER target short on wheatspun_sinew reports wheatspun_sinew — which nobody
    // can drop — while its own rabbit_sinew, a thebes-band drop, stays invisible). Expand
    // craftable intermediates into THEIR missing inputs (recursively, cycle-guarded) so droppable
    // leaves like rabbit_sinew actually reach plan_supply_run and the supply detour can fire.
    const recipe_of_output = new Map<string, RawRecipe>(all_recipes.map((r) => [r.output_type, r]))
    const flatten_short = (ingredient: string, qty: number, chain: Set<string>): void => {
      if (qty <= 0) return
      const have = have_of(ingredient)
      if (have >= qty) return
      const recipe = recipe_of_output.get(ingredient)
      if (!recipe || chain.has(ingredient)) {
        missing.set(ingredient, Math.max(missing.get(ingredient) ?? 0, qty - have))
        return
      }
      chain.add(ingredient)
      for (const [sub, subqty] of Object.entries(recipe.inputs)) flatten_short(sub, (qty - have) * subqty, chain)
      chain.delete(ingredient)
    }

    for (const job of craft_jobs()) {
      // A pending objective for this job wins the wiring: report the shortfall of its recipe
      // (flattened) and skip every other target (the pass will craft the objective first anyway).
      const goal = pending.find((o) => craft_job_of_output.get(o.output_type) === job)
      if (goal) {
        const recipe = recipe_of_list(all_recipes, goal.output_type)
        if (recipe) {
          for (const [ingredient, qty] of Object.entries(recipe.inputs)) {
            flatten_short(ingredient, qty, new Set<string>())
          }
        }
        continue
      }
      const best_level = Math.max(1, ...CHARACTERS.map((c) => job_level.get(c.id)?.get(job) ?? 1))
      const eligible = (recipes_by_job.get(job) ?? []).filter((r) => {
        if (craft_required_level(Object.keys(r.inputs).length) > best_level) return false
        // Never plan a gather whose craft the pass would refuse: burning a reserved ingredient on
        // a non-objective recipe.
        if ([...Object.keys(r.inputs)].some((ingredient) => reserved.has(ingredient))) return false
        return true
      })
      if (eligible.length === 0) continue
      // Mirror the pass's own picker: valuable equippable gear/keys first, then the powder grind.
      // Junk gear below the value floor is never worth farming materials for.
      const valuable = eligible.filter((r) => passes_value_gate(r, max_party_level))
      const powder_chain = eligible.filter((r) => {
        const category = raw_item_category.get(r.output_type) ?? ''
        return !GEAR_CATEGORIES.has(category) && category !== 'key'
      })
      const pool = valuable.length > 0 ? valuable : powder_chain
      if (pool.length === 0) continue
      const target = [...pool].sort(
        (a, b) =>
          get_item_price(b.output_type).unit_price_sui - get_item_price(a.output_type).unit_price_sui ||
          craft_required_level(Object.keys(b.inputs).length) - craft_required_level(Object.keys(a.inputs).length)
      )[0]!
      for (const [ingredient, qty] of Object.entries(target.inputs)) {
        flatten_short(ingredient, qty, new Set<string>())
      }
    }
    return missing
  }

  // --- zone setup -----------------------------------------------------------------------------

  const tier_of = (pack: SpawnedPack): number => gatherable_of(pack.item_type)?.tier ?? 99
  const job_of = (pack: SpawnedPack): GatheringJob | null => gatherable_of(pack.item_type)?.job ?? null
  const live_packs_of = (job: GatheringJob, packs: readonly SpawnedPack[]): SpawnedPack[] =>
    packs.filter((p) => job_of(p) === job && p.remaining > 0)

  // Per-character farm session: NO shared zone, NO leader convoy. Each petal character holds its
  // own searched zone + anchor and only travels to zones that actually contain its OWN job's packs,
  // so a farmer can farm wheat in one zone while an herbalist picks mushrooms a zone away. Two
  // characters on the same job may land in the same zone — they pick different packs per round.

  // Jobs read-only-probed per zone (read_resource_pack is watched, costs no gas): a zone's pack
  // content is deterministic, so once a zone is probed its known jobs don't change session-long.
  // A zone that NOBODY has ever searched has no derived Zone object yet — probe_zone can't read it
  // (every index throws "not found"), so `materialized` records that and the caller spends a
  // search_zone tx on it instead.
  type ZoneProbe = { materialized: boolean; jobs: Set<GatheringJob>; packs: SpawnedPack[] }
  const probe_cache = new Map<string, ZoneProbe>()
  const zone_key = (zx: number, zz: number): string => `${zx},${zz}`

  // Read the whole pack list of a zone (read-only) — same consecutive-miss stop as enumerate_packs.
  // "not found" before any pack was read = the zone was never searched (no Zone object); never a
  // real error, so it's reported to the caller as `materialized: false` instead of killing the run
  // with the 4-consecutive-miss spam every failed index would otherwise log.
  const probe_zone = async (zx: number, zz: number): Promise<ZoneProbe> => {
    const key = zone_key(zx, zz)
    const cached = probe_cache.get(key)
    if (cached) return cached
    const packs: SpawnedPack[] = []
    const jobs = new Set<GatheringJob>()
    let consecutive_misses = 0
    for (let index = 0; index < PACKS_PROBE_MAX; index += 1) {
      try {
        const pack = await read(() => read_resource_pack(bot.sdk, world, world_content, zx, zz, index))
        packs.push({ ...pack, remaining: pack.nodes })
        consecutive_misses = 0
        const job = gatherable_of(pack.item_type)?.job
        if (job) jobs.add(job)
      } catch (error) {
        const msg = message_of(error)
        if (/abort code:\s*1302\b/.test(msg)) {
          consecutive_misses += 1
          if (consecutive_misses >= CONSECUTIVE_PACK_MISSES) break
          continue
        }
        if (/not found|RPC timed out/i.test(msg)) {
          // Before any pack was read this is an unsearched zone; after some packs it's a pack a
          // foreign party consumed mid-scan — either way keep scanning progressively.
          if (packs.length === 0) break
          continue
        }
        throw error
      }
    }
    const fresh: ZoneProbe = Object.freeze({ materialized: packs.length > 0, jobs, packs: packs.map((p) => ({ ...p })) })
    probe_cache.set(key, fresh)
    return fresh
  }

  // Spiral outwards (Chebyshev rings) from a character's zone until a zone with its job's packs is
  // found. Pass 1 is free: it re-uses zones that are ALREADY materialized (anyone ever searched
  // them) via probe_zone, spending zero gas. If nothing materialized near has the job, pass 2
  // actually spends search_zone txs on the nearest never-searched zones until one reveals the job's
  // packs — the minimum number of searches, since the search itself materializes the zone.
  const PROBE_RING_MAX = 10
  const SEARCH_CANDIDATE_MAX = 4
  const find_zone_with = async (
    job: GatheringJob,
    near: { zx: number; zz: number },
    searcher: (typeof CHARACTERS)[number],
    ceiling: number,
    locked: Set<number>
  ): Promise<SpawnedZone | null> => {
    const is_farmable = (p: SpawnedPack): boolean =>
      job_of(p) === job && tier_of(p) <= ceiling && !locked.has(tier_of(p))
    const ring_cells = (): [number, number][] => {
      const cells: [number, number][] = []
      for (let radius = 0; radius <= PROBE_RING_MAX; radius += 1) {
        if (radius === 0) {
          cells.push([near.zx, near.zz])
          continue
        }
        for (let dx = -radius; dx <= radius; dx += 1) {
          cells.push([near.zx + dx, near.zz - radius])
          cells.push([near.zx + dx, near.zz + radius])
        }
        for (let dz = -radius + 1; dz <= radius - 1; dz += 1) {
          cells.push([near.zx - radius, near.zz + dz])
          cells.push([near.zx + radius, near.zz + dz])
        }
      }
      return cells
    }

    const probe_all = ring_cells()
    let probed = 0
    for (const [zx, zz] of probe_all) {
      const probe = await probe_zone(zx, zz)
      probed += 1
      if (probed % 7 === 0) log(`${searcher.name}: probed ${probed}/${probe_all.length} zones for ${job}…`)
      if (!probe.materialized) continue
      // probe_zone freezes a zone's PACK CONTENT (index -> item_type, deterministic per seed), but
      // the live `remaining` of each pack CANNOT be cached: this process drains packs in place, so
      // a frozen copy re-offers long-empty packs forever — the endless "already drained" hot-loop
      // (and the drain signal never consolidating, so migration never fires). Re-read the known
      // indexes before offering the zone; any index anyone consumed mid-scan is skipped.
      const packs: SpawnedPack[] = []
      for (const known of probe.packs) {
        try {
          const pack = await read(() =>
            read_resource_pack(bot.sdk, world, world_content, zx, zz, Number(known.index))
          )
          packs.push({ ...pack, remaining: pack.nodes })
        } catch {
          continue
        }
      }
      probe_cache.set(zone_key(zx, zz), Object.freeze({ materialized: true, jobs: probe.jobs, packs: [...packs] }))
      if (!packs.some(is_farmable)) continue
      return { zx, zz, packs, searched_at_ms: null }
    }
    log(`${searcher.name}: no ${job} zone in ${probe_all.length} cells — searching fresh zones…`)

    let searched = 0
    for (const [zx, zz] of ring_cells()) {
      const probe = await probe_zone(zx, zz)
      if (probe.materialized) continue
      if (searched >= SEARCH_CANDIDATE_MAX) break
      searched += 1
      const cx = zx * ZONE_SIZE + ZONE_SIZE / 2
      const cz = zz * ZONE_SIZE + ZONE_SIZE / 2
      const found = await search_zone_for(searcher, cx, cz)
      // Refresh the probe cache so pass 1 of the NEXT call sees this zone for free.
      const jobs = new Set<GatheringJob>()
      for (const pack of found.packs) {
        const job_of_pack = gatherable_of(pack.item_type)?.job
        if (job_of_pack) jobs.add(job_of_pack)
      }
      probe_cache.set(zone_key(zx, zz), Object.freeze({ materialized: true, jobs, packs: [...found.packs] }))
      if (found.packs.some(is_farmable)) return found
      log(`${searcher.name}: zone (${zx},${zz}) has no farmable ${job} packs — kept searching…`)
    }
    return null
  }

  // The travel gate's INVERSE, at the mover's proven speed: a leg starting from a checkpoint whose
  // `pet` fold is true (pet on at the checkpoint AND on now) accrues at the ×1.5 mounted budget,
  // exactly the budget world_map::travel_ok proves. It IS safe to sleep less when mounted: the
  // chain grants the same ×1.5 to a prove_move that starts from a mounted checkpoint.
  const travel_wait_ms = (c: (typeof CHARACTERS)[number], dist: number): number => {
    const me = movement.get(c.id)!
    const speed = me.pet ? PET_TRAVEL_SPEED_BUDGET : SPEED_BUDGET
    return me.at_ms + Math.ceil((dist * SPEED_SCALE) / speed) - Date.now()
  }

  // Moves c (not the leader convoy) to (x,z) and searches its OWN zone there. When the caller
  // already KNOWS the derived Zone object exists on-chain (an in-place reroll of the current
  // zone), `prefer_refresh` skips the doomed create_zone attempt — otherwise search_zone_for
  // spends a first tx that aborts EObjectAlreadyExists before the refresh lands.
  const search_zone_for = async (
    c: (typeof CHARACTERS)[number],
    x: number,
    z: number,
    prefer_refresh = false
  ): Promise<SpawnedZone> => {
    const me = movement.get(c.id)!
    const dist = Math.hypot(x - me.x, z - me.z)
    const wait = travel_wait_ms(c, dist)
    if (wait > 0) {
      log(`${c.name} travels ~${Math.round(dist)}u to (${x},${z}) — ~${Math.ceil(wait / 1000)}s`)
      await sleep(wait)
    }
    log(`${c.name} searches zone at (${x},${z})…`)
    if (!prefer_refresh) {
      try {
        await submit_with_retry(
          () => bot.character.search_zone({ character_id: c.id, world: WORLD, x, z, refresh: false }),
          log
        )
      } catch (error) {
        if (!/EObjectAlreadyExists|derived_object::claim/i.test(message_of(error))) throw error
        log(`${c.name}: zone already discovered — refreshing instead…`)
      }
    }
    await submit_with_retry(
      () => bot.character.search_zone({ character_id: c.id, world: WORLD, x, z, refresh: true }),
      log
    )
    me.x = x
    me.z = z
    me.at_ms = Date.now() + ROOT_MS
    // Mirror prove_move's `cp.pet = pet_now`: the leg AFTER this one starts from a checkpoint
    // whose pet flag is whatever the character wears now.
    me.pet = pet_equipped.get(c.id) === true

    const { zx, zz } = zone_of(x, z)
    return { zx, zz, packs: await enumerate_packs(zx, zz), searched_at_ms: Date.now() }
  }

  // Ensures the session has a live zone for its job — rerolling its own drained zone in place
  // once the research TTL elapsed (zone.move refresh reseeds: res_taken resets to empty), or
  // searching a new one otherwise. Returns the live packs (may be empty when nothing in range).
  const session_zone = async (s: Session): Promise<{ packs: SpawnedPack[]; zone: SpawnedZone | null }> => {
    // 1. The current zone still has farmable packs for this session — farm them.
    const ceiling = max_tier.get(s.c.id)?.get(s.job) ?? 1
    const locked = locked_tiers.get(s.c.id) ?? new Set<number>()
    if (s.zone) {
      const usable = s.zone.packs.filter(
        (p) => job_of(p) === s.job && p.remaining > 0 && tier_of(p) <= ceiling && !locked.has(tier_of(p))
      )
      if (usable.length > 0) {
        s.drained = false
        return { packs: usable, zone: s.zone }
      }
    }

    // 2. Current zone is drained — reroll it IN PLACE as soon as its research TTL elapses. This
    //    regenerates every pack (same zone, no travel), so a session farms the same neighbourhood
    //    indefinitely instead of marching further from base every time a zone empties.
    if (s.zone && s.zone.searched_at_ms !== null) {
      const reroll_at = s.zone.searched_at_ms + ZONE_RESEARCH_TTL_MS
      if (Date.now() >= reroll_at) {
        log(`${s.c.name}: zone (${s.zone.zx},${s.zone.zz}) reseeds — re-searching in place…`)
        const { zx, zz } = s.zone
        const refreshed = await search_zone_for(
          s.c,
          zx * ZONE_SIZE + ZONE_SIZE / 2,
          zz * ZONE_SIZE + ZONE_SIZE / 2,
          true
        )
        s.zone = refreshed
        s.waiting_until = 0
        const usable = refreshed.packs.filter(
          (p) => job_of(p) === s.job && p.remaining > 0 && tier_of(p) <= ceiling && !locked.has(tier_of(p))
        )
        if (usable.length > 0) {
          s.drained = false
          return { packs: usable, zone: refreshed }
        }
      } else if (Date.now() < reroll_at) {
        s.waiting_until = s.waiting_until === 0 ? reroll_at : Math.min(s.waiting_until, reroll_at)
      }
    }

    const near = zone_of(s.anchor.x, s.anchor.z)
    const found = await find_zone_with(s.job, near, s.c, ceiling, locked)
    if (found) {
      // find_zone_with already searched (pass 2) or probed a materialized zone (pass 1) — the zone
      // object exists on-chain either way, so no second search here. Read its search timestamp so
      // a future drain schedules the in-place reroll on the real on-chain TTL.
      s.zone = found
      s.anchor = { x: found.zx * ZONE_SIZE + ZONE_SIZE / 2, z: found.zz * ZONE_SIZE + ZONE_SIZE / 2 }
      s.waiting_until = 0
      const searched = await read(() => read_zone_searched_at(bot.sdk, world, found.zx, found.zz))
      if (searched !== null) s.zone.searched_at_ms = searched
      s.drained = false
      return { packs: live_packs_of(s.job, s.zone.packs), zone: s.zone }
    }

    // Nothing live anywhere — the caller naps until the earliest scheduled reroll / roam retry.
    const reroll_soonest = s.zone?.searched_at_ms !== null && s.zone?.searched_at_ms !== undefined
      ? s.zone!.searched_at_ms! + ZONE_RESEARCH_TTL_MS
      : Date.now() + ROAM_RETRY_MS
    s.waiting_until = s.waiting_until === 0 ? reroll_soonest : Math.min(s.waiting_until, reroll_soonest)
    s.drained = true
    return { packs: [], zone: null }
  }

  const zone_claimed = (zone: SpawnedZone, pack: SpawnedPack): string => `${zone_key(zone.zx, zone.zz)}#${pack.index}`

  const sessions: Session[] = []
  for (const job of PRODUCING_JOBS) {
    for (const c of holders.get(job) ?? []) {
      const start = movement.get(c.id)!
      sessions.push({ c, job, zone: null, anchor: { x: start.x, z: start.z }, done: false, waiting_until: 0, drained: false })
    }
  }

  // One harvest pass across EVERY character session — all tooled characters farm on their own,
  // each in its own zone. Candidates are the session's live packs filtered down to the tiers the
  // character can actually farm (max_tier ceiling from current job xp, plus any tier an ETierLocked
  // already proved), sorted HIGHEST tier first then nearest. Returns the number of gathers landed.
  const harvest_round = async (): Promise<number> => {
    const claimed = new Set<string>()
    let round_gathers = 0
    for (const s of sessions) {
      if (s.done) continue
      // A session waiting on a zone reroll / roam retry must NOT probe (and gas-paid pass-2
      // fresh searches) every loop — skip it until its waiting_until passes.
      if (s.waiting_until > Date.now()) continue
      const { packs, zone } = await session_zone(s)
      if (!zone || packs.length === 0) {
        // Nothing live right now — session_zone scheduled when to retry (reroll TTL / roam retry).
        // NOT done: the zone reseeds every ZONE_RESEARCH_TTL_MS, so this farm never gives up.
        s.drained = true
        if (s.waiting_until === 0) s.waiting_until = Date.now() + ROAM_RETRY_MS
        continue
      }
      const ceiling = max_tier.get(s.c.id)?.get(s.job) ?? 1
      const locked = locked_tiers.get(s.c.id) ?? new Set<number>()
      const candidates = packs
        .filter((p) => !claimed.has(zone_claimed(zone, p)) && tier_of(p) <= ceiling && !locked.has(tier_of(p)))
        .sort(
          (a, b) =>
            tier_of(b) - tier_of(a) ||
            Math.hypot(a.x - movement.get(s.c.id)!.x, a.z - movement.get(s.c.id)!.z) -
              Math.hypot(b.x - movement.get(s.c.id)!.x, b.z - movement.get(s.c.id)!.z)
        )
      if (candidates.length === 0) {
        // Every farmable pack already taken by another session this round (transient — retry next
        // round), or this zone's packs are all above the ceiling (retry after a craft pass levels
        // the job). Neither is permanent: zones reseed and job levels rise, so keep the session.
        const farmable_anywhere = packs.some((p) => tier_of(p) <= ceiling && !locked.has(tier_of(p)))
        if (!farmable_anywhere) {
          s.waiting_until = Date.now() + ROAM_RETRY_MS
          s.drained = true
        }
        continue
      }
      const pack = candidates[0]!
      claimed.add(zone_claimed(zone, pack))

      await wait_for(s.c, pack)
      const outcome = await attempt_gather(s.c, pack)
      switch (outcome.kind) {
        case 'gathered':
          pack.remaining = Math.max(0, pack.remaining - 1)
          s.drained = false
          round_gathers += 1
          gathers += 1
          gathers_since_craft += 1
          if (gathers_since_craft >= CRAFT_EVERY_GATHERS) {
            craft_due = true
            gathers_since_craft = 0
          }
          log(`${s.c.name} harvested ${pack.item_type} x${outcome.quantity}${outcome.ambushed ? ' (AMBUSHED)' : ''}`)
          if (outcome.ambushed) await fight_ambush(s.c, gatherable_of(pack.item_type)!)
          break
        case 'no_tool':
          // The roster came from read_held_tools this session, so the chain disagreeing now means
          // the character was unequipped mid-session — drop them for the rest of the session.
          s.done = true
          log(`${s.c.name} no longer wears a ${s.job} tool — that character is done for this run`)
          break
        case 'locked': {
          const tiers = locked_tiers.get(s.c.id) ?? new Set<number>()
          tiers.add(tier_of(pack))
          locked_tiers.set(s.c.id, tiers)
          log(`${s.c.name}: ${pack.item_type} (tier ${tier_of(pack)}) is above their job level — tier locked for now`)
          break
        }
        case 'drained':
          pack.remaining = 0
          log(`pack #${pack.index} (${pack.item_type}) is already drained`)
          break
        case 'travel':
          // Budget for this far walk isn't met yet — wait a round and retry (it accrues every second).
          log(`${s.c.name} can't reach (${pack.x},${pack.z}) yet — waiting for the walk budget`)
          await sleep(30_000)
          break
        default:
          break
      }
    }
    if (round_gathers > 0) await refresh_capabilities()
    return round_gathers
  }

  // Long walk (a migration leg can run ~25 min) with a heartbeat instead of one silent sleep, so
  // a terminal user watching the farm actually sees it move rather than stare at a frozen line.
  const sleep_travel = async (label: string, wait: number): Promise<void> => {
    let slept = 0
    while (slept < wait) {
      const chunk = Math.min(NAP_CHUNK_MS, Math.max(2_000, wait - slept))
      await sleep(chunk)
      slept += chunk
      if (slept < wait) log(`${label} — ${Math.round((wait - slept) / 1000)}s to go…`)
    }
  }

  // The job-farm CLI's answer to "every resource type is drained": walk the farm to the next city
  // region (nearest one not visited yet, per farm_migrate's rotation), chunking legs longer than
  // FARM_MIGRATE_MAX_TRAVEL_MS. The landing zone is searched as a first discovery when someone
  // hasn't claimed it yet (fresh population + leaderboard credit), and every live session is
  // re-anchored there so the next harvest round re-searches its own job in the new neighbourhood.
  const relocate_if_stalled = async (): Promise<{ relocated: boolean; target: Position | null }> => {
    if (!migrate_on_drain) return { relocated: false, target: null }
    const mover = sessions.find((s) => !s.done) ?? sessions[0]
    if (!mover) return { relocated: false, target: null }

    const regions = farm_regions()
    if (regions.length === 0) return { relocated: false, target: null }
    const chosen = next_region(mover.anchor, regions, migrated)
    if (!chosen) return { relocated: false, target: null }
    if (chosen.cycled) {
      migrated.clear()
      const current = nearest_region(mover.anchor, regions)
      if (current) migrated.add(current.city)
    }
    migrated.add(chosen.region.city)

    const me = movement.get(mover.c.id)!
    const landing = chunked_landing(mover.anchor, chosen.region, FARM_MIGRATE_MAX_TRAVEL_MS, me.pet)
    log(
      `every job drained — moving the farm ~${Math.round(Math.hypot(landing.x - mover.anchor.x, landing.z - mover.anchor.z))} blocks toward ${chosen.region.city} (${Math.round(landing.x)},${Math.round(landing.z)})${me.pet ? ' — riding a pet' : ''}…`
    )

    // Pre-walk with a heartbeat, then let search_zone_for's own travel gate check the walk.
    const dist = Math.hypot(landing.x - me.x, landing.z - me.z)
    const wait = travel_wait_ms(mover.c, dist)
    if (wait > 0) {
      log(`${mover.c.name} walks ~${Math.round(dist)}u to the ${chosen.region.city} region — ~${Math.ceil(wait / 1000)}s`)
      await sleep_travel(`${mover.c.name} walking to ${chosen.region.city}`, wait)
    }
    // Pre-advance the movement model so the search below roots the character at the landing point.
    me.x = landing.x
    me.z = landing.z
    me.at_ms = Date.now()

    await search_zone_for(mover.c, landing.x, landing.z)
    for (const s of sessions) {
      if (s.done) continue
      s.anchor = { x: landing.x, z: landing.z }
      s.zone = null
      s.waiting_until = 0
      s.drained = false
    }
    return { relocated: true, target: { x: landing.x, z: landing.z } }
  }

  // A shelf refresh + one craft pass per profession across EVERY craft job, every
  // CRAFT_EVERY_GATHERS gathers. The producing trio is gathered by its tool holders; the rest are
  // leveled purely by crafting, and any character can train them — so we hand each job to the
  // character with the highest level in it (most recipes unlocked, best xp per pass).
  let craft_due = false

  const craft_pass_if_due = async (): Promise<void> => {
    if (!craft_due) return
    craft_due = false
    await refresh_shelf()
    await refresh_capabilities()
    // Highest combat level in the party — gates which crafted gear is wearable, so the pass only
    // spends materials on equipment someone can actually put on (auto_equip fills by level too).
    const party_levels = await Promise.all(
      CHARACTERS.map((c) =>
        read(() => read_live_character_stats(bot.sdk, c.id).then((s) => s.level).catch(() => 0))
      )
    )
    const max_party_level = Math.max(0, ...party_levels)
    // job_priority (craft_objectives.local.json) lets the config decide which profession's pass
    // spends shared ingredients first; unlisted jobs run after, in craft_jobs()'s alpha order.
    const ordered_jobs = order_craft_jobs(craft_jobs(), objectives_config.job_priority)
    for (const job of ordered_jobs) {
      const holder = (holders.get(job as GatheringJob) ?? [])[0]
      const best =
        holder ??
        [...CHARACTERS].sort((a, b) => {
          const la = job_level.get(a.id)?.get(job) ?? 1
          const lb = job_level.get(b.id)?.get(job) ?? 1
          return lb - la
        })[0] ??
        LEADER
      await do_craft_pass(job, best, max_party_level)
    }
  }

  return {
    sessions,
    movement,
    holders,
    max_tier,
    job_level,
    locked_tiers,
    get gathers(): number {
      return gathers
    },
    get crafts_succeeded(): number {
      return crafts_succeeded
    },
    get crafts_blocked(): number {
      return crafts_blocked
    },
    get crafts_failed(): number {
      return crafts_failed
    },
    missing_materials,
    refresh_holders,
    harvest_round,
    craft_pass_if_due,
    refresh_capabilities,
    relocate_if_stalled,
    get craft_due(): boolean {
      return craft_due
    },
    set craft_due(v: boolean) {
      craft_due = v
    },
  }
}