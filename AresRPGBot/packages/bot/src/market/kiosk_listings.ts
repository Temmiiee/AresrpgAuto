// Ground-truth kiosk listings, read straight off the kiosk's own `0x2::kiosk::Listing` dynamic
// fields -- NOT @mysten/kiosk's `getKiosk({ withListingPrices: true })`, whose `item.listing`
// this bot relied on until 2026-09-06. Confirmed live that call is unreliable on this kiosk: it
// reported 31 "listed" items with prices up to ~19 digits (nonsense, since 1 SUI = 1e9 MIST) when
// only 6 items actually carry a Listing dynamic field, each with a normal, correct price
// (matching exactly what market_history.local.json recorded at listing time). Every caller that
// needs to know "is this item listed, and at what price" should go through this file instead of
// touching KioskItem.listing directly.
import type { SuiClientTypes } from '@mysten/sui/client'

import type { BotSdk } from '../auth/sdk_client.ts'

export type KioskListings = ReadonlyMap<string, bigint> // item objectId -> price, in MIST

type ListingFieldValue = { name?: { id?: string }; value?: string | number }

// @aresrpg/sdk's SuiTransport (client.ts) is a deliberately narrow structural type covering only
// what the SDK itself has needed so far — listDynamicFields is real on both the underlying gRPC
// and GraphQL core clients, just not part of that narrowed surface yet. Widened locally rather
// than touching the shared package, matching this repo's own established CI-fix convention (see
// this bot's README "CI" section).
type CoreWithDynamicFields = {
  listDynamicFields: (
    options: SuiClientTypes.ListDynamicFieldsOptions
  ) => Promise<SuiClientTypes.ListDynamicFieldsResponse>
}

export const read_kiosk_listings = async (sdk: BotSdk['sdk'], kiosk_id: string): Promise<KioskListings> => {
  const core = sdk.sui_client.core as unknown as CoreWithDynamicFields
  const { dynamicFields } = await core.listDynamicFields({ parentId: kiosk_id })
  const listing_fields = dynamicFields.filter((f) => f.name?.type?.endsWith('::kiosk::Listing'))

  const entries = await Promise.all(
    listing_fields.map(async (field): Promise<readonly [string, bigint] | null> => {
      if (!field.fieldId) return null
      const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [field.fieldId], include: { json: true } })
      const json = objects[0]?.json as ListingFieldValue | undefined
      if (!json?.name?.id || json.value === undefined) return null
      return [json.name.id, BigInt(json.value)]
    })
  )

  return new Map(entries.filter((e): e is readonly [string, bigint] => e !== null))
}
