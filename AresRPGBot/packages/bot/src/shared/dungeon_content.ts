// Authored dungeon content, read straight from seed/content — dungeon slugs, their key item
// type, and each room's fixed mob composition, in order. Static and fully deterministic (unlike
// open-world mob groups): a dungeon's rooms never change shape at runtime, only the RNG-derived
// board layout within a room does (dungeon.move's board_seed), which this bot doesn't need to
// predict since the chain resolves it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DUNGEONS_PATH = fileURLToPath(new URL('../../../../seed/content/dungeons.json', import.meta.url))
const WORLDS_PATH = fileURLToPath(new URL('../../../../seed/content/worlds.json', import.meta.url))
const RECIPES_PATH = fileURLToPath(new URL('../../../../seed/content/recipes.json', import.meta.url))

type RawDungeon = { dungeon: string; key: string; rooms: { mob_type: string }[][] }
type RawWorldCity = { city: string; x: number; z: number; dungeon?: string }
type RawWorld = { world: string; cities: RawWorldCity[] }

export type DungeonInfo = Readonly<{
  dungeon: string
  key: string
  /** One entry per room, 1-indexed to match dungeon.move's `DungeonRun.room` directly (index 0
   *  is unused padding) — room_of(info, run.room) reads naturally instead of an off-by-one. */
  rooms: readonly (readonly string[])[]
  room_count: number
  /** The world + portal coordinates this dungeon is entered from (worlds.json's city entry that
   *  references this dungeon slug) — needed to know where to travel before `dungeon.enter()`. */
  world: string
  portal_x: number
  portal_z: number
}>

const ALL_DUNGEONS: readonly DungeonInfo[] = (() => {
  const raw_dungeons = JSON.parse(readFileSync(DUNGEONS_PATH, 'utf8')) as RawDungeon[]
  const raw_worlds = JSON.parse(readFileSync(WORLDS_PATH, 'utf8')) as RawWorld[]
  const portal_of = new Map<string, { world: string; x: number; z: number }>()
  for (const w of raw_worlds)
    for (const city of w.cities) if (city.dungeon) portal_of.set(city.dungeon, { world: w.world, x: city.x, z: city.z })

  return Object.freeze(
    raw_dungeons.map((d): DungeonInfo => {
      const portal = portal_of.get(d.dungeon)
      if (!portal) throw new Error(`dungeons.json's "${d.dungeon}" has no portal city in worlds.json`)
      return Object.freeze({
        dungeon: d.dungeon,
        key: d.key,
        rooms: Object.freeze([
          Object.freeze([]), // room 0 padding — rooms are 1-indexed on-chain
          ...d.rooms.map((room) => Object.freeze(room.map((m) => m.mob_type))),
        ]),
        room_count: d.rooms.length,
        world: portal.world,
        portal_x: portal.x,
        portal_z: portal.z,
      })
    })
  )
})()

export const all_dungeons = (): readonly DungeonInfo[] => ALL_DUNGEONS

export const dungeon_by_slug = (slug: string): DungeonInfo | undefined => ALL_DUNGEONS.find((d) => d.dungeon === slug)

/** Room N's mob composition (1-indexed, matching DungeonRun.room straight off the chain). */
export const room_mobs = (info: DungeonInfo, room: number): readonly string[] => {
  const mobs = room >= 1 ? info.rooms[room] : undefined
  if (!mobs) throw new Error(`${info.dungeon} has no room ${room} (room_count=${info.room_count})`)
  return mobs
}

// item_type -> quantity needed per ONE craft attempt. Object key order here is preserved from
// this exact JSON file (JS preserves string-key insertion order) and assumed to match the
// on-chain Recipe's own ingredient order (crafting.move's `craft()` reads input_item_ids
// positionally, one stack per recipe row) — this file IS the seed source those on-chain rows
// were authored from, so the order should already line up; if it's ever wrong, craft() aborts
// cleanly on a template mismatch rather than silently misspending anything.
type RawRecipe = { output_type: string; inputs: Record<string, number> }
const KEY_RECIPES: ReadonlyMap<string, Readonly<Record<string, number>>> = new Map(
  (JSON.parse(readFileSync(RECIPES_PATH, 'utf8')) as RawRecipe[])
    .filter((r) => r.output_type.startsWith('key_of_'))
    .map((r) => [r.output_type, Object.freeze({ ...r.inputs })])
)

/** The ordered ingredient->per-attempt-quantity map for a dungeon key, or undefined if this key
 *  has no known crafting recipe (drops-only). */
export const key_recipe = (key_item_type: string): Readonly<Record<string, number>> | undefined =>
  KEY_RECIPES.get(key_item_type)
