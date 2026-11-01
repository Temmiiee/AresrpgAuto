import type { CharacterRow } from '@aresrpg/protocol'

import type { GameState } from '../state/store.ts'
import { initial_game_state } from '../state/store.ts'
import type { FarmOptions, Strategy } from './strategy.ts'

type StrategyInput = Readonly<{
  characters: readonly CharacterRow[]
  state: Pick<GameState, 'characters' | 'inventory' | 'listings'>
  options: FarmOptions & Readonly<{ now_ms?: number }>
}>

type StrategyReply = Readonly<{ ok: true; strategy: Strategy }> | Readonly<{ ok: false; error: string }>

/** Run the CPU-heavy, pure strategy scan away from the realtime session's event loop. */
export const compute_strategy_offload = (
  characters: readonly CharacterRow[],
  state: GameState,
  options: FarmOptions & Readonly<{ now_ms?: number }>
): Promise<Strategy> => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./strategy_worker.ts', import.meta.url), { name: 'aresrpg-strategy' })
  let settled = false
  const finish = (reply: StrategyReply): void => {
    if (settled) return
    settled = true
    worker.terminate()
    if (reply.ok) resolve(reply.strategy)
    else reject(new Error(reply.error))
  }
  worker.onmessage = (event: MessageEvent<StrategyReply>) => finish(event.data)
  worker.onerror = (event: ErrorEvent) => finish({ ok: false, error: event.message || 'strategy worker failed' })

  const input: StrategyInput = {
    characters,
    // Strategy only reads the roster, inventory, and active listings. Avoid cloning live zone
    // populations and fight checkpoints into the worker for no benefit.
    state: {
      characters: state.characters,
      inventory: state.inventory,
      listings: state.listings,
    },
    options,
  }
  try {
    worker.postMessage(input)
  } catch (error) {
    finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

/** Rebuild the small projection consumed by the pure strategy planner in the worker. */
export const strategy_state_from = (input: StrategyInput): GameState => ({
  ...initial_game_state,
  characters: input.state.characters,
  inventory: input.state.inventory,
  listings: input.state.listings,
})

export type { StrategyInput, StrategyReply }
