// Reads a character's live DungeonRun straight off its own dynamic field (dungeon.move:
// `DungeonRunKey() -> DungeonRun { dungeon, room, seed }`) — the authoritative source for "am I
// mid-dungeon, and which room," so a crashed/resumed session never has to guess or trust stale
// local state. `read_run` itself isn't a `public fun` in dungeon.move (only `has_run` is), so
// there's no Move view call to simulate the way zone_read.ts reads mob groups — this reads the
// dynamic field directly instead, the same widened-`core` pattern kiosk_listings.ts already
// established for a similar SDK-surface gap.
import type { SuiClientTypes } from '@mysten/sui/client'
import { living_content, type SDK } from '@aresrpg/sdk'
import { dungeon_content_id } from '@aresrpg/sdk/seed-ids'

import { all_dungeons } from './dungeon_content.ts'

type GameSdk = ReturnType<typeof SDK>

type CoreWithDynamicFields = {
  listDynamicFields: (
    options: SuiClientTypes.ListDynamicFieldsOptions
  ) => Promise<SuiClientTypes.ListDynamicFieldsResponse>
}

export type LiveDungeonRun = Readonly<{ dungeon: string; room: number; seed: string }>

/** null when the character holds no active dungeon run. */
export const read_dungeon_run = async (sdk: GameSdk, character_id: string): Promise<LiveDungeonRun | null> => {
  const core = sdk.sui_client.core as unknown as CoreWithDynamicFields
  const { dynamicFields } = await core.listDynamicFields({ parentId: character_id })
  const run_field = dynamicFields.find((f) => f.name?.type?.endsWith('::dungeon::DungeonRunKey'))
  if (!run_field?.fieldId) return null

  const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [run_field.fieldId], include: { json: true } })
  const json = objects[0]?.json as { dungeon?: string; room?: string | number; seed?: string | number } | undefined
  if (!json?.dungeon) return null
  return Object.freeze({ dungeon: json.dungeon, room: Number(json.room ?? 1), seed: String(json.seed ?? '0') })
}

/** MasteryRow's `quest_dungeon` is a content OBJECT ID, not a slug — dungeon_content_id is a
 *  deterministic derivation, so the match is found by computing it for every known dungeon and
 *  comparing, rather than any live lookup. null if it matches none of them (a quest targeting
 *  content this bot's dungeons.json doesn't know about — content drift, not expected in
 *  practice, but worth surfacing rather than silently picking the wrong dungeon). */
export const resolve_quest_dungeon_slug = (sdk: GameSdk, quest_dungeon_id: string): string | null => {
  const { content_root, seed_package_original } = living_content(sdk, 'Daily quest dungeon lookup')
  for (const info of all_dungeons()) {
    if (dungeon_content_id(content_root, seed_package_original, info.dungeon) === quest_dungeon_id) return info.dungeon
  }
  return null
}
