import type { GatheringJob } from '@aresrpg/immutable'

import { GATHERING_JOBS } from '../config_jobs.ts'
import { CRAFTING_JOBS, type BotModule, type ModulePlayDefaults, type SupportedJob } from './types.ts'

export const is_supported_job = (raw: string): raw is SupportedJob =>
  (GATHERING_JOBS as readonly string[]).includes(raw) || (CRAFTING_JOBS as readonly string[]).includes(raw)

export const is_gathering_job = (job: SupportedJob): job is GatheringJob =>
  (GATHERING_JOBS as readonly string[]).includes(job)

export const job_farm_defaults = (gathering: boolean): ModulePlayDefaults =>
  Object.freeze({
    gather: true,
    // Craft professions need mob-only ingredients; gathering professions fight only their
    // resource protectors through the ambush recovery path.
    fight: !gathering,
    roam: !gathering,
    craft: !gathering,
    group: !gathering,
    dungeon: false,
    cross_world: gathering,
    pet_feed: false,
    strategy: !gathering,
    chore_interval_ms: 30_000,
  })

export const job_farm_module = (
  job: SupportedJob,
  character: string | null,
  target_level: number | null
): Extract<BotModule, { kind: 'job' }> =>
  Object.freeze({
    kind: 'job',
    character: character?.toLowerCase() ?? null,
    job,
    gathering: is_gathering_job(job),
    target_level,
  })
