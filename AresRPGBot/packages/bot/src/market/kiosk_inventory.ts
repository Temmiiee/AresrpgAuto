// Reads the bot's own kiosk contents straight from the chain — no dependency on the game
// server's authenticated websocket protocol (which this headless bot never connects to; see
// market_history.ts). Equipped items are structurally absent from this list: equipping SENDS
// the item out of the kiosk to the character's own address, and unequipping is what re-locks it
// there (equipment.move's own module doc) — so anything unlisted here is, by construction, spare
// inventory, never gear a character currently has on.
import { KioskClient, type KioskItem } from '@mysten/kiosk'
import { read_item_snapshot, type ItemSnapshot } from '@aresrpg/sdk/item-snapshot'

import type { BotSdk } from '../auth/sdk_client.ts'
import { read_kiosk_listings } from './kiosk_listings.ts'

export type SellableItem = ItemSnapshot & Readonly<{ kiosk_id: string }>

const ITEM_TYPE_SUFFIX = '::item::Item'

export const read_sellable_items = async (bot: BotSdk): Promise<SellableItem[]> => {
  const { sdk, address } = bot
  const kiosk_client = new KioskClient({
    client: sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
    network: sdk.network,
  })
  const { kioskIds } = await kiosk_client.getOwnedKiosks({ address })
  const game_package = sdk.game_type_package
  // Package type identity uses the ORIGINAL package id (client.ts's own note on this) -- an item
  // whose type doesn't start with it is a leftover from a previous deployment (confirmed live
  // 2026-09-06: 16 of 42 kiosk objects predate the last testnet redeploy, same orphaning that hit
  // characters back in party_config.ts). read_item_snapshot throws "The linked item is
  // unavailable" on exactly this mismatch -- filtering it out here avoids the wasted read AND the
  // failure entirely, rather than letting one dead item sink the whole Promise.all below.
  const is_current_package_item = (item: KioskItem): boolean =>
    item.type.endsWith(ITEM_TYPE_SUFFIX) && (!game_package || item.type.startsWith(game_package))

  const per_kiosk = await Promise.all(
    kioskIds.map(async (kiosk_id) => {
      const [{ items }, listings] = await Promise.all([
        kiosk_client.getKiosk({ id: kiosk_id, options: { withListingPrices: true } }),
        read_kiosk_listings(sdk, kiosk_id),
      ])
      // NOT item.listing -- @mysten/kiosk's getKiosk({ withListingPrices: true }) is unreliable on
      // this kiosk (see kiosk_listings.ts's header). listings (the kiosk's own raw Listing dynamic
      // fields) is ground truth for "is this item actually listed right now."
      const snapshots = await Promise.all(
        items
          .filter((item) => is_current_package_item(item) && !listings.has(item.objectId))
          .map(async (item) => {
            try {
              return await read_item_snapshot(sdk.sui_client as never, sdk.game_type_package, item.objectId)
            } catch {
              // Best-effort: still-orphaned by some other mismatch, or a transient read failure --
              // skip rather than fail the whole plan over one unreadable item.
              return null
            }
          })
      )
      return snapshots
        .filter((snapshot): snapshot is ItemSnapshot => snapshot !== null)
        .map((snapshot): SellableItem => ({ ...snapshot, kiosk_id }))
    })
  )

  return per_kiosk.flat()
}
