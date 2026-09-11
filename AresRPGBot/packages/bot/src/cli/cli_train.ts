// bun run src/cli_train.ts — the actual "learns by itself" piece. Evolves policy.ts's weight
// vector against the simulator through generations of mutation + selection: no game rule here
// is hand-derived, every weight is discovered by which genomes actually won more simulated
// fights. Not deep RL (no neural net, no gradient signal — there's no ML framework in this
// environment) — this is a (μ+λ) evolution strategy over a small genome, which is a real,
// textbook self-play search method, just a much smaller hypothesis space than a neural policy.
//
// Trains against RANDOM scenarios (training_scenarios.ts): varied party levels, varied mob
// families/counts/levels around each party's own level, and implicitly varied maps (each fight's
// board_seed follows its RNG seed). A fixed easy matchup gives a search nothing to select for —
// everything wins regardless of policy, so every genome looks equally fit. Real spread in
// difficulty (some scenarios losable, most contested) is what makes the fitness signal mean
// anything. No chain calls at all — pure offline simulation.
import { cpus } from 'node:os'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { simulate_many, fitness_score } from '../ai/simulate.ts'
import { clamp_policy, DEFAULT_POLICY, POLICY_KEYS, type Policy } from '../ai/policy.ts'
import { save_trained_policy } from '../ai/policy_store.ts'
import { random_scenarios, type Scenario } from '../ai/training_scenarios.ts'
import { make_worker_pool } from '../ai/sim_worker_pool.ts'

// --resume can appear anywhere among the positional args without disturbing them.
const RESUME = process.argv.includes('--resume')
const positional = process.argv.slice(2).filter((a) => a !== '--resume')
const POPULATION = Number(positional[1] ?? 10)
const GENERATIONS = Number(positional[0] ?? 8)
const SCENARIO_COUNT = Number(positional[2] ?? 8)
// Written after every generation; --resume picks it back up instead of restarting from scratch.
// A machine sleep/reboot mid-run (2026-09-04/05: lost generations 1-12 of a 20-generation run,
// several hours of compute, right after fights started taking much longer post content-update --
// this exact same failure mode already cost the sibling AresRPG-RL repo's Python port a run
// before it got checkpointing, the lesson didn't carry over to this side until it repeated here)
// is exactly what per-generation checkpointing exists to survive.
const CHECKPOINT_PATH = fileURLToPath(new URL('../../train_checkpoint.local.json', import.meta.url))
type Checkpoint = {
  generation: number
  population: Policy[]
  best: { policy: Policy; fitness: number }
  scenarios: Scenario[]
  baseline_fitness: number
}
const save_checkpoint = (checkpoint: Checkpoint): void => writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2))
const load_checkpoint = (): Checkpoint => JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'))
const ELITES = 4
// 3 -> 6 (2026-09-03): matches the config that produced two validated runs on the sibling
// AresRPG-RL repo's Python port -- more runs/scenario means a less noisy fitness signal per
// genome, which is exactly what the held-out gate above needs to be worth trusting.
const RUNS_PER_EVAL = 6
const MUTATION_STD = 0.35
const SCENARIO_SEED = 20260901 // fixed so a training run is reproducible; change to sample a fresh set
// Held-out validation gate (2026-09-03, ported from the sibling AresRPG-RL repo's rl/evolve.py
// after this exact gap bit it there first): without this, a policy is judged and saved purely
// on the same in-sample fitness the search optimized against, which can — and, once, did —
// improve substantially on its own training scenarios while showing ZERO real improvement on
// scenarios never used in training. HOLDOUT_SEED must never equal SCENARIO_SEED.
const HOLDOUT_SEED = 771
const HOLDOUT_SCENARIO_COUNT = 10
const HOLDOUT_RUNS = 8
const MIN_HOLDOUT_IMPROVEMENT = 1

