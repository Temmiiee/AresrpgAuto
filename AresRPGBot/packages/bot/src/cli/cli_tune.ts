// bun run src/cli_tune.ts — read-only (one live stat read, then everything is simulated
// offline). Searches ONE character-build knob: stat_allocation.ts's primary_share (how much of
// each future level-up's points go to the class's damage stat vs vitality). Combat TACTICS
// (target priority, spell choice) are a separate concern handled by cli_train.ts's evolutionary
// search over policy.ts's weight vector — this script always plays with whatever policy that
// produced (falling back to DEFAULT_POLICY), so the two searches don't confound each other.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { simulate_many, fitness_score, type SimPartyMember, type SimMobGroupMember } from '../ai/simulate.ts'
import { split_stat_spending, PRIMARY_STAT_BY_CLASS, DEFAULT_PRIMARY_STAT_SHARE } from '../ai/stat_allocation.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import { read_live_character_stats } from '../shared/live_character.ts'

const RUNS_PER_CELL = 8
// A representative set, not exhaustive — a solo mob and a 3-pack, at/near the party's own level
// so the search reflects fights we'd actually take, not edge cases nobody will ever fight.
const MATCHUPS: readonly { label: string; group: readonly SimMobGroupMember[] }[] = [
  { label: 'solo misui__wind(7)', group: [{ mob_type: 'misui__wind', level: 7 }] },
  {
    label: '3x moka(6)',
    group: [
      { mob_type: 'moka', level: 6 },
      { mob_type: 'moka', level: 6 },
      { mob_type: 'moka', level: 6 },
    ],
  },
]

// How many MORE stat points to imagine each character has earned since now, split by the
// candidate share, on top of their real current baseline — searching the share against today's
// near-zero available_points wouldn't show any difference; this asks "which split serves the
// next several levels," which is the question that actually matters going forward.
const FUTURE_POINTS_BUDGET = 30

const build_party = (
  base: readonly { name: string; classe: string; level: number; vitality: number; primary_value: number }[],
  primary_share: number
): SimPartyMember[] =>
  base.map((c) => {
    const primary_field = PRIMARY_STAT_BY_CLASS[c.classe]
    const spending = split_stat_spending(c.classe, FUTURE_POINTS_BUDGET, c.primary_value, primary_share)
    const added_primary = (primary_field && spending[primary_field]) ?? 0
    const added_vitality = spending.vitality ?? 0
    return {
      name: c.name,
      classe: c.classe,
      level: c.level,
      vitality: c.vitality + added_vitality,
      wisdom: 0,
      strength: primary_field === 'strength' ? c.primary_value + added_primary : 0,
      intelligence: primary_field === 'intelligence' ? c.primary_value + added_primary : 0,
      chance: primary_field === 'chance' ? c.primary_value + added_primary : 0,
      agility: primary_field === 'agility' ? c.primary_value + added_primary : 0,
    }
  })

const main = async () => {
  const policy = load_trained_policy()
  const signer = await get_enoki_signer()
  const { sdk } = create_bot_sdk(signer)
  const base = []
  for (const c of CHARACTERS) {
    const stats = await read_live_character_stats(sdk, c.id)
    const primary_field = PRIMARY_STAT_BY_CLASS[c.classe]
    const primary_value = primary_field ? stats[primary_field] : 0
    base.push({ name: c.name, classe: c.classe, level: stats.level, vitality: stats.vitality, primary_value })
  }

  console.log(`Party: ${base.map((c) => `${c.name}(${c.classe} lv${c.level})`).join(', ')}`)
  console.log(`Combat policy: ${policy.source}`)
  console.log(`Searching primary_share, ${RUNS_PER_CELL} runs/matchup, ${MATCHUPS.length} matchups…\n`)

  const share_candidates = [0.1, 0.3, 0.5, 0.7, 0.9, 1.0]
  const rows: { share: number; avg_score: number }[] = []
  for (const share of share_candidates) {
    const party = build_party(base, share)
    const per_matchup = MATCHUPS.map(({ group }) => simulate_many(party, group, RUNS_PER_CELL, 1n, policy.policy))
    const avg_score = per_matchup.reduce((sum, r) => sum + fitness_score(r), 0) / MATCHUPS.length
    rows.push({ share, avg_score })
    process.stdout.write('.')
  }
  console.log('\n')
  console.log('share  avg_score')
  for (const r of [...rows].sort((a, b) => b.avg_score - a.avg_score))
    console.log(`${r.share.toFixed(1).padStart(5)}  ${r.avg_score.toFixed(2)}`)

  const best = [...rows].sort((a, b) => b.avg_score - a.avg_score)[0]!
  const current = rows.find((r) => r.share === DEFAULT_PRIMARY_STAT_SHARE) ?? rows[0]!
  console.log(`\ncurrent default (share=${DEFAULT_PRIMARY_STAT_SHARE}): avg_score=${current.avg_score.toFixed(2)}`)
  console.log(`best found: share=${best.share}: avg_score=${best.avg_score.toFixed(2)}`)
  const improvement = best.avg_score - current.avg_score
  console.log(
    improvement > 0.5
      ? `→ meaningfully better (+${improvement.toFixed(2)}). Consider updating DEFAULT_PRIMARY_STAT_SHARE.`
      : `→ no meaningful difference from current default (Δ=${improvement.toFixed(2)}) — current setting is already fine for this matchup set.`
  )
}

await main()
