// Withdraws every HDV listing that is still open (market_history outcome === null) for an item
// type that today's dungeon quest still needs -- WITHOUT buying the item back and WITHOUT
// re-listing it afterward. Bounded: it only withdraws listings this bot itself created (open
// ListingRecord: its own listing_id, own kiosk_id, own item_type) and it never spends a MIST
// (delist only, never buy; delist then resolves, never re-list). If the listing is no longer
// standing on the kiosk (sold, delisted by hand, or moved), the open record is closed with the
// matching outcome instead of being withdrawn -- we never touch anything that already left.
import type { BotSdk } from '../auth/sdk_client.ts'
import { message_of } from '../shared/chain_retry.ts'
import { read_kiosk_listings } from './kiosk_listings.ts'
import { read_market_history, resolve_listing } from './market_history.ts'
import { read_mastery_row } from '../dungeon/mastery_quest.ts'
import { resolve_quest_dungeon_slug } from '../shared/dungeon_read.ts'
import { dungeon_by_slug, key_recipe } from '../shared/dungeon_content.ts'

/** Item types today's dungeon quest still needs, as a set -- the same reserved set the
 *  auto-seller refuses to list (same mastery row + quest dungeon slug + key recipe chain). */
export const todays_reserved_item_types = async (bot: BotSdk): Promise<ReadonlySet<string>> => {
  const mastery = await read_mastery_row(bot, bot.mastery.id)
  if (!mastery || mastery.quest_completed) return new Set()
  const slug = resolve_quest_dungeon_slug(bot.sdk, mastery.quest_dungeon)
  const dungeon = slug ? dungeon_by_slug(slug) : undefined
  if (!dungeon) return new Set()
  const recipe = key_recipe(dungeon.key)
  return new Set(recipe ? Object.keys(recipe) : [])
}

/** Withdraws every still-open HDV listing for a reserved item type and returns how many were
 *  withdrawn. Never buys an item back and never re-lists; a record no longer on the kiosk is
 *  resolved as sold/delisted (the truth) instead of being withdrawn. */
export const withdraw_reserved_from_hdv = async (
  bot: BotSdk,
  log?: (msg: string) => void
): Promise<number> => {
  const reserved = await todays_reserved_item_types(bot)
  if (reserved.size === 0) return 0
  const open = read_market_history().filter((record) => record.outcome === null && reserved.has(record.item_type))
  if (open.length === 0) return 0

  let withdrawn = 0
  const resolved_at = new Date().toISOString()
  for (const record of open) {
    const listings = await read_kiosk_listings(bot.sdk, record.kiosk_id)
    if (!listings.has(record.listing_id)) {
      const outcome = listings.size === 0 ? 'sold' : 'delisted'
      resolve_listing(record.listing_id, outcome, resolved_at)
      continue
    }
    await bot.marketplace.delist({ kind: 'item', id: record.listing_id, kiosk: record.kiosk_id })
    resolve_listing(record.listing_id, 'delisted', resolved_at)
    withdrawn += 1
    log?.(`hdv: withdrawn ${record.item_type} (reserved for today's dungeon quest)`)
  }
  return withdrawn
}

/** Delists THIS bot's own currently-listened kiosk objects whose item_type is in `item_types` —
 *  object-level, so it covers listed stacks whether or not market_history has a record for them.
 *  A listed object is LOCKED: any craft/enter that borrows it aborts (kiosk::borrow abort 11,
 *  borrow_mut abort 9), so this MUST run before any PTX that pulls those item_types out of the
 *  kiosk. Any open ListingRecord pointing at a withdrawn listing is resolved 'delisted' (it was
 *  standing on the kiosk, so it's a real withdrawal — not sold). Never buys back, never re-lists.
 *  Per-item delist failures are logged and skipped (the craft that needed the item will fail and
 *  retry next pass rather than cascade); returns how many listings were actually withdrawn. */
export const withdraw_listed_items_of_types = async (
  bot: BotSdk,
  item_types: ReadonlySet<string>,
  log?: (msg: string) => void
): Promise<number> => {
  if (item_types.size === 0) return 0

  const { kioskOwnerCaps } = await bot.sdk.get_owned_kiosks(bot.address)
  const listed: { item_id: string; kiosk: string }[] = []
  for (const cap of kioskOwnerCaps) {
    const listings = await read_kiosk_listings(bot.sdk, cap.kioskId)
    for (const item_id of listings.keys()) listed.push({ item_id, kiosk: cap.kioskId })
  }
  if (listed.length === 0) return 0

  const types_of = new Map<string, string>()
  for (let index = 0; index < listed.length; index += 48) {
    const ids = listed.slice(index, index + 48)
    const { objects } = await bot.sdk.sui_client.core.getObjects({
      objectIds: ids.map((l) => l.item_id),
      include: { json: true },
    })
    ids.forEach((l, j) => {
      const obj = objects[j]
      if (obj instanceof Error) return
      const item_type = (obj as { json?: { item_type?: string } } | undefined)?.json?.item_type
      if (typeof item_type === 'string') types_of.set(l.item_id, item_type)
    })
  }

  const targets = listed.filter((l) => item_types.has(types_of.get(l.item_id) ?? ''))
  if (targets.length === 0) return 0

  let withdrawn = 0
  const resolved_at = new Date().toISOString()
  const open = new Map(
    read_market_history()
      .filter((record) => record.outcome === null)
      .map((record) => [record.listing_id, record])
  )
  for (const target of targets) {
    try {
      await bot.marketplace.delist({ kind: 'item', id: target.item_id, kiosk: target.kiosk })
    } catch (error) {
      log?.(`hdv: delist ${types_of.get(target.item_id)} failed (${message_of(error)}) — skipped`)
      continue
    }
    const record = open.get(target.item_id)
    if (record) resolve_listing(record.listing_id, 'delisted', resolved_at)
    withdrawn += 1
    log?.(`hdv: withdrawn listed ${types_of.get(target.item_id)} (needed: ${[...item_types].join('/')})`)
  }
  return withdrawn
}
