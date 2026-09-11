// Persistent worker for cli_compositions.ts's composition sweep (2026-09-04) -- same rationale
// as sim_worker.ts: evaluating one composition against the fixed scenario battery is a pure
// function of (classes, battery, policy), so running many compositions concurrently across Bun
// Workers turns "1365 compositions sequential" into "1365/worker_count batches."
import { simulate_many, fitness_score, type SimMobGroupMember } from './simulate.ts'
import { build_party } from './training_scenarios.ts'
import type { Policy } from './policy.ts'

export type BatteryEntry = { level: number; group: SimMobGroupMember[] }
export type CompositionWorkerJob = {
  id: number
  classes: readonly string[]
  battery: readonly BatteryEntry[]
  runs_per_scenario: number
  policy: Policy
}
export type CompositionWorkerResult = {
  id: number
  win_rate: number
  avg_turns_when_won: number
  avg_xp_per_turn: number
  fitness: number
  per_scenario_win_rate: number[]
  total_runs: number
}

declare const self: Worker

self.onmessage = (event: MessageEvent<CompositionWorkerJob>) => {
  const { id, classes, battery, runs_per_scenario, policy } = event.data
  // Party is rebuilt at EACH entry's own level (2026-09-04: the sweep now spans multiple levels
  // instead of one fixed snapshot -- a composition's real strength includes how well it holds up
  // across the leveling curve, not just at one arbitrary point on it. Confirmed this mattered: a
  // level-1 party has ZERO stat points to spend (total_points = (level-1)*5), so the original
  // level-10-only sweep's "mori dominates" finding literally could not apply to a fresh level-1
  // party -- there was no stat investment yet for caster_damage_multiplier to reward).
  const results = battery.map(({ level, group }) => simulate_many(build_party(classes, level), group, runs_per_scenario, 1n, policy))
  const total_runs = results.reduce((sum, r) => sum + r.runs, 0)
  const total_wins = results.reduce((sum, r) => sum + Math.round(r.win_rate * r.runs), 0)
  const won_weight = results.reduce((sum, r) => sum + r.win_rate * r.runs, 0)
  const avg_turns_when_won =
    won_weight > 0 ? results.reduce((sum, r) => sum + r.avg_turns_when_won * r.win_rate * r.runs, 0) / won_weight : 0
  const avg_xp_per_turn = results.reduce((sum, r) => sum + r.avg_xp_per_turn, 0) / results.length
  const fitness = results.reduce((sum, r) => sum + fitness_score(r), 0) / results.length
  postMessage({
    id,
    win_rate: total_wins / total_runs,
    avg_turns_when_won,
    avg_xp_per_turn,
    fitness,
    per_scenario_win_rate: results.map((r) => r.win_rate),
    total_runs,
  } satisfies CompositionWorkerResult)
}
