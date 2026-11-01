import type { CharacterRow, MobGroupRow } from '@aresrpg/protocol'

import { mob_inputs, score_mobs, type FightScore, type ScoreOptions } from './fight_preview.ts'

type PreviewRequest = Readonly<{
  id: number
  character: CharacterRow
  group: MobGroupRow
  allies: readonly CharacterRow[]
  options: ScoreOptions
}>

type PreviewReply = Readonly<{ id: number; score: FightScore }> | Readonly<{ id: number; error: string }>

const worker_scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PreviewRequest>) => void) | null
  postMessage: (message: PreviewReply) => void
}

worker_scope.onmessage = ({ data }: MessageEvent<PreviewRequest>): void => {
  try {
    worker_scope.postMessage({
      id: data.id,
      score: score_mobs(data.character, mob_inputs(data.group), data.allies, data.options),
    })
  } catch (error) {
    worker_scope.postMessage({
      id: data.id,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
  }
}

export type { PreviewReply, PreviewRequest }
