// One live character read, reused everywhere a caller needs a character's current numeric
// stats straight from chain — fight_session.ts (pre-fight stat/spell spending), cli_tune.ts and
// cli_simulate_session.ts (simulated-party construction) all read the exact same fields.
import type { Sdk } from '@aresrpg/sdk'

// Table-driven so adding a field is one row, not another Number(json?.x ?? y) expression —
// keeps this a flat data transform instead of a wall of near-identical branches.
const NUMERIC_FIELDS = {
  level: 1,
  vitality: 0,
  wisdom: 0,
  strength: 0,
  intelligence: 0,
  chance: 0,
  agility: 0,
  experience: 0,
  available_points: 0,
  available_spell_points: 0,
} as const

export type LiveCharacterStats = Readonly<{ [K in keyof typeof NUMERIC_FIELDS]: number }>

export const read_live_character_stats = async (sdk: Sdk, character_id: string): Promise<LiveCharacterStats> => {
  const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [character_id], include: { json: true } })
  const json = (objects[0]?.json ?? {}) as Record<string, unknown>
  const entries = Object.entries(NUMERIC_FIELDS).map(([key, fallback]) => [key, Number(json[key] ?? fallback)])
  return Object.freeze(Object.fromEntries(entries)) as LiveCharacterStats
}
