// Worker transport bridge for sim_worker.ts. Bun on Windows (v1.4.x) has a broken
// node:worker_threads emulation for the MAIN->WORKER direction: a worker's module evaluates,
// its event loop runs, and worker->main postMessage works, but messages posted FROM the main
// thread are never delivered — so `self.onmessage` never fires and every job dies on the
// run_worker_job 120s timeout (seen live 2026-09-18: every screening battle aborted with
// "sim worker timed out" even though in-process simulation of the same group took ~10s).
// Bun's native web Worker (the global `Worker`, no import) is not affected — verified with a
// ping worker: bidirectional messaging works. This module picks the web Worker when the
// global constructor exists (Bun), and falls back to node:worker_threads only where that
// global is absent (plain Node.js), so sim_pool.ts / sim_worker_pool.ts keep one transport
// seam instead of each handling the shape difference themselves.
import type { Worker as NodeWorker } from 'node:worker_threads'
import { Worker as NodeWorkerImpl } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

export type SimWorkerHandle = {
  postMessage: (message: unknown) => void
  terminate: () => void
  /** Registers a message handler; returns an unsubscribe function. */
  onMessage: (handler: (data: unknown) => void) => () => void
  /** Registers an error handler; returns an unsubscribe function. */
  onError: (handler: (error: Error) => void) => () => void
}

// `typeof Worker` is safe to reference even where the identifier is undeclared (no ReferenceError
// in the typeof guard), so the web path is picked on Bun and the node fallback elsewhere.
const HAS_WEB_WORKER = typeof Worker === 'function'

export const create_sim_worker = (entry: URL): SimWorkerHandle => {
  if (HAS_WEB_WORKER) {
    const worker: Worker = new Worker(entry)
    return {
      postMessage: (message) => worker.postMessage(message),
      terminate: () => void worker.terminate(),
      onMessage: (handler) => {
        const listener = (event: MessageEvent<unknown>) => handler(event.data)
        worker.addEventListener('message', listener)
        return () => worker.removeEventListener('message', listener)
      },
      onError: (handler) => {
        const listener = (event: ErrorEvent) => handler(new Error(event.message || 'sim worker error'))
        worker.addEventListener('error', listener)
        return () => worker.removeEventListener('error', listener)
      },
    }
  }

  const worker: NodeWorker = new NodeWorkerImpl(fileURLToPath(entry))
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => void worker.terminate(),
    onMessage: (handler) => {
      const listener = (message: unknown) => handler(message)
      worker.on('message', listener)
      return () => worker.off('message', listener)
    },
    onError: (handler) => {
      const listener = (error: Error) => handler(error)
      worker.on('error', listener)
      return () => worker.off('error', listener)
    },
  }
}