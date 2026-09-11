// Shared between fight_settle.ts (open-world) and dungeon/dungeon_settle.ts (dungeon rooms) --
// both settle a Fight object with the exact same loot-authentication and rarity-tracking needs.
import { record_loot_table } from '../market/item_rarity.ts'
import { as_number, type FightJson } from './fight_state.ts'

// The set of item_types settle() might need to hand over for THIS fight, from every enemy mob's
// own loot table (already present on their live fighter snapshot — no seed-content lookup or
// extra read needed). Must be the full possible pool, not just what a pre-roll read of this
// character's OWN `drops` field currently shows: fight.move only actually ROLLS loot (mob
// tables -> a random split across winning seats) inside the FIRST successful settle call in the
// whole fight (`roll_and_split`, guarded by `drops_rolled`) — so whichever character settles
// first reads `drops` BEFORE anything has been rolled, sees it empty, and would authenticate
// zero templates. If that same roll then assigns THEM a non-empty share (their own settle is
// also where the roll executes, atomically), the chain has nowhere to deliver it: item.move's
// deliver_drops walks the caller's pre-authenticated plan for a matching template and, finding
// none, walks off the vector's end — `MoveAbort ... abort code: 131072`, Move's own
// EINDEX_OUT_OF_BOUNDS, not a game-defined code. That's a PERMANENT, deterministic abort for
// this exact fight — retrying changes nothing, since it re-derives the identical empty read
// every time (confirmed live 2026-09-02). Authenticating every possible template up front costs
// a little extra (harmless — `PM has drop`, an unclaimed template is just discarded, no abort,
// no dangling resource) and is the only way to be correct regardless of settle order.
export const possible_loot_item_types = (state_json: FightJson): Set<string> => {
  const item_types = new Set<string>()
  for (const fighter of state_json.fighters) {
    if (fighter.kind['@variant'] === 'Player') continue
    for (const drop of fighter.kind.pos0?.loot ?? []) item_types.add(drop.item_type)
  }
  return item_types
}

// Every mob's loot table (chance_bp per item_type) is visible on its fighter snapshot regardless
// of whether anything actually rolled -- feed market/item_rarity.ts's registry from it every
// fight, win or lose, so rarity becomes known ahead of ever actually winning a rare drop.
export const record_fight_loot_rarity = (state_json: FightJson): void => {
  const loot: { item_type: string; chance_bp: number }[] = []
  for (const fighter of state_json.fighters) {
    if (fighter.kind['@variant'] === 'Player') continue
    for (const drop of fighter.kind.pos0?.loot ?? []) loot.push({ item_type: drop.item_type, chance_bp: as_number(drop.chance_bp) })
  }
  record_loot_table(loot)
}
