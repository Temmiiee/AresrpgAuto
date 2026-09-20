// Shared worker_threads worker with TWO message protocols, discriminated by shape:
//
// 1) TRAINING (cli_train.ts, via sim_worker_pool.ts — the original contract, kept verbatim):
//    `{ id, scenarios, policy, runs_per_eval }` → evaluates a whole genome's fitness across the
//    scenario set and replies `{ id, fitness }`. One worker per genome, created once per run and
//    reused across generations (each Worker's module graph — this file's imports, spell/mob
//    content tables — only loads once).
//
// 2) SCREENING (fight_discovery.ts, via sim_pool.ts): `{ type: 'fight', job }` → runs
//    simulate_many over ONE mob group and replies `{ type: 'result', result }`. SimBatchResult is
//    all plain numbers except one BigInt input (seed_base) which travels as a decimal string and
//    is rebuilt here. A job failure (e.g. an unknown mob_type the seed content hasn't caught up
//    to yet) yields a null result for THAT group, never a crash of the whole batch — the same
//    "screening skipped" semantics fight_discovery.ts already had per group per candidate.
//
// Both sit on the SAME event channel (Bun exposes worker_threads and the web Worker API over one
// underlying transport), so the discriminator below is all that separates them.
import { simulate_many, fitness_score, type SimBatchResult } from './simulate.ts'
import type { Policy } from './policy.ts'
import type { Scenario } from './training_scenarios.ts'

export type SimWorkerJob = { id: number; scenarios: Scenario[]; policy: Policy; runs_per_eval: number }
export type SimWorkerResult = { id: number; fitness: number }

type FightJob = {
  party: import('./simulate.ts').SimPartyMember[]
  mob_group: import('./simulate.ts').SimMobGroupMember[]
  seed_base: string
  runs: number
  policy: Policy
}
type PoolMessage = { type: 'fight'; job: FightJob }
type Inbound = SimWorkerJob | PoolMessage

declare const self: Worker

self.onmessage = (event: MessageEvent<Inbound>) => {
  const message = event.data

  // Training protocol: a genome-evaluation job carries `scenarios` (and an `id`).
  if ('scenarios' in message) {
    const results = message.scenarios.map(({ party, group }) =>
      simulate_many(party, group, message.runs_per_eval, 1n, message.policy)
    )
    const fitness =
      results.reduce((sum, r) => sum + fitness_score(r), 0) / Math.max(1, results.length)
    postMessage({ id: message.id, fitness } satisfies SimWorkerResult)
    return
  }

  // Screening protocol: `{ type: 'fight', job }`.
  const { party, mob_group, seed_base, runs, policy } = message.job
  let result: SimBatchResult | null = null
  try {
    result = simulate_many(party, mob_group, runs, BigInt(seed_base), policy)
  } catch {
    result = null
  }
  postMessage({ type: 'result', result })
}