// Single source of truth for which Sui network the bot targets. Everything that used to
// hardcode 'testnet' (sdk_client.ts, enoki_auth.ts, faucet.ts) reads it from here instead, so
// switching networks is a one-line env change, never a code change.
//
// pins.json's "mainnet" entry is still every field null (2026-09-06 — the game itself hasn't
// deployed there yet), so NETWORK=mainnet will fail loudly against @aresrpg/sdk's own
// `unknown network` guard until that changes. This switch exists so flipping it is trivial the
// day it does, not so it works today.
import type { SdkNetwork } from '@aresrpg/sdk'

const RPC_URLS: Record<SdkNetwork, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
}

const parse_network = (raw: string | undefined): SdkNetwork => {
  if (raw === undefined || raw === 'testnet') return 'testnet'
  if (raw === 'mainnet') return 'mainnet'
  throw new Error(`SUI_NETWORK must be "testnet" or "mainnet" (got "${raw}")`)
}

export const NETWORK: SdkNetwork = parse_network(process.env.SUI_NETWORK)
export const IS_MAINNET: boolean = NETWORK === 'mainnet'
// SUI_RPC_URL lets a custom RPC provider override the public default on either network.
export const RPC_URL: string = process.env.SUI_RPC_URL ?? RPC_URLS[NETWORK]

// The bot's Enoki API key and Google OAuth client are public client config (see
// enoki_auth.ts's own header) shared with the real aresrpg.world frontend build — but an Enoki
// key is registered in the Enoki dashboard against a specific set of allowed networks, so the
// testnet key baked into enoki_auth.ts may simply not be authorized for mainnet once that exists.
// Override via env for whatever the real mainnet key turns out to be; this file only surfaces
// the seam, it can't know that value in advance.
export const ENOKI_API_KEY_OVERRIDE: string | undefined = process.env.ENOKI_API_KEY
