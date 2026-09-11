// bun run src/cli_character_report.ts — read-only. Prints each character's current level/stats
// and their full castable spell kit (what unlocks at their CURRENT level, sorted by EFFECTIVE
// score — raw damage/AP amplified by this character's own live stats, the same ranking
// raise_best_damage_spell and decide_and_commit_turn actually use), so "what will the bot
// actually prefer for this character" is one command instead of a chain explorer + spells.json
// cross-reference by hand.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { castable_spells } from '../ai/spell_catalog.ts'
import { PRIMARY_STAT_BY_CLASS, caster_damage_multiplier } from '../ai/stat_allocation.ts'
import { read_live_character_stats } from '../shared/live_character.ts'

const signer = await get_enoki_signer()
const { sdk } = create_bot_sdk(signer)

for (const c of CHARACTERS) {
  const live = await read_live_character_stats(sdk, c.id)
  const primary_stat = PRIMARY_STAT_BY_CLASS[c.classe]

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${c.name}  (${c.classe}, level ${live.level})${c.leader ? '  [leader]' : ''}`)
  console.log(
    `  xp: ${live.experience}   available stat points: ${live.available_points}   available spell points: ${live.available_spell_points}`
  )
  console.log(
    `  vitality: ${live.vitality}   strength: ${live.strength}   intelligence: ${live.intelligence}   chance: ${live.chance}   agility: ${live.agility}   wisdom: ${live.wisdom}`
  )
  console.log(
    `  primary damage stat for this class: ${primary_stat ?? '(unknown class — falls back to vitality-only)'}`
  )

  const spells = castable_spells(c.classe, live.level).map((s) => ({
    ...s,
    multiplier: caster_damage_multiplier(s.element, live),
  }))
  if (spells.length === 0) {
    console.log('  no spells unlocked yet at this level')
    continue
  }
  const ranked = [...spells].sort((a, b) => b.score * b.multiplier - a.score * a.multiplier)
  const [top_damage_spell] = ranked.filter((s) => s.role === 'damage')
  console.log(
    `  spells (${spells.length}, sorted by EFFECTIVE score = raw score × this character's own damage multiplier):`
  )
  for (const s of ranked) {
    const range = s.range_min === s.range_max ? `${s.range_min}` : `${s.range_min}-${s.range_max}`
    const effective = (s.score * s.multiplier).toFixed(2)
    const mismatch = s.role === 'damage' && s.element && s.multiplier <= 1 ? '  ⚠ off-build element, no stat bonus' : ''
    // raise_best_damage_spell also weighs learned success_rate (spell-memory.local.json), not
    // shown here — this marks the build-fit favorite, usually but not always the exact pick.
    const next_to_level = s.name === top_damage_spell?.name ? '  ← build-fit favorite for the next spell point' : ''
    console.log(
      `    ${s.name.padEnd(20)} role=${s.role.padEnd(7)} ap=${s.ap_cost}  range=${range}${s.line_of_sight ? '' : ' (no LoS needed)'}  raw=${s.score.toFixed(2)}  effective=${effective}${s.is_heal ? '  [heal]' : ''}${mismatch}${next_to_level}`
    )
  }
}
console.log(`\n${'='.repeat(60)}`)
