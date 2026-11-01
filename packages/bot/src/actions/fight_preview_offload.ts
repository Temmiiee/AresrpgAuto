import { availableParallelism } from 'node:os'
import type { CharacterRow } from '@aresrpg/protocol'

import type { FightScore, GroupCandidate, ScoreOptions, ScoredGroup } from './fight_preview.ts'
import { nearest_candidates } from './fight_preview.ts'

type PreviewRequest = Readonly<{
  id: number
  character: CharacterRow
  group: GroupCandidate['group']
  allies: readonly CharacterRow[]
  options: ScoreOptions
}>

type Pending = {
  request: PreviewRequest
  resolve: (score: FightScore) => void
  reject: (error: Error) => void
}

type WorkerSlot = { worker: Worker; pending: Pending | null; failed: boolean }

const WORKER_COUNT = Math.max(1, Math.min(6, availableParallelism() - 2))
const queue: Pending[] = []
const slots: WorkerSlot[] = []
let next_id = 0
let initialized = false

const flush = (): void => {
  for (const slot of slots) {
    if (slot.failed || slot.pending) continue
    const pending = queue.shift()
    if (!pending) break
    slot.pending = pending
    try {
      slot.worker.postMessage(pending.request)
    } catch (error) {
      slot.failed = true
      slot.worker.terminate()
      slot.pending = null
      pending.reject(new Error(error instanceof Error ? error.message : String(error)))
      flush()
    }
  }
  if (slots.length > 0 && slots.every((slot) => slot.failed)) {
    while (queue.length) queue.shift()!.reject(new Error('all combat-preview workers failed'))
  }
}

const initialize = (): void => {
  if (initialized) return
  initialized = true
  for (let index = 0; index < WORKER_COUNT; index++) {
    let worker: Worker
    try {
      worker = new Worker(new URL('./fight_preview_worker.ts', import.meta.url), {
        name: `aresrpg-preview-${index + 1}`,
      })
    } catch {
      continue
    }
    const slot: WorkerSlot = { worker, pending: null, failed: false }
    slots.push(slot)
    slot.worker.onmessage = (event: MessageEvent<{ id: number; score?: FightScore; error?: string }>) => {
      const pending = slot.pending
      slot.pending = null
      if (!pending || event.data.id !== pending.request.id) {
        pending?.reject(new Error('combat-preview worker returned an unexpected request id'))
      } else if (event.data.error) {
        pending.reject(new Error(event.data.error))
      } else if (event.data.score) {
        pending.resolve(event.data.score)
      } else {
        pending.reject(new Error('combat-preview worker returned no score'))
      }
      flush()
    }
    slot.worker.onerror = (event: ErrorEvent) => {
      slot.failed = true
      slot.worker.terminate()
      slot.pending?.reject(new Error(event.message || 'combat-preview worker failed'))
      slot.pending = null
      flush()
    }
  }
  if (slots.length === 0) throw new Error('could not start any combat-preview worker')
}

const score_group_offload = (
  character: CharacterRow,
  group: GroupCandidate['group'],
  allies: readonly CharacterRow[],
  options: ScoreOptions = {}
): Promise<FightScore> => new Promise((resolve, reject) => {
  initialize()
  queue.push({
    request: { id: ++next_id, character, group, allies, options },
    resolve,
    reject,
  })
  flush()
})

/** Screen the bounded nearest set concurrently without blocking websocket/state processing. */
export const screen_groups_offload = async (
  pose: Readonly<{ x: number; z: number }>,
  candidates: readonly GroupCandidate[],
  character: CharacterRow,
  allies: readonly CharacterRow[] = []
): Promise<readonly ScoredGroup[]> => {
  const nearby = nearest_candidates(pose, candidates)
  return Promise.all(nearby.map(async (candidate) => Object.freeze({
    candidate,
    score: await score_group_offload(character, candidate.group, allies),
  })))
}
