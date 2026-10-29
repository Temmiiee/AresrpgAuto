// One shared factory: the official @aresrpg/sdk wired to this bot's target network with this
// bot's zkLogin signer, plus the action builders the SDK's export map does not publish.
//
// The SDK's public `exports` map only lists client.ts and a handful of doors; character/fight
// actions are imported through the monorepo's own relative convention (the SDK's own
// examples/agent_actions.ts does exactly this).
import { SDK } from '@aresrpg/sdk'
import type { Signer } from '@mysten/sui/cryptography'
import type { KioskOwnerCap } from '@mysten/kiosk'

import { character_actions } from '../../../sdk/src/character_actions.ts'
import { dungeon_actions } from '../../../sdk/src/dungeon.ts'
import { fight_actions } from '../../../sdk/src/fight.ts'
import type { KioskCapLoader } from '../../../sdk/src/kiosk_runner.ts'
import { pre_submission_version_race } from '../../../sdk/src/transaction_error.ts'
import { NETWORK, RPC_URL } from '../shared/network_config.ts'
import { create_durable_storage } from '../chain/storage.ts'

export type BotSdkOptions = Readonly<{
  /** durable path for in-flight transaction recovery records */
  transaction_storage_path: string
}>

export const create_bot_sdk = (signer: Signer, { transaction_storage_path }: BotSdkOptions) => {
  const sdk = SDK({
    signer,
    network: NETWORK,
    rpc_url: RPC_URL,
    transaction_storage: create_durable_storage(transaction_storage_path),
  })
  const address = signer.toSuiAddress()

  // Every kiosk-borrowing door needs the CAP's exact current version+digest. Each transaction
  // bumps it, so this asks the network fresh rather than memoizing — a cached version goes stale
  // after the very next transaction. The fullnode's owned-object index can itself trail our own
  // last receipt by a beat, so the network answer is upgraded to the receipt-fed cache ref
  // whenever that ref is newer (the SDK absorbs every receipt into `sdk.ref`).
  const kiosk_cap: KioskCapLoader = async (kiosk_id?: string): Promise<KioskOwnerCap | null> => {
    const { kioskOwnerCaps } = await sdk.get_owned_kiosks(address)
    const picked = kiosk_id
      ? (kioskOwnerCaps.find((cap) => cap.kioskId.toLowerCase() === kiosk_id.toLowerCase()) ?? null)
      : (kioskOwnerCaps.find((cap) => cap.isPersonal) ?? kioskOwnerCaps[0] ?? null)
    return picked ? freshest_cap(picked, sdk.ref(picked.objectId)) : null
  }

  const lane = create_tx_lane()
  return {
    sdk,
    address,
    character: serialize_actions(character_actions(sdk, { kiosk_cap }), lane),
    fight: serialize_actions(fight_actions(sdk, { kiosk_cap }), lane, FIGHT_SHARED_ONLY),
    dungeon: serialize_actions(dungeon_actions(sdk, { kiosk_cap }), lane),
    kiosk_cap,
  }
}

export type BotSdk = ReturnType<typeof create_bot_sdk>

type OwnedRefLike = { objectId: string; version: string | number | bigint; digest: string } | undefined

/** The newer of the indexer's cap and the receipt-fed cache ref (same object id). */
export const freshest_cap = (cap: KioskOwnerCap, cached: OwnedRefLike): KioskOwnerCap => {
  if (!cached?.version || !cached.digest) return cap
  try {
    return BigInt(cached.version) > BigInt(cap.version)
      ? { ...cap, version: String(cached.version), digest: cached.digest }
      : cap
  } catch {
    return cap
  }
}

// Fight doors that only touch the fight's SHARED object (no kiosk cap, no owned inputs besides
// gas). They are already serialized per fight by `fight_runtimes.with_lock`, so they stay off the
// party-wide lane to keep turn submission latency low.
const FIGHT_SHARED_ONLY: ReadonlySet<string> = new Set([
  'place',
  'ready',
  'ready_many',
  'start',
  'commit_turn',
  'crank',
  'close',
  'gas_spent',
])

export type TxLane = <T>(fn: () => Promise<T>) => Promise<T>

/** One FIFO critical section for every kiosk-touching transaction of the signer. */
export const create_tx_lane = (): TxLane => {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

const VERSION_RACE_RETRIES = 2
const VERSION_RACE_BACKOFF_MS = 1_500
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Re-run a door whose transaction was refused BEFORE submission because an owned/shared input
 *  version moved (another character's tx landed between build and submit). Each attempt rebuilds
 *  the PTB from scratch, so the kiosk cap and every object ref are re-fetched. A digest-bearing
 *  (submitted) failure is never retried. */
export const with_version_retry = async <T>(
  fn: () => Promise<T>,
  { retries = VERSION_RACE_RETRIES, backoff_ms = VERSION_RACE_BACKOFF_MS } = {}
): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= retries || !pre_submission_version_race(error)) throw error
      await sleep(backoff_ms * (attempt + 1))
    }
  }
}

/** Wrap every door of an action bundle so the party's transactions are composed AND executed one
 *  at a time (the SDK only serializes execution, so four characters composing concurrently would
 *  all bake in the same cap version and three of them would be refused), with a version-race
 *  retry. Non-function members are passed through untouched. */
export const serialize_actions = <T extends object>(
  actions: T,
  lane: TxLane,
  bypass: ReadonlySet<string> = new Set()
): T => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(actions)) {
    if (typeof value !== 'function' || bypass.has(key)) {
      out[key] = value
      continue
    }
    const fn = value as (...args: unknown[]) => unknown
    out[key] = (...args: unknown[]) =>
      lane(() => with_version_retry(() => Promise.resolve(fn.apply(actions, args))))
  }
  return out as T
}
