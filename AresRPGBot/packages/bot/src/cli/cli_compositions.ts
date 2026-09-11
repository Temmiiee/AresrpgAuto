// bun run src/cli_compositions.ts [levels] [scenarios_per_level] [runs_per_scenario] — sweeps
// every possible 4-class party composition (12 classes, duplicates allowed = C(15,4) = 1365
// multisets) against a FIXED battery spanning MULTIPLE levels across the leveling curve, using
// the same simulate_many/trained-policy machinery cli_train.ts validates policies with, and
// ranks by the Wilson-score lower bound of win rate (not raw win rate — a composition tested only
// a handful of times that got lucky shouldn't outrank a well-supported result; mirrors the sibling
// AresRPG-RL repo's tools/compositions.py, which hit this same need first).
//
// Spans levels instead of testing one fixed level (2026-09-04, previous version only tested level
// 10) because "best composition" isn't level-invariant: a level-1 party has ZERO stat points to
// spend (total_points = (level-1)*5 in training_scenarios.ts's build_party), so a class whose
// strength depends on caster_damage_multiplier (stat-scaled damage) can't show that advantage yet
// at all -- confirmed happening live: the level-10-only sweep's top pick (double-mori) was
// recommended for a pair of BRAND NEW level-1 characters, who then struggled, because the
// mechanism behind mori's simulated dominance literally doesn't exist until there are stat points
// to invest. Each battery entry is calibrated against a reference party AT ITS OWN level, so a
// composition's score reflects how it holds up across the WHOLE curve, not one arbitrary point.
//
// The battery is generated ONCE per level and reused for every composition (not calibrated
// per-composition -- calibration nudges difficulty toward a contested band FOR a specific party,
// which would hide real strength differences between compositions by construction).
import { cpus } from 'node:os'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CLASSES, make_rng, random_mob_group, calibrate_group, build_party } from '../ai/training_scenarios.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import { make_composition_worker_pool, type BatteryEntry } from '../ai/composition_worker_pool.ts'

const TEST_LEVELS = (process.argv[2] ?? '3,8,15').split(',').map(Number)
const SCENARIOS_PER_LEVEL = Number(process.argv[3] ?? 3)
const RUNS_PER_SCENARIO = Number(process.argv[4] ?? 2)
const BATTERY_SEED = 424242
const REFERENCE_CLASSES = ['senshi', 'yajin', 'tomoda', 'mori']

// Every non-decreasing 4-tuple of class indices -- combinations WITH repetition (duplicate
// classes allowed, matching how a real party can be uneven), C(12+4-1, 4) = 1365 total.
const all_compositions = (): string[][] => {
  const out: string[][] = []
  const n = CLASSES.length
  for (let a = 0; a < n; a += 1)
    for (let b = a; b < n; b += 1)
      for (let c = b; c < n; c += 1)
        for (let d = c; d < n; d += 1) out.push([CLASSES[a]!, CLASSES[b]!, CLASSES[c]!, CLASSES[d]!])
  return out
}

// Standard Wilson score interval lower bound (95% CI, z=1.96) -- penalizes under-sampled results
// instead of ranking by raw win_rate, which a small-n lucky streak can inflate arbitrarily.
const wilson_lower_bound = (wins: number, n: number, z = 1.96): number => {
  if (n === 0) return 0
  const phat = wins / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = phat + z2 / (2 * n)
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
  return (centre - margin) / denom
}

const pstdev = (values: number[]): number => {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
}

