// Reads a character's raised-spell book straight off its `progression::SpellBookKey` dynamic
// field (progression.move: a VecMap<String, u8> keyed by spell name -> invested level; a spell
// absent from the map sits at its self-learned level 1). This is the missing half of the
// pre-fight accuracy picture: prepare_party was raising spells on-chain (raise_spell_many) but
// never reading the invested levels back, so the offline simulator fought every spell at level 1
// no matter how many points had actually been invested — a silent, compounding under-estimate
// of the party's real damage/healing (the same class of gap read_equipped_weapon closed for the
// weapon slot).
//
// Read shape: the node's own JSON decode of the DF value mirrors the EquipmentKey read in
// equipped_weapon.ts (same widened-core pattern) — `{ value: { contents: [{ key, value }] } }`
// where each pair is `{ key: string, value: u8 }`. No hand-rolled BCS decoder (L-D4).
//
// Defensive by contract: ANY shape mismatch yields {} (every spell at level 1) — never throws.
// A wrong read must not abort a battle prep; level 1 is the honest "self-learned default".
import type { SuiClientTypes } from '@mysten/sui/client'

import type { SDK } from '@aresrpg/sdk'

type GameSdk = ReturnType<typeof SDK>

type CoreWithDynamicFields = {
  listDynamicFields: (
    options: SuiClientTypes.ListDynamicFieldsOptions
  ) => Promise<SuiClientTypes.ListDynamicFieldsResponse>
}

type SpellBookJson = {
  json?: { value?: { contents?: { key?: string | number; value?: string | number }[] | null } | null } | null
} | undefined

const to_invested = (raw: unknown): number | null => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 1 ? Math.floor(raw) : null
  if (typeof raw === 'string') {
    const numeric = Number(raw)
    return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : null
  }
  return null
}

/** A character's invested spell levels: `{ [spell_name]: invested_level }` — an empty map means
 *  every spell casts at its self-learned level 1. Returns {} for a character with no SpellBookKey
 *  field or any unreadable JSON (both honestly mean "everything at level 1"). */
export const read_spell_book = async (sdk: GameSdk, character_id: string): Promise<Readonly<Record<string, number>>> => {
  const core = sdk.sui_client.core as unknown as CoreWithDynamicFields
  const { dynamicFields } = await core.listDynamicFields({ parentId: character_id })
  const field = dynamicFields.find((f) => f.name?.type?.endsWith('::progression::SpellBookKey'))
  if (!field?.fieldId) return {}

  const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [field.fieldId], include: { json: true } })
  const contents = (objects[0] as SpellBookJson)?.json?.value?.contents
  if (!contents) return {}

  const book: Record<string, number> = {}
  for (const entry of contents) {
    if (!entry) continue
    const name = typeof entry.key === 'string' && entry.key !== '' ? entry.key : null
    const invested = to_invested(entry.value)
    if (name && invested !== null) book[name] = invested
  }
  return book
}