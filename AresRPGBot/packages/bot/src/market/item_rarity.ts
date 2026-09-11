// Tracks the RAREST drop chance ever observed for each item_type, across every mob loot table
// this bot has seen in a fight -- not just items actually won, since a mob's loot table (chance_bp
// per entry) is visible on every fighter snapshot regardless of what happened to roll. There's no
// authored "rarity" field anywhere in the seed content (seed/content/items.json only carries
// item_type/name/category/level) -- chance_bp (basis points out of 10_000; lower = rarer) is the
// only real rarity signal this bot has access to, and it's already sitting unused on every fight
// it plays. Same "no live market" situation as market_history.ts: this is a LOCAL, self-built
// signal, not a read of anyone else's view of rarity.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from '../state/local_store.ts'

const store = create_local_json_store<Record<string, number>>(
  fileURLToPath(new URL('../../item_rarity.local.json', import.meta.url)),
  {}
)

export const read_rarity_registry = store.read

/** Folds one mob's loot table into the registry -- call for every mob fought, win or lose, seen
 *  or not (the loot table itself is static per mob template, always present on the fighter
 *  snapshot). Only ever LOWERS a recorded chance_bp (rarer), never raises it -- a single sighting
 *  of a low chance_bp is enough to know the item can be that rare; never un-learn that from a
 *  later, more common sighting of the same item dropped by a different mob. */
export const record_loot_table = (loot: readonly Readonly<{ item_type: string; chance_bp: number }>[]): void => {
  if (loot.length === 0) return
  const registry = read_rarity_registry()
  let changed = false
  const next = { ...registry }
  for (const { item_type, chance_bp } of loot) {
    const known = next[item_type]
    if (known === undefined || chance_bp < known) {
      next[item_type] = chance_bp
      changed = true
    }
  }
  if (changed) store.write(next)
}

export type RarityTier = 'common' | 'uncommon' | 'rare' | 'epic'

// Thresholds on chance_bp (out of 10_000). Picked to bracket the real seed content observed live
// (2026-09-05): common drops sit at 2000-6000+ (20-60%+), a "somewhat interesting" tier around
// 500-2000 (5-20%), true rarities below 500 (<5%), and the rarest confirmed drop this session
// (colony_mandible_axe) at 18 (0.18%). Revisit once more of the item pool has actually been
// observed -- this registry only ever knows what's been fought, so early on most items are
// simply "unknown" (no entry), not "common."
const TIER_THRESHOLDS: readonly Readonly<{ max_chance_bp: number; tier: RarityTier }>[] = [
  { max_chance_bp: 500, tier: 'epic' },
  { max_chance_bp: 2000, tier: 'rare' },
  { max_chance_bp: 6000, tier: 'uncommon' },
  { max_chance_bp: Infinity, tier: 'common' },
]

/** null when this item_type has never been seen on a fought mob's loot table -- genuinely
 *  unknown rarity, not an assumption of "common." */
export const rarity_tier = (item_type: string): RarityTier | null => {
  const chance_bp = read_rarity_registry()[item_type]
  if (chance_bp === undefined) return null
  return TIER_THRESHOLDS.find((t) => chance_bp <= t.max_chance_bp)!.tier
}

export const rarity_chance_bp = (item_type: string): number | null => read_rarity_registry()[item_type] ?? null
