// Persistent worker for cli_train.ts's genome evaluation (2026-09-03). Evolutionary search is
// embarrassingly parallel across genomes within a generation -- each genome's fitness_of call
// is a pure function of (scenarios, policy) with no shared state, and simulate_fight only ever
// touches its own local @aresrpg/fight instance. Running one genome per Bun Worker (real OS
// threads, not the single-threaded event loop) turns "population sequential fitness calls" into
// "population/worker_count batches," which is the actual lever behind cli_train.ts's wall-clock
// time -- the engine itself (fight.apply/candidates) is already about as fast as it gets, see
// the profiling notes in the sibling AresRPG-RL repo's docs/DESIGN_NOTES.md.
//
// Workers are created once per run and reused across generations (worker_pool.ts) rather than
// spawned per genome, since each Worker's own module graph (this file's imports, spell/mob
// content tables) only needs loading once.
import { simulate_many, fitness_score } from './simulate.ts'
import type { Policy } from './policy.ts'
import type { Scenario } from './training_scenarios.ts'

export type SimWorkerJob = { id: number; scenarios: Scenario[]; policy: Policy; runs_per_eval: number }
export type SimWorkerResult = { id: number; fitness: number }

declare const self: Worker

self.onmessage = (event: MessageEvent<SimWorkerJob>) => {
  const { id, scenarios, policy, runs_per_eval } = event.data
  const results = scenarios.map(({ party, group }) => simulate_many(party, group, runs_per_eval, 1n, policy))
  const fitness = results.reduce((sum, r) => sum + fitness_score(r), 0) / scenarios.length
  postMessage({ id, fitness } satisfies SimWorkerResult)
}
