import type { BotSdk } from '../auth/sdk_client.ts'
import { CHARACTERS, LEADER } from '../config/party_config.ts'
import type { GatheringJob } from '@aresrpg/immutable'
import { read_sellable_items, type SellableItem } from '../market/kiosk_inventory.ts'
import { submit_with_retry, is_transient, message_of } from '../shared/chain_retry.ts'
import { read_equipped_items } from '../fight/equipped_weapon.ts'
import { recipe_of } from '../shared/dungeon_content.ts'

// The three level-1 starter tools (seed/content/items.json) — one per gathering profession. Each
// is a HANDYMAN recipe with exactly 2 ingredients (craft_slot_capacity is 2 at job level 1, so a
// fresh account can craft them immediately). Higher-tier tools (quartzbound_*) are handled by the
// same code path once their ingredients exist; the starter trio is what a brand-new party needs
// first.
// Gathering profession tools — level-1 starter trio (HANDYMAN) plus higher-tier quartzbound tools.
const ALL_TOOLS = Object.freeze([
  'old_hoe',
  'basic_pickaxe',
  'tool_herbalist',
  'quartzbound_hoe',
  'quartzbound_pickaxe',
  'quartzbound_sickle',
])

// Which gathering job each tool serves (tool category ↔ job, content_rules.move's law). Used to
// map "who holds which tool" onto the jobs the farm loop harvests for.
export const gathering_job_of_tool = (tool: string): GatheringJob | null => {
  if (tool === 'old_hoe' || tool === 'quartzbound_hoe') return 'FARMER'
  if (tool === 'basic_pickaxe' || tool === 'quartzbound_pickaxe') return 'MINER'
  if (tool === 'tool_herbalist' || tool === 'quartzbound_sickle') return 'HERBALIST'
  return null
}

// The level-1 starter tool per producing job — what a bare character first gets equipped with.
export const STARTER_TOOL_OF_JOB: Readonly<Record<GatheringJob, string>> = Object.freeze({
  FARMER: 'old_hoe',
  HERBALIST: 'tool_herbalist',
  MINER: 'basic_pickaxe',
})

type ToolCraftOutcome = Readonly<{ tool: string; attempted: number; succeeded: number }>

/** Batches an `amount` read for every given item id into one call, keyed by item id. Mirrors the
 *  proven shape in dungeon_keys.ts — one scan instead of N, to stay clear of the public RPC's
 *  ListOwnedObjects rate limit. Re-submits on the same transient errors as every other call, so a
 *  bursty 429 doesn't kill the whole session (an async RPC reject is otherwise unhandled). */
const read_amounts = async (
  bot: BotSdk,
  item_ids: readonly string[],
  log: (msg: string) => void
): Promise<ReadonlyMap<string, number>> => {
  if (item_ids.length === 0) return new Map()
  const { objects } = await submit_with_retry(
    () => bot.sdk.sui_client.core.getObjects({ objectIds: [...item_ids], include: { json: true } }),
    log
  )
  return new Map(
    objects.map((o, i) => {
      const json = o as { json?: { amount?: string | number } } | Error | undefined as
        { json?: { amount?: string | number } } | undefined
      return [item_ids[i]!, Number(json?.json?.amount ?? 0)]
    })
  )
}

const item_ids_for = (items: readonly SellableItem[], types: readonly string[]): string[] =>
  items.filter((i) => types.includes(i.item_type)).map((i) => i.id)

const stack_from = (
  items: readonly SellableItem[],
  amounts: ReadonlyMap<string, number>,
  item_type: string
): { item_id: string; amount: number } | null => {
  let best: { item_id: string; amount: number } | null = null
  for (const item of items) {
    if (item.item_type !== item_type) continue
    const amount = amounts.get(item.id) ?? 0
    if (amount > 0 && (best === null || amount > best.amount)) {
      best = { item_id: item.id, amount }
    }
  }
  return best
}

