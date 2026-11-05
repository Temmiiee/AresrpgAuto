import type { BotModule, ModulePlayDefaults } from './types.ts'

/** Exact-item mode keeps acquisition enabled but removes every unrelated maintenance objective. */
export const ITEM_CRAFT_DEFAULTS: ModulePlayDefaults = Object.freeze({
  gather: true,
  fight: true,
  roam: true,
  craft: true,
  group: true,
  dungeon: false,
  cross_world: true,
  pet_feed: false,
  strategy: true,
  chore_interval_ms: 30_000,
})

export const item_craft_module = (
  item_type: string,
  quantity: number,
  character: string | null
): Extract<BotModule, { kind: 'craft' }> =>
  Object.freeze({
    kind: 'craft',
    character: character?.toLowerCase() ?? null,
    item_type,
    quantity,
  })
