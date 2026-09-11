// Live total value of everything sitting in the bot's kiosk(s) -- spare (unlisted) inventory
// priced from get_item_price's estimate, already-listed items priced at their real ask instead
// (a concrete number beats an estimate whenever one exists). Read-only, no chain writes; meant to
// answer "what is my inventory actually worth right now" on demand (control panel /api/inventory,
// cli_dashboard.ts) without needing to sell anything first.
import { KioskClient, type KioskItem } from '@mysten/kiosk'
import { read_item_snapshot } from '@aresrpg/sdk/item-snapshot'

import type { BotSdk } from '../auth/sdk_client.ts'
import { get_item_price } from './item_valuation.ts'
import { rarity_tier, type RarityTier } from './item_rarity.ts'
import { read_kiosk_listings } from './kiosk_listings.ts'

const MIST_PER_SUI = 1_000_000_000n

export type InventoryLine = Readonly<{
  item_id: string
  item_type: string
  name: string
  category: string
  qty: number
  unit_price_sui: number
  total_sui: number
  priced_from: 'listed' | 'estimated'
  rarity: RarityTier | null
}>

export type InventorySnapshot = Readonly<{
  total_sui: number
  listed_count: number
  unlisted_count: number
  lines: readonly InventoryLine[]
}>

const ITEM_TYPE_SUFFIX = '::item::Item'
const is_item = (item: KioskItem): boolean => item.type.endsWith(ITEM_TYPE_SUFFIX)

export const read_inventory_value = async (bot: BotSdk): Promise<InventorySnapshot> => {
  const { sdk, address } = bot
  const kiosk_client = new KioskClient({
    client: sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
    network: sdk.network,
  })
  const { kioskIds } = await kiosk_client.getOwnedKiosks({ address })

  const per_kiosk = await Promise.all(
    kioskIds.map(async (kiosk_id) => {
      const [{ items }, listings] = await Promise.all([
        kiosk_client.getKiosk({ id: kiosk_id, options: { withListingPrices: true } }),
        read_kiosk_listings(sdk, kiosk_id),
      ])
      return Promise.all(
        items.filter(is_item).map(async (item): Promise<InventoryLine | null> => {
          // NOT item.listing -- see kiosk_listings.ts's header (confirmed live: @mysten/kiosk's
          // own listing price reporting is unreliable on this kiosk, off by many orders of
          // magnitude). listings is the kiosk's own raw Listing dynamic fields, ground truth.
          const listed_price_mist = listings.get(item.objectId)
          try {
            const snapshot = await read_item_snapshot(sdk.sui_client as never, sdk.game_type_package, item.objectId)
            const unit_price_sui =
              listed_price_mist !== undefined
                ? Number(listed_price_mist) / Number(MIST_PER_SUI)
                : get_item_price(snapshot.item_type).unit_price_sui
            return {
              item_id: item.objectId,
              item_type: snapshot.item_type,
              name: snapshot.name,
              category: snapshot.category,
              qty: 1,
              unit_price_sui,
              total_sui: unit_price_sui,
              priced_from: listed_price_mist !== undefined ? 'listed' : 'estimated',
              rarity: rarity_tier(snapshot.item_type),
            }
          } catch {
            // Orphaned from an old package deployment (see party_config.ts's own note on the same
            // issue for characters) or otherwise unreadable -- skip rather than break the whole
            // snapshot over one bad item.
            return null
          }
        })
      )
    })
  )

  const lines = per_kiosk.flat().filter((line): line is InventoryLine => line !== null)
  return {
    total_sui: Number(lines.reduce((sum, l) => sum + l.total_sui, 0).toFixed(6)),
    listed_count: lines.filter((l) => l.priced_from === 'listed').length,
    unlisted_count: lines.filter((l) => l.priced_from === 'estimated').length,
    lines,
  }
}