const missing_ingredient = (
  items: readonly SellableItem[],
  amounts: ReadonlyMap<string, number>,
  recipe: Readonly<Record<string, number>>
): { stacks: { item_type: string; item_id: string; amount: number }[]; missing: string | null } => {
  const stacks: { item_type: string; item_id: string; amount: number }[] = []
  for (const item_type of Object.keys(recipe)) {
    const stack = stack_from(items, amounts, item_type)
    if (!stack) return { stacks, missing: item_type }
    stacks.push({ item_type, item_id: stack.item_id, amount: stack.amount })
  }
  return { stacks, missing: null }
}

// @aresrpg/sdk's SuiTransport (client.ts) is a deliberately narrow structural type covering only
// what the SDK itself has needed so far — listOwnedObjects is real on the underlying gRPC/GraphQL
// core clients, just not part of that narrowed surface yet. Widened locally, matching this repo's
// own established convention (kiosk_listings.ts, kiosk_inventory.ts).
type CoreWithOwnedObjects = {
  listOwnedObjects: (options: {
    owner: string
    type?: string
    cursor?: string | null
    limit?: number
    include?: { json?: boolean }
  }) => Promise<{
    objects: readonly (Error | Readonly<{ json?: { item_type?: string } | null }>)[]
    cursor?: string | null
    hasNextPage?: boolean
  }>
}

/** The tools each character currently HOLDS, by character id. Equipping SENDS the item to the
 *  character's own address (equipment.move: transfer::public_transfer at the end of equip), so a
 *  character's own `::item::Item` objects ARE its loadout — this read is the cheap, structural way
 *  to know "who wears what" without hand-rolling a BCS decoder for the nested EquippedRecord
 *  dynamic field (see auto_equip.ts's header for why that decoder is deliberately avoided).
 *
 *  This is also the root-cause fix for the farm CLI re-crafting starter tools every session:
 *  read_sellable_items sees only KIOSK items, and an EQUIPPED tool has left the kiosk, so
 *  kiosk-only ownership wrongly concluded the whole party "owns no hoe" and crafted one each run.
 *  Anything already held (equipped) counts as owned and is never re-crafted. */
export const read_held_tools = async (
  bot: BotSdk,
  log: (msg: string) => void
): Promise<ReadonlyMap<string, ReadonlySet<string>>> => {
  const game_package = bot.sdk.game_type_package
  const result = new Map<string, ReadonlySet<string>>()
  if (!game_package) return result
  const core = bot.sdk.sui_client.core as unknown as CoreWithOwnedObjects
  for (const character of CHARACTERS) {
    const held = new Set<string>()
    let cursor: string | null | undefined
    do {
      const { objects, cursor: next, hasNextPage } = await submit_with_retry(
        () =>
          core.listOwnedObjects({
            owner: character.id,
            type: `${game_package}::item::Item`,
            cursor: cursor ?? undefined,
            include: { json: true },
          }),
        log
      )
      for (const object of objects) {
        if (object instanceof Error) continue
        const item_type = object.json?.item_type
        if (typeof item_type === 'string' && (ALL_TOOLS as readonly string[]).includes(item_type)) held.add(item_type)
      }
      cursor = hasNextPage ? next : null
    } while (cursor)
    result.set(character.id, Object.freeze(held))
  }
  return result
}

/** Consolidates multiple kiosk stacks of ONLY the specific ingredient types required by `recipe`
 *  into a single stack per type, so that crafting PTBs find the full required ingredient quantity
 *  in one stack without blowing up transaction command limits.
 *
 *  Key rules:
 *  - Only merges stacks whose kiosk_id matches cap.kioskId (items from other kiosks are
 *    untouchable — kiosk::borrow_mut aborts with code 9 if the item isn't in THAT kiosk).
 *  - Deduplicates target+source pairs to avoid EFieldAlreadyExists (dynamic_field::add code 0).
 *  - Silently skips when already consolidated (groups.length === 0). */