const main = async () => {
  const { policy, source } = load_trained_policy()
  console.log(`Policy: ${source}`)
  console.log(`Test levels: ${TEST_LEVELS.join(', ')}`)

  console.log('Calibrating battery (per level, against reference party senshi+yajin+tomoda+mori)…')
  const battery_rng = make_rng(BATTERY_SEED)
  const battery: BatteryEntry[] = []
  for (const level of TEST_LEVELS) {
    const reference_party = build_party(REFERENCE_CLASSES, level)
    const groups = Array.from({ length: SCENARIOS_PER_LEVEL }, () =>
      calibrate_group(battery_rng, reference_party, random_mob_group(battery_rng, level))
    )
    console.log(`  level ${level}: ${groups.map((g) => g.map((m) => `${m.mob_type}(${m.level})`).join('+')).join(' | ')}`)
    for (const group of groups) battery.push({ level, group: group as BatteryEntry['group'] })
  }

  const compositions = all_compositions()
  const worker_count = Math.max(1, cpus().length - 1)
  const pool = make_composition_worker_pool(worker_count)
  console.log(
    `\nSweeping ${compositions.length} compositions x ${battery.length} scenarios (${TEST_LEVELS.length} levels) x ${RUNS_PER_SCENARIO} runs across ${worker_count} workers…\n`
  )

  const t0 = performance.now()
  let done = 0
  const results = await Promise.all(
    compositions.map(async (classes) => {
      const result = await pool.run({ classes, battery, runs_per_scenario: RUNS_PER_SCENARIO, policy })
      done += 1
      if (done % 100 === 0 || done === compositions.length) {
        const elapsed_s = (performance.now() - t0) / 1000
        const eta_s = (elapsed_s / done) * (compositions.length - done)
        console.log(`  ${done}/${compositions.length} (${elapsed_s.toFixed(0)}s elapsed, ~${eta_s.toFixed(0)}s left)`)
      }
      return {
        classes,
        wilson: wilson_lower_bound(Math.round(result.win_rate * result.total_runs), result.total_runs),
        ...result,
      }
    })
  )
  pool.terminate()

  results.sort((a, b) => b.wilson - a.wilson)

  console.log(`\n=== Top 20 by Wilson lower-bound win rate (across all ${TEST_LEVELS.length} levels) ===`)
  for (const r of results.slice(0, 20))
    console.log(
      `  ${r.classes.join('+').padEnd(45)} win=${(r.win_rate * 100).toFixed(0)}%  wilson=${(r.wilson * 100).toFixed(1)}%  turns_won=${r.avg_turns_when_won.toFixed(0)}  xp/turn=${r.avg_xp_per_turn.toFixed(0)}`
    )

  console.log(`\n=== Bottom 10 by Wilson lower-bound win rate ===`)
  for (const r of results.slice(-10))
    console.log(`  ${r.classes.join('+').padEnd(45)} win=${(r.win_rate * 100).toFixed(0)}%  wilson=${(r.wilson * 100).toFixed(1)}%`)

  const top_half = results.slice(0, Math.floor(results.length / 2))
  const with_spread = top_half.map((r) => ({ ...r, spread: pstdev(r.per_scenario_win_rate) }))
  const generalist = [...with_spread].sort((a, b) => a.spread - b.spread)[0]!
  const specialist = [...with_spread].sort((a, b) => b.spread - a.spread)[0]!
  console.log(
    `\nMost generalist (top-half, lowest win-rate spread across levels+battery): ${generalist.classes.join('+')} (spread=${(generalist.spread * 100).toFixed(1)}pp)`
  )
  console.log(
    `Most specialist (top-half, highest spread): ${specialist.classes.join('+')} (spread=${(specialist.spread * 100).toFixed(1)}pp)`
  )

  // Also report the best pick PER LEVEL specifically -- the aggregate winner might still be a
  // mediocre choice at level 1 specifically if it only pulls ahead once stat points exist; a
  // reader picking classes for brand-new characters cares about the early-game column most.
  console.log(`\n=== Best composition AT EACH level (may differ from the aggregate winner above) ===`)
  for (const [i, level] of TEST_LEVELS.entries()) {
    const start = i * SCENARIOS_PER_LEVEL
    const per_level = results
      .map((r) => ({
        classes: r.classes,
        win_rate: r.per_scenario_win_rate.slice(start, start + SCENARIOS_PER_LEVEL).reduce((a, b) => a + b, 0) / SCENARIOS_PER_LEVEL,
      }))
      .sort((a, b) => b.win_rate - a.win_rate)[0]!
    console.log(`  level ${level}: ${per_level.classes.join('+')} (${(per_level.win_rate * 100).toFixed(0)}% at this level alone)`)
  }

  const out_path = fileURLToPath(new URL('../../composition_sweep_results.json', import.meta.url))
  writeFileSync(out_path, JSON.stringify({ test_levels: TEST_LEVELS, battery, policy_source: source, results }, null, 2))
  console.log(`\nFull results (all ${results.length} compositions) written to ${out_path}`)
}

await main()
