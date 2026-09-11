// Dungeon keys are ordinary stackable kiosk items (item.move's `Item.amount`, the same "amount"
// field every stackable resource carries) — dungeon.move's `enter()` burns exactly 1 unit per
// character from the SAME stack object (item::burn reduces `amount` in place until it hits 0,
// only then destroying the object), so one key stack with amount >= party size covers the whole
// party's entries. `ItemSnapshot` (kiosk_inventory.ts) deliberately doesn't carry `amount` (a
// tooltip-only projection) -- read it directly off the item's own JSON here instead.
//
// Every lookup here shares ONE read_sellable_items() scan and batches every `amount` read into a
// single getObjects call -- read_sellable_items() itself re-fetches every owned kiosk and
// re-snapshots every item in it (73 items on the account this was tested against), so calling it
// once per ingredient (this file's first version) meant a 4-ingredient recipe re-ran that entire
// scan 4 separate times in a row. Confirmed live (2026-09-07): that pattern reliably tripped the
// public testnet RPC's rate limit (ListOwnedObjects, RESOURCE_EXHAUSTED) on the very next call
// every time, not a transient one-off -- waiting it out (up to 5 minutes, repeatedly) never
// helped, only cutting the redundant calls did.
import type { BotSdk } from '../auth/sdk_client.ts'
import { LEADER } from '../config/party_config.ts'
import { submit_with_retry } from '../shared/chain_retry.ts'
import { key_recipe, type DungeonInfo } from '../shared/dungeon_content.ts'
import { read_sellable_items, type SellableItem } from '../market/kiosk_inventory.ts'

export type KeyStack = Readonly<{ item_id: string; amount: number }>

/** Batches an `amount` read for every given item id into one call, keyed by item id. */
const read_amounts = async (bot: BotSdk, item_ids: readonly string[]): Promise<ReadonlyMap<string, number>> => {
  if (item_ids.length === 0) return new Map()
  const { objects } = await bot.sdk.sui_client.core.getObjects({ objectIds: [...item_ids], include: { json: true } })
  return new Map(
    objects.map((o, i) => {
      const json = (o as { json?: { amount?: string | number } } | Error | undefined) as
        | { json?: { amount?: string | number } }
        | undefined
      return [item_ids[i]!, Number(json?.json?.amount ?? 0)]
    })
  )
}

/** The bot's own held stack of `key_type`, or null if it holds none at all. One full kiosk scan. */
export const owned_key_stack = async (bot: BotSdk, key_type: string): Promise<KeyStack | null> => {
  const items = await read_sellable_items(bot)
  return stack_from(items, await read_amounts(bot, item_ids_for(items, [key_type])), key_type)
}

const item_ids_for = (items: readonly SellableItem[], types: readonly string[]): string[] =>
  types.map((t) => items.find((i) => i.item_type === t)?.id).filter((id): id is string => id !== undefined)

const stack_from = (
  items: readonly SellableItem[],
  amounts: ReadonlyMap<string, number>,
  item_type: string
): KeyStack | null => {
  const match = items.find((i) => i.item_type === item_type)
  if (!match) return null
  const amount = amounts.get(match.id) ?? 0
  return amount > 0 ? Object.freeze({ item_id: match.id, amount }) : null
}

/** Crafts as many of `info.key` as the party's currently-owned ingredient stacks allow, capped
 *  at `keys_needed` — never more, so a lucky high-success roll doesn't burn extra materials past
 *  what's actually needed. Crafting has a real success rate (progression.move: 50% + 0.5%/level,
 *  capped 99%) and BURNS ingredients on a failed attempt too (crafting.move's own law), so this
 *  is a single best-effort batch, not a retry-until-success loop — a bad roll just means fewer
 *  keys this time, not more materials spent chasing them. Returns how many new keys were
 *  actually minted (0 if the recipe is unknown, materials are insufficient for even one attempt,
 *  or every attempt failed). */
export const craft_keys_if_possible = async (
  bot: BotSdk,
  info: DungeonInfo,
  keys_needed: number,
  log: (msg: string) => void
): Promise<number> => {
  if (keys_needed <= 0) return 0
  const recipe = key_recipe(info.key)
  if (!recipe) {
    log(`no known crafting recipe for ${info.key} (drops-only, or not yet seeded)`)
    return 0
  }

  // One kiosk scan, one batched amount read, covering every ingredient AND the existing key
  // stack (if any) to merge the craft's output into.
  const ingredient_types = Object.keys(recipe)
  const items = await read_sellable_items(bot)
  const wanted_ids = item_ids_for(items, [...ingredient_types, info.key])
  const amounts = await read_amounts(bot, wanted_ids)

  const stacks: { item_type: string; item_id: string; amount: number }[] = []
  for (const item_type of ingredient_types) {
    const stack = stack_from(items, amounts, item_type)
    if (!stack) {
      log(`craft ${info.key}: missing ingredient "${item_type}" entirely — can't craft any`)
      return 0
    }
    stacks.push({ item_type, item_id: stack.item_id, amount: stack.amount })
  }

  const max_affordable = Math.min(...stacks.map((s) => Math.floor(s.amount / recipe[s.item_type]!)))
  const attempts = Math.min(keys_needed, max_affordable)
  if (attempts <= 0) {
    log(
      `craft ${info.key}: not enough materials for even 1 attempt (need ${JSON.stringify(recipe)} per attempt, ` +
        `have ${stacks.map((s) => `${s.item_type}=${s.amount}`).join(', ')})`
    )
    return 0
  }

  const existing = stack_from(items, amounts, info.key)
  log(
    `crafting ${info.key} x${attempts} attempt(s) from ${stacks.map((s) => `${s.item_type}(${s.amount})`).join(', ')}…`
  )
  const outcome = await submit_with_retry(
    () =>
      bot.character.craft({
        character_id: LEADER.id,
        output_type: info.key,
        input_item_ids: stacks.map((s) => s.item_id),
        existing: existing?.item_id ?? null,
        attempts,
      }),
    log
  )
  log(`craft result: ${outcome.successes}/${outcome.attempts} succeeded (+${outcome.job_xp_gained} job xp)`)
  return outcome.successes
}