export const merge_recipe_ingredient_stacks = async (
  bot: BotSdk,
  items: readonly SellableItem[],
  recipe: Readonly<Record<string, number>>,
  log: (msg: string) => void
): Promise<readonly SellableItem[]> => {
  const cap = await bot.kiosk_cap()
  if (!cap) return items

  const needed_types = new Set(Object.keys(recipe))
  // Only work with items whose kiosk_id matches cap.kioskId — crossing kiosks triggers EItemLocked.
  const stacks_by_type = new Map<string, SellableItem[]>()
  for (const item of items) {
    if (!needed_types.has(item.item_type)) continue
    if (item.kiosk_id !== cap.kioskId) continue  // skip items from a different kiosk
    const list = stacks_by_type.get(item.item_type) ?? []
    list.push(item)
    stacks_by_type.set(item.item_type, list)
  }

  const groups: { kiosk: string; target_id: string; source_ids: string[] }[] = []
  const seen_pairs = new Set<string>()
  for (const [, list] of stacks_by_type) {
    if (list.length <= 1) continue
    const [target, ...sources] = list
    const unique_sources = sources.filter((s) => {
      const key = `${target!.id}:${s.id}`
      if (seen_pairs.has(key)) return false
      seen_pairs.add(key)
      return true
    })
    if (unique_sources.length === 0) continue
    groups.push({
      kiosk: cap.kioskId,
      target_id: target!.id,
      source_ids: unique_sources.map((s) => s.id),
    })
  }

  if (groups.length === 0) return items

  log(`tools: consolidating split ingredient stacks in kiosk for ${[...needed_types].join(', ')}...`)
  // One type per PTB: extract_from_kiosk lists+buys the source, and packing several types into
  // the same transaction was aborting live on df::add (already listed) / borrow_mut (listed or
  // wrong kiosk). A failed type must not roll back a type that already merged.
  let merged_any = false
  for (const group of groups) {
    try {
      await submit_with_retry(() => bot.stacks.merge_many([group]), log)
      merged_any = true
    } catch (error) {
      if (is_transient(error)) throw error
      log(
        `tools: stack merge best-effort failed for ${group.target_id}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return merged_any ? await read_sellable_items(bot) : items
}

const craft_one_tool = async (
  bot: BotSdk,
  items: readonly SellableItem[],
  owned_types: Set<string>,
  tool: string,
  log: (msg: string) => void
): Promise<ToolCraftOutcome | null> => {
  const recipe = recipe_of(tool)
  if (!recipe) {
    log(`tools: no seeded crafting recipe for ${tool}`)
    return null
  }
  if (owned_types.has(tool)) {
    log(`tools: ${tool} already owned — skipping`)
    return null
  }

  const fresh_items = await merge_recipe_ingredient_stacks(bot, items, recipe, log)
  const amounts = await read_amounts(bot, item_ids_for(fresh_items, Object.keys(recipe)), log)
  const { stacks, missing } = missing_ingredient(fresh_items, amounts, recipe)
  if (missing) {
    const total_in_kiosk = fresh_items.filter((i) => i.item_type === missing).reduce((sum, item) => sum + (amounts.get(item.id) ?? 0), 0)
    log(
      `tools: ${tool} — missing ingredient "${missing}" (${total_in_kiosk} unlisted in kiosk; if listed on marketplace, unlist first)`
    )
    return null
  }

  const max_affordable = Math.min(...stacks.map((s) => Math.floor(s.amount / recipe[s.item_type]!)))
  // Tools and equipment are non-stackable items (Move craft_batch MAX_UNIQUE_ATTEMPTS = 1).
  const attempts = Math.min(1, max_affordable)
  if (attempts <= 0) {
    const stack_info = stacks.map((s) => {
      const total = fresh_items.filter((i) => i.item_type === s.item_type).reduce((sum, item) => sum + (amounts.get(item.id) ?? 0), 0)
      return `${s.item_type}=${s.amount} [largest stack; total unlisted in kiosk=${total}]`
    })
    log(
      `tools: ${tool} — not enough materials in a single stack for 1 attempt (need ${JSON.stringify(recipe)} per attempt, ` +
      `have ${stack_info.join(', ')})`
    )
    return null
  }

  log(
    `tools: crafting ${tool} x${attempts} attempt(s) from ${stacks.map((s) => `${s.item_type}(${s.amount})`).join(', ')}`
  )
  const outcome = await submit_with_retry(
    () =>
      bot.character.craft({
        character_id: LEADER.id,
        output_type: tool,
        input_item_ids: stacks.map((s) => s.item_id),
        existing: null,
        attempts,
      }),
    log
  )
  log(`tools: ${tool} → ${outcome.successes}/${outcome.attempts} succeeded (+${outcome.job_xp_gained} job xp)`)
  if (outcome.successes > 0) owned_types.add(tool)
  return Object.freeze({ tool, attempted: outcome.attempts, succeeded: outcome.successes })
}

/** Crafts each profession tool the party still lacks, from currently-owned ingredient stacks.
 *  Best-effort and non-fatal: missing ingredients skip that tool (they accumulate from drops over
 *  the session and the next run picks them up), and failed craft rolls just burn their own
 *  materials. Returns what was attempted/succeeded per tool. Runs once at session start,
 *  when the inventory snapshot is fresh. */
const STARTER_TOOLS = Object.freeze(['old_hoe', 'basic_pickaxe', 'tool_herbalist'])

export const craft_starter_tools_if_missing = async (
  bot: BotSdk,
  log: (msg: string) => void
): Promise<ToolCraftOutcome[]> => {
  let items: readonly SellableItem[] = await read_sellable_items(bot)
  const owned_types = new Set(items.map((i) => i.item_type))
  // Equipped tools never sit in the kiosk (equip SENDS each to its character), so kiosk-only
  // ownership re-crafted the whole starter trio on every farm session even after a full party was
  // wearing them. Merge what each character already holds — anything equipped counts as owned.
  for (const held of (await read_held_tools(bot, log)).values()) for (const tool of held) owned_types.add(tool)
  const results: ToolCraftOutcome[] = []
  for (const tool of ALL_TOOLS) {
    const outcome = await craft_one_tool(bot, items, owned_types, tool, log)
    if (outcome) {
      results.push(outcome)
      items = await read_sellable_items(bot)
      for (const item of items) owned_types.add(item.item_type)
    }
  }
  return results
}

/** Best-effort craft of ONE more instance of a starter tool — the SECOND hoe/sickle/pickaxe a
 *  party member with no tool needs. Unlike craft_starter_tools_if_missing this deliberately
 *  ignores what the party already owns (duplicates are the point); missing ingredients just skip
 *  the craft (non-fatal, logged). Returns null when nothing was attempted. */
export const craft_starter_tool = async (
  bot: BotSdk,
  tool: string,
  log: (msg: string) => void
): Promise<ToolCraftOutcome | null> => {
  const items = await read_sellable_items(bot)
  return craft_one_tool(bot, items, new Set(), tool, log)
}

/** Crafts extra level-1 gathering tools so every party member can wear one. Starter tools are
 *  unique item types, so a second hoe/sickle/pickaxe has to be an explicit duplicate craft —
 *  `craft_starter_tools_if_missing` only fills the first of each type. */
export const craft_extra_starter_tools = async (
  bot: BotSdk,
  count: number,
  log: (msg: string) => void
): Promise<ToolCraftOutcome[]> => {
  if (count < 1) return []
  const results: ToolCraftOutcome[] = []
  for (let i = 0; i < count; i += 1) {
    const items = await read_sellable_items(bot)
    const tool = STARTER_TOOLS[i % STARTER_TOOLS.length]!
    const owned_types = new Set<string>()
    const outcome = await craft_one_tool(bot, items, owned_types, tool, log)
    if (outcome) results.push(outcome)
    else log(`tools: could not craft extra ${tool} for the unequipped gatherers`)
  }
  return results
}

// ---- Gathering roster invariant -------------------------------------------------------------
//
// The party must ALWAYS keep a character wearing each of the three gathering profession tools
// (FARMER = old_hoe, HERBALIST = tool_herbalist, MINER = basic_pickaxe). On top of that, the tool
// of the resource the party is actively focusing (quartz right now = MINER) may be worn by a
// SECOND character to intensify that gather. `DEFAULT_ROSTER_PLAN` is the concrete, name-keyed
// assignment satisfying both rules with the current 4-character party:
//   1 FARMER (memorien) + 1 HERBALIST (omori) + 2 MINER (llokan + archero, the quartz focus).
// auto_equip can't drive this: its poll only fills EMPTY slots and upgrades a worn tool when the
// spare is STRICTLY higher level, so a freshly-crafted level-1 basic_pickaxe would never replace
// an equal-level old_hoe. This planner re-assigns the party's gathering roster on purpose.
export const DEFAULT_ROSTER_PLAN: Readonly<Record<string, string>> = Object.freeze({
  memorien: 'old_hoe',
  omori: 'tool_herbalist',
  llokan: 'basic_pickaxe',
  archero: 'basic_pickaxe',
})

/** Drives the party's gathering roster toward `plan` (see the invariant above), crafting and
 *  equipping whatever tool each planned character still lacks, unequipping the previous tool in
 *  the same transaction so no profession is left uncovered by accident (a farmer stepping down is
 *  safe only as long as the plan keeps another farmer). Best-effort and non-fatal; returns true
 *  once every planned character holds its planned tool.
 *
 *  `max_craft_attempts` bounds how many craft rolls the whole call may spend. Tool crafting is a
 *  probabilistic roll (progression.move: 50% + 0.5%/level, capped 99%) that BURNS its ingredients
 *  on a failed attempt too, so a single boot roll (~59% at the party's level) leaves a real chance
 *  of running a whole session without the full roster — bounded retries are the material-aware
 *  middle ground between one roll and an unbounded retry-until-success loop. A later call (once
 *  per expedition) resumes wherever the last one stopped. */
export const ensure_gathering_roster = async (
  bot: BotSdk,
  plan: Readonly<Record<string, string>> = DEFAULT_ROSTER_PLAN,
  log: (msg: string) => void,
  max_craft_attempts = 1
): Promise<boolean> => {
  const held = await read_held_tools(bot, log)

  const want: { character: (typeof CHARACTERS)[number]; tool: string }[] = []
  for (const character of CHARACTERS) {
    const tool = plan[character.name]
    if (!tool) continue
    if (held.get(character.id)?.has(tool)) continue
    want.push({ character, tool })
  }
  if (want.length === 0) {
    log(`tools: gathering roster already at the plan — skipping`)
    return true
  }
  log(
    `tools: gathering roster missing ${want.length} tool(s) ` +
      `(${want.map((w) => `${w.character.name} → ${w.tool}`).join(', ')}) — fixing`
  )

  let all_met = true
  for (const { character, tool } of want) {
    let items = await read_sellable_items(bot)
    let tool_item = items.find((i) => i.item_type === tool)
    if (!tool_item) {
      if (max_craft_attempts <= 0) {
        all_met = false
        break
      }
      const outcome = await craft_starter_tool(bot, tool, log)
      max_craft_attempts -= 1
      if (!outcome) {
        all_met = false
        break
      }
      if (outcome.succeeded < 1) {
        all_met = false
        continue
      }
      items = await read_sellable_items(bot)
      tool_item = items.find((i) => i.item_type === tool)
      if (!tool_item) {
        log(`tools: ${tool} crafted but missing from the kiosk — cannot equip on ${character.name}`)
        all_met = false
        continue
      }
    }

    const equipped = await read_equipped_items(bot.sdk, character.id)
    const worn_tool = equipped.find((e) => e.slot === 'tool')?.item_id
    if (worn_tool === tool_item.id) continue
    try {
      await submit_with_retry(
        () =>
          bot.character.equip({
            character_id: character.id,
            to_equip: [{ slot: 'tool', item_id: tool_item!.id }],
            to_unequip: worn_tool ? [{ slot: 'tool', item_id: worn_tool }] : [],
          }),
        log
      )
      log(
        `tools: ${character.name} now wields a ${tool}${worn_tool ? ' (their previous tool was unequipped)' : ''}`
      )
    } catch (error) {
      log(`tools: equipping ${tool} on ${character.name} failed (${message_of(error)}) — loadout untouched`)
      all_met = false
    }
  }
  return all_met
}