const rand_gaussian = (): number => {
  const u = 1 - Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const mutate = (policy: Policy, std: number): Policy =>
  clamp_policy(Object.fromEntries(POLICY_KEYS.map((key) => [key, policy[key] + rand_gaussian() * std])) as Policy)

const crossover = (a: Policy, b: Policy): Policy =>
  clamp_policy(Object.fromEntries(POLICY_KEYS.map((key) => [key, (a[key] + b[key]) / 2])) as Policy)

const fitness_of = (scenarios: readonly Scenario[], policy: Policy): number => {
  const results = scenarios.map(({ party, group }) => simulate_many(party, group, RUNS_PER_EVAL, 1n, policy))
  return results.reduce((sum, r) => sum + fitness_score(r), 0) / scenarios.length
}

const describe = (policy: Policy): string => POLICY_KEYS.map((k) => `${k}=${policy[k].toFixed(2)}`).join(' ')

const main = async () => {
  let scenarios: Scenario[]
  let population: Policy[]
  let best: { policy: Policy; fitness: number }
  let baseline_fitness: number
  let start_gen: number

  if (RESUME) {
    if (!existsSync(CHECKPOINT_PATH)) throw new Error(`--resume was passed but no checkpoint exists at ${CHECKPOINT_PATH}`)
    console.log(`[checkpoint] resuming from ${CHECKPOINT_PATH}`)
    const ckpt = load_checkpoint()
    scenarios = ckpt.scenarios
    population = ckpt.population
    best = ckpt.best
    baseline_fitness = ckpt.baseline_fitness
    start_gen = ckpt.generation + 1
    console.log(`[checkpoint] resuming at generation ${start_gen}/${GENERATIONS}, all_time_best=${best.fitness.toFixed(2)}`)
    console.log(`Scenarios (${scenarios.length}):`)
    for (const s of scenarios) console.log(`  ${s.label}`)
  } else {
    scenarios = [...random_scenarios(SCENARIO_SEED, SCENARIO_COUNT)]
    console.log(`Scenarios (${scenarios.length}):`)
    for (const s of scenarios) console.log(`  ${s.label}`)
    console.log(`\nEvolving ${POPULATION} genomes x ${GENERATIONS} generations, ${RUNS_PER_EVAL} runs/scenario…\n`)

    baseline_fitness = fitness_of(scenarios, DEFAULT_POLICY)
    console.log(
      `gen 0 baseline (untrained default): fitness=${baseline_fitness.toFixed(2)}  [${describe(DEFAULT_POLICY)}]`
    )

    population = [DEFAULT_POLICY, ...Array.from({ length: POPULATION - 1 }, () => mutate(DEFAULT_POLICY, MUTATION_STD))]
    best = { policy: DEFAULT_POLICY, fitness: baseline_fitness }
    start_gen = 1
  }

  // One worker per genome the pool can run concurrently, capped at core count minus one (leave
  // the main thread's own core free for dispatch/logging) and at POPULATION (no point idling
  // workers that would never get a job). See sim_worker.ts for why this is safe: each genome's
  // fitness_of call is pure, no state crosses between them.
  const worker_count = Math.max(1, Math.min(POPULATION, cpus().length - 1))
  const pool = make_worker_pool(worker_count)
  console.log(`Using ${worker_count} parallel workers for genome evaluation.\n`)

  try {
    for (let gen = start_gen; gen <= GENERATIONS; gen += 1) {
      // Per-genome progress, not just per-generation: a generation here can run tens of
      // minutes at real scale, and a silent multi-minute gap is exactly what cost real
      // wall-clock time on the sibling AresRPG-RL repo's Python port before it added this
      // same visibility (2026-09-02/03) -- no reason to make that mistake twice. Genomes now
      // complete out of submission order (they're running concurrently across workers), so
      // logs are tagged by genome index rather than assumed sequential.
      console.log(`gen ${gen}: evaluating ${population.length} genomes across ${worker_count} workers...`)
      const t_gen = performance.now()
      const scored = await Promise.all(
        population.map(async (policy, i) => {
          const t0 = performance.now()
          const fitness = await pool.run({ scenarios, policy, runs_per_eval: RUNS_PER_EVAL })
          console.log(`  genome ${i + 1}/${population.length} fitness=${fitness.toFixed(2)} (${((performance.now() - t0) / 1000).toFixed(0)}s)`)
          return { policy, fitness }
        })
      )
      scored.sort((a, b) => b.fitness - a.fitness)
      if (scored[0]!.fitness > best.fitness) best = scored[0]!
      console.log(
        `gen ${gen}: best_this_gen=${scored[0]!.fitness.toFixed(2)}  all_time_best=${best.fitness.toFixed(2)}  [${describe(scored[0]!.policy)}]  (${((performance.now() - t_gen) / 1000).toFixed(0)}s total)`
      )

      const elites = scored.slice(0, ELITES).map((s) => s.policy)
      const std = MUTATION_STD * (1 - gen / (GENERATIONS + 1)) // anneal: explore less as generations pass
      const next: Policy[] = [best.policy] // elitism: never lose the all-time best
      while (next.length < POPULATION) {
        const parent_a = elites[Math.floor(Math.random() * elites.length)]!
        const parent_b = elites[Math.floor(Math.random() * elites.length)]!
        next.push(mutate(crossover(parent_a, parent_b), std))
      }
      population = next
      save_checkpoint({ generation: gen, population, best, scenarios, baseline_fitness })
    }
  } finally {
    pool.terminate()
  }

  console.log(`\nbaseline fitness (training set): ${baseline_fitness.toFixed(2)}`)
  console.log(`best found (training set):       ${best.fitness.toFixed(2)}  [${describe(best.policy)}]`)

  console.log(`\nCalibrating ${HOLDOUT_SCENARIO_COUNT} held-out scenarios (seed=${HOLDOUT_SEED})...`)
  const holdout_scenarios = random_scenarios(HOLDOUT_SEED, HOLDOUT_SCENARIO_COUNT)
  const holdout_fitness_of = (policy: Policy): number => {
    const results = holdout_scenarios.map(({ party, group }) => simulate_many(party, group, HOLDOUT_RUNS, 1n, policy))
    return results.reduce((sum, r) => sum + fitness_score(r), 0) / holdout_scenarios.length
  }
  const holdout_default_fitness = holdout_fitness_of(DEFAULT_POLICY)
  const holdout_best_fitness = holdout_fitness_of(best.policy)
  const holdout_improvement = holdout_best_fitness - holdout_default_fitness
  console.log(`held-out default fitness: ${holdout_default_fitness.toFixed(2)}`)
  console.log(`held-out best fitness:    ${holdout_best_fitness.toFixed(2)}`)
  console.log(
    `training-set improvement: +${(best.fitness - baseline_fitness).toFixed(2)}   held-out improvement: ${holdout_improvement >= 0 ? '+' : ''}${holdout_improvement.toFixed(2)}`
  )

  if (holdout_improvement >= MIN_HOLDOUT_IMPROVEMENT) {
    save_trained_policy({
      policy: best.policy,
      trained_at: new Date().toISOString(),
      generations: GENERATIONS,
      fitness: best.fitness,
      matchups: scenarios.map((s) => s.label),
    })
    console.log(
      `→ validated: +${holdout_improvement.toFixed(2)} over default on held-out data. Saved to learned_policy.local.json — fight_session.ts will pick it up next fight.`
    )
  } else {
    console.log(
      `→ only ${holdout_improvement >= 0 ? '+' : ''}${holdout_improvement.toFixed(2)} over default on held-out data (needed >= +${MIN_HOLDOUT_IMPROVEMENT}) — NOT saving. The training-set improvement alone doesn't mean this generalizes.`
    )
  }
}

await main()
