// Reads a character's equipped weapon straight off its `equipment::EquipmentKey` dynamic field
// (equipment.move: `EquipmentKey() -> VecMap<String, EquippedRecord>`, keyed by slot, the weapon
// slot being the literal string "weapon"). This is the L-D4 "equipped-weapon read" that
// auto_equip.ts's header and simulate.ts's SimPartyMember.weapon have been waiting on: a sim's
// strike must model what a real fight actually strikes with. strike_level (fight.move) reads the
// SAME chain-side record — category (physics law), record_damages (line snapshot) and the
// classe/category affinity — so a party built from this read exercises exactly the gear the
// on-chain fight will resolve.
//
// Read shape: the node's own JSON decode of the DF value (same widened-core pattern as
// dungeon_read.ts) is `{ value: { contents: [{ key, value: { category, damages, item, template,
// stats } }] } }`, captured live off mainnet for all four roster characters (pet/hat/left_ring/
// tool slots seen; no weapon slot yet — this roster is honestly unarmed). A damages line is an
// authored `ItemDamages { from, to, damage_type, element }`; the strike law reads only
// element/from/to (weapon.move:strike_of), and the sim's assemble drops damage_type the same
// way — so this parser does too. No hand-rolled BCS decoder (L-D4's point: prod-code decoders
// rot against nested payload shapes; node JSON decode does not).
//
// Defensive by contract: ANY shape mismatch returns null (unarmed) — never throws. A wrong read
// must not abort a battle prep, and strike_of(null) is the honest unarmed strike.
import type { SuiClientTypes } from '@mysten/sui/client'
import type { WeaponSource } from '@aresrpg/fight'
import { type SDK } from '@aresrpg/sdk'

type GameSdk = ReturnType<typeof SDK>

type CoreWithDynamicFields = {
  listDynamicFields: (
    options: SuiClientTypes.ListDynamicFieldsOptions
  ) => Promise<SuiClientTypes.ListDynamicFieldsResponse>
}

type DamageLineJson = { element?: string | number; from?: string | number; to?: string | number }
type EquipRecordJson = { category?: string | number; damages?: DamageLineJson[]; item?: string | number }
type EquipMapJson = {
  json?: { value?: { contents?: { key?: string | number; value?: EquipRecordJson }[] } | null } | null
} | undefined

/** Reads the damage lines the chain would resolve. Returns null when the record isn't the
 *  weapon slot, carries unusable JSON, or the character holds no EquipmentKey field at all —
 *  every path returns the same "honestly unarmed" result. */
export const read_equipped_weapon = async (sdk: GameSdk, character_id: string): Promise<WeaponSource | null> => {
  const { contents } = await read_equipment_key(sdk, character_id)
  if (!contents) return null

  const record = contents.find((entry) => entry.key === 'weapon')?.value
  if (!record) return null
  const { category, damages } = record
  if (typeof category !== 'string' || !Array.isArray(damages)) return null

  const lines: WeaponSource['damages'] = []
  for (const line of damages) {
    const { element, from, to } = line
    if (typeof element !== 'string') return null
    try {
      lines.push({ element, from: BigInt(from ?? 0), to: BigInt(to ?? 0) })
    } catch {
      return null
    }
  }
  return { category, damages: lines }
}

/** One equipped record per currently-occupied slot — the same EquipmentKey read as
 *  read_equipped_weapon, but every slot (not just "weapon") and exposing the RECEIVING item id,
 *  so the auto-equip poll knows what a character currently wears in each slot (auto_equip.ts
 *  upgrades occupied slots with a to_unequip of exactly this id). Defensive by the same L-D4
 *  contract: a slot whose record carries no readable item id is dropped, a missing/empty
 *  EquipmentKey yields an empty record, never a throw. */
export const read_equipped_items = async (
  sdk: GameSdk,
  character_id: string
): Promise<Readonly<EquippedSlot>[]> => {
  const { contents } = await read_equipment_key(sdk, character_id)
  if (!contents) return []

  const rows: EquippedSlot[] = []
  for (const entry of contents) {
    const slot = typeof entry.key === 'string' ? entry.key : null
    const item_id = entry.value?.item
    if (!slot || typeof item_id !== 'string' || item_id === '') continue
    rows.push({ slot, item_id })
  }
  return rows
}

export type EquippedSlot = { slot: string; item_id: string }

const read_equipment_key = async (
  sdk: GameSdk,
  character_id: string
): Promise<Readonly<{ contents: { key?: string | number; value?: EquipRecordJson }[] | null }>> => {
  const core = sdk.sui_client.core as unknown as CoreWithDynamicFields
  const { dynamicFields } = await core.listDynamicFields({ parentId: character_id })
  const field = dynamicFields.find((f) => f.name?.type?.endsWith('::equipment::EquipmentKey'))
  if (!field?.fieldId) return { contents: null }

  const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [field.fieldId], include: { json: true } })
  const contents = (objects[0] as EquipMapJson)?.json?.value?.contents
  return { contents: contents ?? null }
}