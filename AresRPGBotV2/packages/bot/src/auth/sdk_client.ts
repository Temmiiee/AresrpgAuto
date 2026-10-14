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
import { create_personal_kiosk_runner } from '../../../sdk/src/kiosk_runner.ts'
import type { KioskCapLoader } from '../../../sdk/src/kiosk_runner.ts'
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
  // after the very next transaction.
  const kiosk_cap: KioskCapLoader = async (kiosk_id?: string): Promise<KioskOwnerCap | null> => {
    const { kioskOwnerCaps } = await sdk.get_owned_kiosks(address)
    if (kiosk_id) {
      const wanted = kiosk_id.toLowerCase()
      return kioskOwnerCaps.find((cap) => cap.kioskId.toLowerCase() === wanted) ?? null
    }
    return kioskOwnerCaps.find((cap) => cap.isPersonal) ?? kioskOwnerCaps[0] ?? null
  }

  return {
    sdk,
    address,
    character: character_actions(sdk, { kiosk_cap }),
    fight: fight_actions(sdk, { kiosk_cap }),
    dungeon: dungeon_actions(sdk, { kiosk_cap }),
    kiosk_cap,
  }
}

export type BotSdk = ReturnType<typeof create_bot_sdk>

/** A serialized personal-kiosk runner for character creation (the one action that must mint the
 *  personal kiosk before any custody door can be used). */
export const personal_kiosk_runner = (load: KioskCapLoader) => create_personal_kiosk_runner(load)
