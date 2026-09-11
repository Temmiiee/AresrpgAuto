// Auto-equips the best available spare gear into any EMPTY slot, for every character, after
// every fight (called from fight_session.ts right after settling). Deliberately does not try to
// upgrade an ALREADY-equipped slot: equipment.move stores what's currently worn in a dynamic
// field (a VecMap<String, EquippedRecord> keyed by slot), and reading it correctly would mean
// hand-rolling a BCS decoder for a nested struct (EquippedRecord -> Option<ItemStatistics> +
// vector<ItemDamages>) with no real captured payload to verify it against — exactly the failure
// shape code-law's L-D4 exists because of (the 2026-07-17 XP incident: a decoder that LOOKED
// right stayed green on self-consistency while silently mis-reading real data). Filling empty
// slots needs none of that: every character starts with nothing worn, so this is real, safe
// value today. Comparing against what's already equipped is a real follow-up, gated on either
// finding an existing tested read path or capturing a real payload to build one against.
import { CHARACTERS } from '../config/party_config.ts'
import { read_sellable_items, type SellableItem } from './kiosk_inventory.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import { submit_with_retry, is_transient } from '../shared/chain_retry.ts'
import type { BotSdk } from '../auth/sdk_client.ts'

const WEAPON_CATEGORIES = new Set(['daggers', 'spear', 'bow', 'axe', 'sword'])
const TOOL_CATEGORIES = new Set(['tool_farmer', 'tool_herbalist', 'tool_miner'])
const RELIC_SLOTS = ['relic_1', 'relic_2', 'relic_3', 'relic_4', 'relic_5', 'relic_6']
const SIMPLE_SLOTS = new Set(['hat', 'cloak', 'belt', 'boots', 'amulet', 'pet', 'title'])
const ALL_SLOTS = ['weapon', 'tool', ...SIMPLE_SLOTS, 'left_ring', 'right_ring', ...RELIC_SLOTS]

// Mirrors aresrpg_math::content_rules::category_fits exactly — the chain re-checks this anyway
// (equipment.move's EWrongCategory), so a mismatch here just costs one harmless zero-gas
// refused simulation, not a real failure.
const category_fits_slot = (slot: string, category: string): boolean => {
  if (slot === 'weapon') return WEAPON_CATEGORIES.has(category)
  if (slot === 'tool') return TOOL_CATEGORIES.has(category)
  if (slot === 'left_ring' || slot === 'right_ring') return category === 'ring'
  if (RELIC_SLOTS.includes(slot)) return category === 'relic'
  return SIMPLE_SLOTS.has(category) && slot === category
}

/** For each character, tries to fill every empty equipment slot from the account's spare
 *  (unlisted, unequipped) kiosk inventory — highest item level first per slot, since this game's
 *  gear power scales with level and nothing here compares finer-grained stats (see file header).
 *  One `equip` call per slot rather than one batched call for the whole character: a batch is
 *  all-or-nothing, so a single already-occupied slot (this pass has no way to know that without
 *  a real read of current gear) would otherwise silently cost every OTHER, genuinely empty slot
 *  its equip too. Each attempt that doesn't fit (occupied, level too low, duplicate relic
 *  template) is a real, expected, zero-gas outcome — logged only when it's something else. */
export const auto_equip_available_gear = async (bot: BotSdk, log: (msg: string) => void): Promise<void> => {
  const { sdk, character } = bot
  const spare_items = await read_sellable_items(bot)
  if (spare_items.length === 0) return
  const claimed = new Set<string>()

  for (const c of CHARACTERS) {
    const { level } = await read_live_character_stats(sdk, c.id)
    for (const slot of ALL_SLOTS) {
      const candidates = spare_items.filter(
        (item: SellableItem) => !claimed.has(item.id) && item.level <= level && category_fits_slot(slot, item.category)
      )
      const [best] = [...candidates].sort((a, b) => b.level - a.level)
      if (!best) continue
      try {
        await submit_with_retry(
          () => character.equip({ character_id: c.id, to_equip: [{ slot, item_id: best.id }], to_unequip: [] }),
          log
        )
        claimed.add(best.id)
        log(`${c.name} equipped ${best.name} (${slot})`)
      } catch (error) {
        // Occupied slot, level requirement, or duplicate relic template are the ordinary
        // outcome here and submit_with_retry already logged anything genuinely unexpected
        // before re-throwing — nothing else to do for this slot but move on, unless the
        // failure was transient (network/consensus timing), which the caller should retry.
        if (is_transient(error)) throw error
      }
    }
  }
}
