// Live chain checkpoint read — the exact `(x, z, at_ms, pet)` that `world::prove_move` measures
// the next leg from.
//
// The mover's anchor is otherwise fed by the roster (which lags the chain by minutes) and by the
// mover's own doors. Every OTHER door that calls `prove_move` — fight engage/join, dungeon enter,
// join_world, … — rewrites the checkpoint without telling the mover, so it keeps measuring from an
// OLDER checkpoint: more elapsed time, a bigger travel bank, and a leg the chain then refuses with
// ETravelTooFar (305). Reading the dynamic field directly removes that guesswork.
//
// Same field layout as the vendored `sdk/src/character_checkpoint.ts` (which drops `at_ms`/`pet`).
import { bcs } from '@mysten/sui/bcs'

export type LiveCheckpoint = Readonly<{ world: string; x: number; z: number; at_ms: number; pet: boolean }>

const CHECKPOINT_BCS = bcs.struct('Checkpoint', {
  x: bcs.u32(),
  z: bcs.u32(),
  at_ms: bcs.u64(),
  pet: bcs.bool(),
})

const key = (type_package: string, name: 'CurrentWorldKey' | 'CheckpointKey', value?: string) =>
  Object.freeze({
    type: `${type_package}::world::${name}`,
    bcs: value === undefined ? bcs.bool().serialize(false).toBytes() : bcs.String.serialize(value).toBytes(),
  })

type DynamicFieldCore = {
  getDynamicField: (input: {
    parentId: string
    name: { type: string; bcs: Uint8Array }
  }) => Promise<{ dynamicField: { value: { bcs: Uint8Array } } }>
}

/** The character's live checkpoint in `world`, or null when it is not in that world / unreadable
 *  on this transport. Throws only on transport errors the caller may log. */
export const read_live_checkpoint = async (
  client: unknown,
  type_package: string | null,
  character_id: string,
  world: string
): Promise<LiveCheckpoint | null> => {
  const core = (client as { core?: Partial<DynamicFieldCore> } | null)?.core
  if (!type_package || !core?.getDynamicField) return null
  const read = core.getDynamicField.bind(core) as DynamicFieldCore['getDynamicField']
  const [current, checkpoint] = await Promise.all([
    read({ parentId: character_id, name: key(type_package, 'CurrentWorldKey') }),
    read({ parentId: character_id, name: key(type_package, 'CheckpointKey', world) }),
  ])
  if (bcs.String.parse(current.dynamicField.value.bcs) !== world) return null
  const value = CHECKPOINT_BCS.parse(checkpoint.dynamicField.value.bcs)
  const at_ms = Number(value.at_ms)
  if (!Number.isSafeInteger(at_ms)) return null
  return Object.freeze({ world, x: value.x, z: value.z, at_ms, pet: value.pet })
}

/** Pure adoption rule: the chain's checkpoint replaces the local anchor when it is NEWER (a door
 *  the mover did not see moved it). An OLDER chain value is a fullnode that has not caught up with
 *  our own last door yet — the local anchor (already dated in the safe direction) is kept. */
export const should_adopt_checkpoint = (
  local: Readonly<{ world: string; x: number; z: number; at_ms: number; pet: boolean }> | null,
  live: LiveCheckpoint
): boolean => {
  if (!local || local.world !== live.world) return true
  if (live.at_ms > local.at_ms) return true
  // same instant, different facts: trust the chain
  return live.at_ms === local.at_ms && (live.x !== local.x || live.z !== local.z || live.pet !== local.pet)
}
