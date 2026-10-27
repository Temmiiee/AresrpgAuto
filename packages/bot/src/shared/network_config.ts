// Which Sui network the bot drives. Default is MAINNET — this bot is a live-game bot; a testnet
// run is an explicit opt-in via SUI_NETWORK=testnet. Everything that used to hardcode a network
// (SDK client, Enoki auth) reads it from here instead.
import type { SdkNetwork } from '@aresrpg/sdk'

const RPC_URLS: Record<SdkNetwork, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
}

const parse_network = (raw: string | undefined): SdkNetwork => {
  if (raw === undefined || raw === 'mainnet') return 'mainnet'
  if (raw === 'testnet') return 'testnet'
  throw new Error(`SUI_NETWORK must be "mainnet" or "testnet" (got "${raw}")`)
}

export const NETWORK: SdkNetwork = parse_network(process.env.SUI_NETWORK)
export const RPC_URL: string = process.env.SUI_RPC_URL ?? RPC_URLS[NETWORK]
