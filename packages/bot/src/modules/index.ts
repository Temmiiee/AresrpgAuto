import type { CharacterRow, ItemRow } from '@aresrpg/protocol'
import { job_level_from_xp } from '@aresrpg/immutable'
import type { GatheringJob } from '@aresrpg/immutable'

import type { ChoreRole } from '../config_types.ts'
import { ITEM_CRAFT_DEFAULTS, item_craft_module } from './item_craft.ts'
import { is_supported_job, job_farm_defaults, job_farm_module } from './job_farm.ts'
import type { BotModule, ModulePlayDefaults } from './types.ts'
import { XP_FARM_DEFAULTS, xp_farm_module } from './xp_farm.ts'

const GENERAL_DEFAULTS: ModulePlayDefaults = Object.freeze({
  gather: true,
  fight: true,
  roam: true,
  craft: true,
  group: true,
  dungeon: true,
  cross_world: true,
  pet_feed: true,
  strategy: true,
  chore_interval_ms: 5 * 60_000,
})

const positive_int = (raw: string | undefined, name: string): number | null => {
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

export const parse_bot_module = (env: Readonly<Record<string, string | undefined>>): BotModule => {
  const kind = (env.BOT_MODULE ?? 'general').trim().toLowerCase()
  const character = env.BOT_MODULE_CHARACTER?.trim() || null
  if (kind === 'general') return Object.freeze({ kind: 'general' })
  if (kind === 'xp') return xp_farm_module(character, positive_int(env.BOT_XP_TARGET_LEVEL, 'BOT_XP_TARGET_LEVEL'))
  if (kind === 'job') {
    const job = env.BOT_JOB_TARGET?.trim().toUpperCase()
    if (!job || !is_supported_job(job))
      throw new Error('BOT_JOB_TARGET must name FARMER, HERBALIST, MINER or a crafting profession')
    return job_farm_module(job, character, positive_int(env.BOT_JOB_TARGET_LEVEL, 'BOT_JOB_TARGET_LEVEL'))
  }
  if (kind === 'craft') {
    const item_type = env.BOT_CRAFT_TARGET?.trim()
    if (!item_type) throw new Error('BOT_CRAFT_TARGET is required when BOT_MODULE=craft')
    return item_craft_module(item_type, positive_int(env.BOT_CRAFT_QUANTITY, 'BOT_CRAFT_QUANTITY') ?? 1, character)
  }
  throw new Error(`BOT_MODULE must be general, xp, job or craft; got "${kind}"`)
}

export const module_defaults = (module: BotModule): ModulePlayDefaults => {
  if (module.kind === 'xp') return XP_FARM_DEFAULTS
  if (module.kind === 'job') return job_farm_defaults(module.gathering)
  if (module.kind === 'craft') return ITEM_CRAFT_DEFAULTS
  return GENERAL_DEFAULTS
}

const target_name = (module: Exclude<BotModule, { kind: 'general' }>, leader_name: string): string =>
  module.character ?? leader_name.toLowerCase()

export const module_chore = (
  module: BotModule,
  character_name: string,
  leader_name: string,
  fallback: ChoreRole
): ChoreRole => {
  const name = character_name.toLowerCase()
  if (module.kind === 'general') return fallback
  if (module.kind === 'xp') return Object.freeze({ kind: 'none' })
  const selected = name === target_name(module, leader_name)
  if (module.kind === 'job') {
    if (module.gathering)
      return selected
        ? Object.freeze({ kind: 'gather', job: module.job as GatheringJob })
        : Object.freeze({ kind: 'none' })
    if (selected) return Object.freeze({ kind: 'craft' })
    // Dedicated gatherers keep supplying the focused crafting profession.
    return fallback.kind === 'gather' ? fallback : Object.freeze({ kind: 'none' })
  }
  if (selected) return Object.freeze({ kind: 'craft' })
  return fallback.kind === 'gather' ? fallback : Object.freeze({ kind: 'none' })
}

export const module_craft_goals = (module: BotModule, inventory: readonly ItemRow[]): readonly string[] => {
  if (module.kind !== 'craft') return Object.freeze([])
  const held = inventory.reduce(
    (total, row) => total + (row.item_type === module.item_type ? Number(row.amount) : 0),
    0
  )
  return held >= module.quantity ? Object.freeze([]) : Object.freeze([module.item_type])
}

export const module_task_complete = (
  module: BotModule,
  characters: readonly CharacterRow[],
  inventory: readonly ItemRow[],
  leader_name: string
): string | null => {
  if (module.kind === 'general') return null
  const selected_name = target_name(module, leader_name)
  const character = characters.find((row) => row.name.toLowerCase() === selected_name)
  if (!character) return null
  if (module.kind === 'xp' && module.target_level !== null && character.level >= module.target_level)
    return `${character.name} reached combat level ${module.target_level}`
  if (module.kind === 'job' && module.target_level !== null) {
    const level = job_level_from_xp(Number(character.jobs?.[module.job] ?? 0))
    if (level >= module.target_level) return `${character.name} reached ${module.job} level ${module.target_level}`
  }
  if (module.kind === 'craft' && module_craft_goals(module, inventory).length === 0)
    return `${module.quantity}× ${module.item_type} owned`
  return null
}

export type { BotModule, ModulePlayDefaults, SupportedJob } from './types.ts'
