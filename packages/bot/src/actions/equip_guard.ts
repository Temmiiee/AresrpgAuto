// Equip ownership guard — verify on chain, right before an equip PTB, that every item the plan
// touches is where the (lagging) projection says it is.
//
//   - an item to UNEQUIP must be worn by THIS character: the chain hands it back through a
//     `Receiving<Item>` addressed to the character object, so it must be `AddressOwner(character)`.
//     Anything else ("object … is not Immutable or AddressOwned") means the projection still shows a
//     tool/gear that already went back to the kiosk (or onto another character).
//   - an item to EQUIP must still sit in the kiosk (a dynamic-field child, i.e. NOT address-owned).
//     Address-owned means it is already worn — by us (nothing to do) or by a teammate.
//
// A mismatch skips the change set and parks that character's equips for a short settle window, so
// the next attempt plans from a projection that has caught up instead of re-sending the same stale
// PTB every pass. A successful equip also opens the settle window for the same reason.
import { log_warn } from '../shared/logger.ts'

import type { ActionContext } from './context.ts'

export type EquipChange = Readonly<{ slot: string; item_id: string }>

export type OwnershipVerdict = Readonly<{
  ok: boolean
  /** the items the plan wants to equip that are ALREADY worn by this character */
  already_worn: readonly string[]
  reason?: string
}>

/** 0x-prefixed, lowercase, 64-hex — enough to compare ids/addresses from different sources. */
const normalizeSuiAddress = (value: string): string => {
  const hex = value.trim().toLowerCase().replace(/^0x/, '')
  return `0x${hex.padStart(64, '0')}`
}

type OwnerLike = { $kind?: string; AddressOwner?: string } | null | undefined

const address_owner = (owner: OwnerLike): string | null =>
  owner && owner.$kind === 'AddressOwner' && typeof owner.AddressOwner === 'string'
    ? normalizeSuiAddress(owner.AddressOwner)
    : owner && typeof owner.AddressOwner === 'string'
      ? normalizeSuiAddress(owner.AddressOwner)
      : null

/** Pure verdict from the fetched owners (exported for tests). `owners` maps item id → owner, or
 *  undefined when the object could not be read (deleted / unknown). */
export const ownership_verdict = (
  character_id: string,
  to_equip: readonly EquipChange[],
  to_unequip: readonly EquipChange[],
  owners: ReadonlyMap<string, OwnerLike>
): OwnershipVerdict => {
  const me = normalizeSuiAddress(character_id)
  const problems: string[] = []
  const already_worn: string[] = []
  for (const change of to_unequip) {
    const id = normalizeSuiAddress(change.item_id)
    if (!owners.has(id)) {
      problems.push(`${change.slot}:${change.item_id.slice(0, 8)} unreadable`)
      continue
    }
    const holder = address_owner(owners.get(id))
    if (holder !== me) problems.push(`${change.slot}:${change.item_id.slice(0, 8)} is not worn by this character`)
  }
  for (const change of to_equip) {
    const id = normalizeSuiAddress(change.item_id)
    if (!owners.has(id)) {
      problems.push(`${change.slot}:${change.item_id.slice(0, 8)} unreadable`)
      continue
    }
    const holder = address_owner(owners.get(id))
    if (holder === me) already_worn.push(change.item_id)
    else if (holder) problems.push(`${change.slot}:${change.item_id.slice(0, 8)} is worn by another character`)
  }
  if (already_worn.length) problems.push(`${already_worn.length} item(s) already worn`)
  return Object.freeze({
    ok: problems.length === 0,
    already_worn: Object.freeze(already_worn),
    reason: problems.length ? problems.join('; ') : undefined,
  })
}

/** Fetch the live owners of every item in the plan and judge them. A transport failure is NOT a
 *  veto (returns ok) — the chain still re-asserts every rule, this only filters known-stale plans. */
export const verify_equip_ownership = async (
  ctx: ActionContext,
  character_id: string,
  to_equip: readonly EquipChange[],
  to_unequip: readonly EquipChange[]
): Promise<OwnershipVerdict> => {
  const ids = [...new Set([...to_equip, ...to_unequip].map((change) => normalizeSuiAddress(change.item_id)))]
  if (!ids.length) return Object.freeze({ ok: true, already_worn: Object.freeze([]) })
  try {
    const owners = new Map<string, OwnerLike>()
    for (let i = 0; i < ids.length; i += 50) {
      const { objects } = await ctx.sdk.sdk.sui_client.core.getObjects({ objectIds: ids.slice(i, i + 50) })
      for (const row of objects as readonly unknown[]) {
        if (!row || row instanceof Error) continue
        const object = row as { objectId?: string; owner?: OwnerLike }
        if (object.objectId) owners.set(normalizeSuiAddress(object.objectId), object.owner)
      }
    }
    const verdict = ownership_verdict(character_id, to_equip, to_unequip, owners)
    // refresh the receipt cache's refs so the Receiving<Item> args carry the live version
    if (verdict.ok && to_unequip.length) await ctx.sdk.sdk.hydrate(to_unequip.map((change) => change.item_id))
    return verdict
  } catch (error) {
    log_warn('equip', `ownership check skipped: ${error instanceof Error ? error.message : String(error)}`)
    return Object.freeze({ ok: true, already_worn: Object.freeze([]) })
  }
}

/** After an equip lands (or a stale plan is caught), the projection needs a beat to show it. */
export const EQUIP_SETTLE_MS = 45_000
const settle_until = new Map<string, number>()

export const mark_equip_settling = (character_id: string, ms = EQUIP_SETTLE_MS): void => {
  settle_until.set(character_id, Date.now() + ms)
}

export const equip_settling = (character_id: string): boolean => (settle_until.get(character_id) ?? 0) > Date.now()
