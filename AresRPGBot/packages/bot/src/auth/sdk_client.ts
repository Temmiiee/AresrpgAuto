// One shared factory: the official @aresrpg/sdk wired to this bot's target network (see
// network_config.ts) with this bot's wallet. Works with either a local Ed25519Keypair (the
// throwaway bot wallet) or an EnokiKeypair (zkLogin, for driving a real player's account) —
// both are `Signer`.
import type { Signer } from '@mysten/sui/cryptography'
import { SDK } from '@aresrpg/sdk'
import { marketplace_actions } from '@aresrpg/sdk/marketplace'

// Not part of the SDK's public `exports` map (only auth.ts — browser-wallet-only — composes
// them); a relative import is the monorepo's own way to reach them from another workspace package.
import { character_actions } from '../../../sdk/src/character_actions.ts'
import { fight_actions } from '../../../sdk/src/fight.ts'
import { dungeon_actions } from '../../../sdk/src/dungeon.ts'
import { mastery_actions } from '../../../sdk/src/mastery.ts'
import { NETWORK, RPC_URL } from '../shared/network_config.ts'

export const create_bot_sdk = (keypair: Signer) => {
  const sdk = SDK({ signer: keypair, network: NETWORK, rpc_url: RPC_URL })
  const address = keypair.toSuiAddress()

  // Every kiosk-borrowing door needs the CAP's exact current version+digest. Each transaction
  // bumps it, so — matching the real client's auth.ts — this asks the network fresh every
  // time rather than memoizing: a cached version goes stale after the very next transaction
  // and the next kiosk door fails with "provided version doesn't match".
  const kiosk_cap = async () => {
    const { kioskOwnerCaps } = await sdk.get_owned_kiosks(address)
    return kioskOwnerCaps.find((cap) => cap.isPersonal) ?? kioskOwnerCaps[0] ?? null
  }

  return {
    sdk,
    address,
    character: character_actions(sdk, { kiosk_cap }),
    fight: fight_actions(sdk, { kiosk_cap }),
    marketplace: marketplace_actions(sdk, { address, kiosk_cap }),
    dungeon: dungeon_actions(sdk, { kiosk_cap }),
    mastery: mastery_actions(sdk, { address, kiosk_cap }),
    kiosk_cap,
  }
}

export type BotSdk = ReturnType<typeof create_bot_sdk>
