// Local record of every listing the auto-seller has made, plus how it turned out. There is no
// on-chain or indexed order book the bot can read directly (that lives behind the game server's
// authenticated websocket protocol, `packet/market_observe`, which this headless bot never
// connects to) — so instead of reading OTHER sellers' prices, the auto-seller tracks the outcome
// of its OWN past listings and adjusts from there. This file is that memory.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from '../state/local_store.ts'

export type ListingOutcome = 'sold' | 'unsold' | 'delisted'

export type ListingRecord = Readonly<{
  listing_id: string
  item_type: string
  kiosk_id: string
  price_mist: string
  listed_at: string
  resolved_at: string | null
  outcome: ListingOutcome | null // null while still open
}>

const store = create_local_json_store<ListingRecord[]>(
  fileURLToPath(new URL('../../market_history.local.json', import.meta.url)),
  []
)

export const read_market_history = store.read
const write_market_history = store.write

export const append_listing = (record: ListingRecord): void => write_market_history([...read_market_history(), record])

/** Marks every still-open record for a listing id with its outcome — a no-op if it's already resolved. */
export const resolve_listing = (listing_id: string, outcome: ListingOutcome, resolved_at: string): void =>
  write_market_history(
    read_market_history().map((record) =>
      record.listing_id === listing_id && record.outcome === null ? { ...record, outcome, resolved_at } : record
    )
  )
