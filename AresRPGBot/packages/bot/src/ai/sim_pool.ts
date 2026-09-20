// Screens many candidate mob groups against one party as fast as the machine allows — the
// offline fight simulations in fight_discovery.ts used to run strictly one-after-another
// (10 candidates × 5 runs = 50 fights × ~1-2s each = a quiet 55-90s+ stretch before the pick;
// measured 2026-09-17), even though each fight is independent CPU-bound work with zero shared
// state. This farms the batches out to worker_threads so they overlap across cores.
//
// How it works: a worker per jobs-in-flight (up to `count`), each worker loads its own copy of
// @aresrpg/fight + the seed content once at first job, then runs its share of simulate_many with
// the same call signature (see sim_worker.ts for the wire format). Results are plain numbers; the
// only BigInt (seed_base) travels as a decimal string. Falls back to in-process sequential
// simulate_many when there's nothing to parallelize (1 job) or worker_threads is unavailable —
// a screening bug must never silently drop results.
//
// Determinism contract: seed_base is IDENTICAL per candidate group in both the parallel and the
// sequential paths (both default to 1), and each fight's outcome depends only on (party,
// mob_group, seed, policy) — so parallel batches produce the exact same SimBatchResult values
// the old sequential loop did, just sooner.
import { simulate_many, type SimBatchResult, type SimMobGroupMember, type SimPartyMember } from './simulate.ts'
import { DEFAULT_POLICY, type Policy } from './policy.ts'
import { create_sim_worker } from './worker_bridge.ts'

export type ParallelSimGroup = {
  mob_group: SimMobGroupMember[]
  runs?: number
  seed_base?: bigint
}

const WORKER_URL = new URL('./sim_worker.ts', import.meta.url)

const default_worker_count = (): number => {
  const from_env = Number(process.env.SIM_WORKERS)
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  const capped = Math.max(1, Math.min(cores - 1, 8))
  return Number.isFinite(from_env) && from_env >= 1 ? from_env : capped
}

// Runs one job on a fresh worker and resolves its result (null when THAT job failed, degrading
// to the caller's "screening skipped" path exactly like the old per-candidate try/catch).
const run_worker_job = (
  party: SimPartyMember[],
  mob_group: SimMobGroupMember[],
  seed_base: bigint,
  runs: number,
  policy: Policy
): Promise<SimBatchResult | null> =>
  new Promise((resolve, reject) => {
    const worker = create_sim_worker(WORKER_URL)
    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new Error('sim worker timed out'))
    }, 120_000)
    const unsubscribe_error = worker.onError((error) => {
      clearTimeout(timeout)
      unsubscribe_error()
      worker.terminate()
      reject(error)
    })
    const unsubscribe_message = worker.onMessage((message) => {
      const reply = message as { type: string; result?: SimBatchResult | null }
      clearTimeout(timeout)
      unsubscribe_message()
      unsubscribe_error()
      worker.terminate()
      if (reply.type === 'result') resolve(reply.result ?? null)
      else reject(new Error(`sim worker unexpected reply: ${reply.type}`))
    })
    worker.postMessage({
      type: 'fight',
      job: { party, mob_group, seed_base: seed_base.toString(), runs, policy },
    })
  })

/** Runs `groups` screens against `party`, returning one SimBatchResult (or null for a group that
 *  failed to simulate) per group — same order as input. Parallel across up to `count` workers;
 *  sequential fallback when only one group. */
export const simulate_many_parallel = async (
  party: SimPartyMember[],
  groups: readonly ParallelSimGroup[],
  policy: Policy = DEFAULT_POLICY,
  count = default_worker_count()
): Promise<(SimBatchResult | null)[]> => {
  if (groups.length === 0) return []
  if (groups.length === 1 || count <= 1) {
    const { mob_group, runs = 5, seed_base = 1n } = groups[0]!
    try {
      return [simulate_many(party, mob_group, runs, seed_base, policy)]
    } catch {
      return [null]
    }
  }

  const results = new Array<SimBatchResult | null>(groups.length)
  const worker_count = Math.min(count, groups.length)
  for (let offset = 0; offset < groups.length; offset += worker_count) {
    const slice = groups.slice(offset, offset + worker_count)
    const pending = slice.map(({ mob_group, runs = 5, seed_base = 1n }, local) =>
      run_worker_job(party, mob_group, seed_base, runs, policy).then((result) => {
        results[offset + local] = result
      })
    )
    await Promise.all(pending)
  }
  return results
}