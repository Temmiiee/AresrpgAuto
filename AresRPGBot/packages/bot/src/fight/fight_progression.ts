// Phase 1 of a group fight: pre-fight party prep — spend stat/spell points, read the stats the
// rest of the fight (screening, HP gate, live decisions) needs.
import type { BotSdk } from '../auth/sdk_client.ts'
import { castable_spells } from '../ai/spell_catalog.ts'
import { success_rate } from '../ai/spell_memory.ts'
import {
  PRIMARY_STAT_BY_CLASS,
  split_stat_spending,
  caster_damage_multiplier,
  type LiveStats,
} from '../ai/stat_allocation.ts'
import type { SimPartyMember } from '../ai/simulate.ts'
import { estimate_max_hp } from '../state/hp_state.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { message_of, sleep, submit_with_retry } from '../shared/chain_retry.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import { read_spell_book } from '../shared/spell_book.ts'
import { read_equipped_weapon } from './equipped_weapon.ts'

export type PartyPrep = {
  levels: Map<string, number>
  max_hp: Map<string, number>
  xp_before: Map<string, number>
  sim_party_stats: Map<string, SimPartyMember>
}

type RawStats = {
  vitality: number
  wisdom: number
  strength: number
  intelligence: number
  chance: number
  agility: number
}

const raise_available_stats = async (
  character: BotSdk['character'],
  c: (typeof CHARACTERS)[number],
  stats: RawStats,
  available_points: number,
  log: (msg: string) => void
): Promise<RawStats> => {
  const primary_field = PRIMARY_STAT_BY_CLASS[c.classe]
  const current_primary = primary_field ? stats[primary_field] : 0
  const spending = split_stat_spending(c.classe, available_points, current_primary)
  const summary = Object.entries(spending)
    .map(([stat, points]) => `${points} ${stat}`)
    .join(', ')
  log(`${c.name} has ${available_points} unspent stat point(s) — spending ${summary}…`)
  try {
    await submit_with_retry(() => character.raise_stats({ character_id: c.id, spending }), log)
    const updated = { ...stats }
    for (const [stat, points] of Object.entries(spending)) updated[stat as keyof RawStats] += points
    return updated
  } catch (error) {
    log(`raise_stats failed: ${message_of(error)}`)
    return stats
  } finally {
    await sleep(1_500)
  }
}

// Spell points (1 per level from level 2, progression.move) raise a spell's cast level — 1→2
// costs 1 point, 2→3 costs 2, etc. Rather than pre-reading the exact invested level (a dynamic
// field, a separate query), just keep raising the best-scoring known spell and stop on the first
// "can't afford the next level"/"already capped" abort — both expected, not real problems,
// bounded by the spell-point budget at most.
//
// "Best" is ranked by REAL expected output, not spell_catalog.ts's raw authored score alone:
// caster_damage_multiplier folds in the character's own live stats through the exact in-game
// formula (fight_math::amplify_damage), and success_rate folds in how often this spell has
// actually landed for this class when tried. A spell with a great raw number but the wrong
// element for this build gets a 1.0x (or near it) multiplier — no better than a weapon strike —
// while a lower-raw-score spell the build actually amplifies can be the real pick. Same weighting
// fight_turn.ts's decide_and_commit_turn uses to CAST each turn, so what gets leveled matches
// what actually carries the fight, not just what a static number ranked highest.
//
// Both a damage spell AND a heal spell get raised: decide_and_commit_turn genuinely casts heal
// spells mid-fight (sim_decide.ts's heal_score branch, whenever an ally's HP fraction drops under
// policy.heal_threshold) — a heal cast at level 0 heals nothing, so leaving it unraised was a
// silent efficiency hole. The budget splits evenly between the two; whatever the heal can't
// spend (already capped / can't afford the next level) rolls over to the damage spell.
const raise_spell_level = async (
  character: BotSdk['character'],
  c: (typeof CHARACTERS)[number],
  spell: string,
  budget: number,
  log: (msg: string) => void
): Promise<number> => {
  let raised = 0
  let todo = budget
  let batch = Math.max(todo, 1)
  while (todo > 0) {
    const attempt = Math.min(batch, todo)
    try {
      await submit_with_retry(
        () => character.raise_spell_many({ character_id: c.id, spell, levels: attempt }),
        log
      )
      raised += attempt
      todo -= attempt
      batch = Math.min(todo, batch)
    } catch (error) {
      // 1602 = capped at the spell's top level, 1603 = not enough points for the next level —
      // both dry-run aborts (zero gas). Halve the batch and retry: the exact affordable count is
      // a sum (n → n+1 costs n points) that grows per level, so a too-big guess aborts cleanly.
      if (!/abort code:\s*(1602|1603)\b/i.test(message_of(error))) {
        log(`raise_spell failed: ${message_of(error)}`)
        break
      }
      if (batch <= 1) break
      batch = Math.floor(batch / 2)
    }
  }
  return raised
}

/** Raises the best damage spell AND the best heal spell (50/50 budget split), ranked by effective
 *  in-game output at the character's CURRENT invested levels (castable_spells folds the actual
 *  spell book in — a spell already sunk to level 5 is scored at level 5, not level 1). Returns
 *  each raised spell's NEW invested level so the caller can build the post-raises sim spell book. */
