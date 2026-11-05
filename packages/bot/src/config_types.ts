import type { GatheringJob } from '@aresrpg/immutable'

export type ChoreRole =
  | Readonly<{ kind: 'craft' }>
  | Readonly<{ kind: 'gather'; job: GatheringJob }>
  | Readonly<{ kind: 'gather_all' }>
  | Readonly<{ kind: 'gather_craft'; job: GatheringJob }>
  | Readonly<{ kind: 'gather_all_craft' }>
  | Readonly<{ kind: 'none' }>

export type ChorePlan = Readonly<Record<string, ChoreRole>>
