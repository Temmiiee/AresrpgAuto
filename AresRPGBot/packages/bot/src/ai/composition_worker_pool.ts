// Thin dispatcher over composition_worker.ts instances -- same round-robin/out-of-order-resolve
// pattern as sim_worker_pool.ts (cli_train.ts), duplicated rather than generalized: the two
// pools carry different job/result shapes and this one is small enough that sharing isn't worth
// risking cli_train.ts's already-validated pool.
import type { CompositionWorkerJob, CompositionWorkerResult, BatteryEntry } from './composition_worker.ts'
export type { BatteryEntry }

export type CompositionWorkerPool = {
  run: (job: Omit<CompositionWorkerJob, 'id'>) => Promise<CompositionWorkerResult>
  terminate: () => void
}

export const make_composition_worker_pool = (worker_count: number): CompositionWorkerPool => {
  const worker_url = new URL('./composition_worker.ts', import.meta.url)
  const workers = Array.from({ length: Math.max(1, worker_count) }, () => new Worker(worker_url))
  let next_id = 0
  let next_worker = 0

  const run = (job: Omit<CompositionWorkerJob, 'id'>): Promise<CompositionWorkerResult> =>
    new Promise((resolve) => {
      const id = next_id++
      const worker = workers[next_worker]!
      next_worker = (next_worker + 1) % workers.length
      const on_message = (event: MessageEvent<CompositionWorkerResult>) => {
        if (event.data.id !== id) return
        worker.removeEventListener('message', on_message)
        resolve(event.data)
      }
      worker.addEventListener('message', on_message)
      worker.postMessage({ ...job, id } satisfies CompositionWorkerJob)
    })

  const terminate = () => workers.forEach((w) => w.terminate())

  return { run, terminate }
}