const raise_best_spells = async (
  character: BotSdk['character'],
  c: (typeof CHARACTERS)[number],
  level: number,
  stats: LiveStats,
  available_spell_points: number,
  spell_levels: Readonly<Record<string, number>>,
  log: (msg: string) => void
): Promise<Readonly<Record<string, number>>> => {
  const spells = castable_spells(c.classe, level, spell_levels)
  const [best_damage_spell] = spells
    .filter((s) => s.role === 'damage')
    .map((s) => ({
      ...s,
      effective_score: s.score * caster_damage_multiplier(s.element, stats) * success_rate(c.classe, s.name),
    }))
    .sort((a, b) => b.effective_score - a.effective_score)
  const [best_heal_spell] = spells
    .filter((s) => s.role === 'support' && s.is_heal)
    .map((s) => ({ ...s, effective_score: s.score * success_rate(c.classe, s.name) }))
    .sort((a, b) => b.effective_score - a.effective_score)

  if (!best_damage_spell && !best_heal_spell) return {}

  let heal_budget = 0
  let damage_budget = available_spell_points
  if (best_damage_spell && best_heal_spell) {
    heal_budget = Math.floor(available_spell_points / 2)
    damage_budget = available_spell_points - heal_budget
  } else if (best_heal_spell) {
    heal_budget = available_spell_points
  }

  const book: Record<string, number> = {}
  let heal_raised = 0
  if (best_heal_spell && heal_budget > 0) {
    heal_raised = await raise_spell_level(character, c, best_heal_spell.name, heal_budget, log)
    if (heal_raised > 0) {
      log(`${c.name} raised ${best_heal_spell.name} by ${heal_raised} level(s)`)
      book[best_heal_spell.name] = (spell_levels[best_heal_spell.name] ?? 1) + heal_raised
    }
  }

  if (best_damage_spell) {
    // Whatever the heal couldn't use (capped / next level unaffordable) rolls into damage.
    const damage_total = damage_budget + (heal_budget - heal_raised)
    if (damage_total > 0) {
      const damage_raised = await raise_spell_level(character, c, best_damage_spell.name, damage_total, log)
      if (damage_raised > 0) {
        log(`${c.name} raised ${best_damage_spell.name} by ${damage_raised} level(s)`)
        book[best_damage_spell.name] = (spell_levels[best_damage_spell.name] ?? 1) + damage_raised
      }
    }
  }
  return book
}

/** Reads the party's live stats, weapons and spell books and, when `can_spend` is true (the
 *  default), spends each character's available stat & spell points via kiosk borrows. Pass
 *  `false` when the party is already seated inside a leftover fight: mid-fight the characters
 *  are dynamic object fields of the Fight object, not in the kiosk, so any raise_stats_many /
 *  raise_spell_many borrow aborts kiosk::borrow_mut EItemNotFound (11). */
export const prepare_party = async (
  bot: BotSdk,
  log: (msg: string) => void,
  can_spend: boolean = true
): Promise<PartyPrep> => {
  const { sdk, character } = bot
  const levels = new Map<string, number>()
  const max_hp = new Map<string, number>()
  const xp_before = new Map<string, number>()
  const sim_party_stats = new Map<string, SimPartyMember>()

  // The sim strikes with the weapon a real fight would resolve (strike_level reads the same
  // chain-side equipment record). Reading all four in parallel; null stays unarmed.
  const equipped = await Promise.all(CHARACTERS.map((c) => read_equipped_weapon(sdk, c.id)))
  // The four live stat reads are independent — run them concurrently instead of strung in series
  // (the stat/spell RAISES below stay strictly per-character and sequential: they share each
  // character's own point budget and must never race each other).
  const livestats = await Promise.all(CHARACTERS.map((c) => read_live_character_stats(sdk, c.id)))
  // Each character's raised-spell book (progression::SpellBookKey): the invested levels the sim
  // and the live turn planner must cast with — the accuracy gap that made every simulated fight
  // under-rate the party's real spell damage/healing (castable_spells scored level 1 forever).
  const spell_books = await Promise.all(CHARACTERS.map((c) => read_spell_book(sdk, c.id)))

  for (let i = 0; i < CHARACTERS.length; i++) {
    const c = CHARACTERS[i]
    const weapon = equipped[i]
    if (weapon && weapon.damages.length > 0)
      log(`${c.name} fights with an equipped ${weapon.category} (${weapon.damages.map((d) => `${d.element} ${d.from}-${d.to}`).join(', ')})`)
    const book = spell_books[i] ?? {}
    if (Object.keys(book).length > 0)
      log(`${c.name} spell book: ${Object.entries(book).map(([name, lvl]) => `${name} lv${lvl}`).join(', ')}`)
    const live = livestats[i]!
    const { level } = live
    levels.set(c.id, level)
    let stats: RawStats = {
      vitality: live.vitality,
      wisdom: live.wisdom,
      strength: live.strength,
      intelligence: live.intelligence,
      chance: live.chance,
      agility: live.agility,
    }
    if (can_spend && live.available_points > 0) stats = await raise_available_stats(character, c, stats, live.available_points, log)
    max_hp.set(c.id, estimate_max_hp(level, stats.vitality))
    xp_before.set(c.id, live.experience)

    // The final sim spell book is the on-chain book plus whatever this prep raises (raise_best_spells
    // returns each raised spell's NEW invested level) — the sim must see the post-spend character.
    let raised_books: Readonly<Record<string, number>> = {}
    if (can_spend && live.available_spell_points > 0)
      raised_books = await raise_best_spells(character, c, level, stats, live.available_spell_points, book, log)
    const final_book = { ...book, ...raised_books }

    sim_party_stats.set(c.id, {
      name: c.name,
      classe: c.classe,
      level,
      weapon: equipped[i] ?? undefined,
      spell_levels: final_book,
      ...stats,
    })
  }

  return { levels, max_hp, xp_before, sim_party_stats }
}
