import type { BotModule, ModulePlayDefaults } from './types.ts'

/** Pure combat-XP profile: no inventory transactions or gathering detours. */
export const XP_FARM_DEFAULTS: ModulePlayDefaults = Object.freeze({
  gather: false,
  fight: true,
  roam: true,
  craft: false,
  group: true,
  dungeon: false,
  cross_world: false,
  pet_feed: false,
  strategy: true,
  chore_interval_ms: 0,
})

export const xp_farm_module = (
  character: string | null,
  target_level: number | null
): Extract<BotModule, { kind: 'xp' }> =>
  Object.freeze({ kind: 'xp', character: character?.toLowerCase() ?? null, target_level })
