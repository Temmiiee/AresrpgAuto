// Thin dispatcher over a fixed set of sim_worker.ts instances -- round-robins jobs onto workers
// and resolves as each job's matching reply comes back, so callers see per-genome completions
// as they happen (not batched at the end) for live progress logging. See sim_worker.ts for why
// this exists.
import type { SimWorkerJob, SimWorkerResult } from './sim_worker.ts'
import { create_sim_worker } from './worker_bridge.ts'

export type WorkerPool = {
  /** Runs one job, resolving with its fitness once that job's worker replies. Safe to call many
   *  times without awaiting between calls -- jobs queue on their assigned worker and resolve out
   *  of order as each finishes, which is what lets a whole generation run concurrently. */
  run: (job: Omit<SimWorkerJob, 'id'>) => Promise<number>
  terminate: () => void
}

export const make_worker_pool = (worker_count: number): WorkerPool => {
  const worker_url = new URL('./sim_worker.ts', import.meta.url)
  const workers = Array.from({ length: Math.max(1, worker_count) }, () => create_sim_worker(worker_url))
  let next_id = 0
  let next_worker = 0

  const run = (job: Omit<SimWorkerJob, 'id'>): Promise<number> =>
    new Promise((resolve) => {
      const id = next_id++
      const worker = workers[next_worker]!
      next_worker = (next_worker + 1) % workers.length
      const unsubscribe = worker.onMessage((message) => {
        const reply = message as SimWorkerResult
        if (reply.id !== id) return
        unsubscribe()
        resolve(reply.fitness)
      })
      worker.postMessage({ ...job, id } satisfies SimWorkerJob)
    })

  const terminate = () => workers.forEach((w) => w.terminate())

  return { run, terminate }
}
