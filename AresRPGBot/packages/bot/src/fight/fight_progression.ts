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
// field, a separate query), just keep raising the best-scoring known damage spell and stop on
// the first "can't afford the next level"/"already capped" abort — both expected, not real
// problems, bounded by available_spell_points attempts at most.
//
// "Best" is ranked by REAL expected damage, not spell_catalog.ts's raw authored score alone:
// caster_damage_multiplier folds in the character's own live stats through the exact in-game
// formula (fight_math::amplify_damage), and success_rate folds in how often this spell has
// actually landed for this class when tried. A spell with a great raw number but the wrong
// element for this build gets a 1.0x (or near it) multiplier — no better than a weapon strike —
// while a lower-raw-score spell the build actually amplifies can be the real pick. Same weighting
// fight_turn.ts's decide_and_commit_turn uses to CAST each turn, so what gets leveled matches
// what actually carries the fight, not just what a static number ranked highest.
const raise_best_damage_spell = async (
  character: BotSdk['character'],
  c: (typeof CHARACTERS)[number],
  level: number,
  stats: LiveStats,
  available_spell_points: number,
  log: (msg: string) => void
): Promise<void> => {
  const [best_damage_spell] = castable_spells(c.classe, level)
    .filter((s) => s.role === 'damage')
    .map((s) => ({
      ...s,
      effective_score: s.score * caster_damage_multiplier(s.element, stats) * success_rate(c.classe, s.name),
    }))
    .sort((a, b) => b.effective_score - a.effective_score)
  if (!best_damage_spell) return

  let raised = 0
  for (let attempt = 0; attempt < available_spell_points; attempt += 1) {
    try {
      await submit_with_retry(() => character.raise_spell({ character_id: c.id, spell: best_damage_spell.name }), log)
      raised += 1
    } catch (error) {
      if (!/abort code:\s*(1602|1603)\b/i.test(message_of(error))) log(`raise_spell failed: ${message_of(error)}`)
      break
    }
    // Same spacing every other rapid-fire kiosk-touching loop in this file uses (join, ready,
    // settle) — missing it here caused a real "provided version doesn't match" race that killed
    // a whole fight attempt (2026-09-01, live).
    await sleep(2_000)
  }
  if (raised > 0) log(`${c.name} raised ${best_damage_spell.name} by ${raised} level(s)`)
}

export const prepare_party = async (bot: BotSdk, log: (msg: string) => void): Promise<PartyPrep> => {
  const { sdk, character } = bot
  const levels = new Map<string, number>()
  const max_hp = new Map<string, number>()
  const xp_before = new Map<string, number>()
  const sim_party_stats = new Map<string, SimPartyMember>()

  for (const c of CHARACTERS) {
    const live = await read_live_character_stats(sdk, c.id)
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
    if (live.available_points > 0) stats = await raise_available_stats(character, c, stats, live.available_points, log)
    max_hp.set(c.id, estimate_max_hp(level, stats.vitality))
    xp_before.set(c.id, live.experience)

    if (live.available_spell_points > 0)
      await raise_best_damage_spell(character, c, level, stats, live.available_spell_points, log)

    sim_party_stats.set(c.id, { name: c.name, classe: c.classe, level, ...stats })
  }

  return { levels, max_hp, xp_before, sim_party_stats }
}
