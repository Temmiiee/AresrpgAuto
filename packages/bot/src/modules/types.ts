import type { GatheringJob } from '@aresrpg/immutable'

export const CRAFTING_JOBS = Object.freeze([
  'FORGER',
  'CARVER',
  'TAILOR',
  'JEWELER',
  'TANNER',
  'HANDYMAN',
  'ALCHEMIST',
  'BAKER',
] as const)

export type CraftingJob = (typeof CRAFTING_JOBS)[number]
export type SupportedJob = GatheringJob | CraftingJob

export type BotModule =
  | Readonly<{ kind: 'general' }>
  | Readonly<{ kind: 'xp'; character: string | null; target_level: number | null }>
  | Readonly<{
      kind: 'job'
      character: string | null
      job: SupportedJob
      gathering: boolean
      target_level: number | null
    }>
  | Readonly<{ kind: 'craft'; character: string | null; item_type: string; quantity: number }>

export type ModulePlayDefaults = Readonly<{
  gather: boolean
  fight: boolean
  roam: boolean
  craft: boolean
  group: boolean
  dungeon: boolean
  cross_world: boolean
  pet_feed: boolean
  strategy: boolean
  chore_interval_ms: number
}>
