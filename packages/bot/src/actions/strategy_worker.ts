import { compute_strategy } from './strategy.ts'
import { strategy_state_from, type StrategyInput, type StrategyReply } from './strategy_offload.ts'

const worker_scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<StrategyInput>) => void) | null
  postMessage: (message: StrategyReply) => void
}

worker_scope.onmessage = ({ data }: MessageEvent<StrategyInput>): void => {
  try {
    const strategy = compute_strategy(data.characters, strategy_state_from(data), data.options)
    worker_scope.postMessage({ ok: true, strategy })
  } catch (error) {
    worker_scope.postMessage({
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
  }
}
