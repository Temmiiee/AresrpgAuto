// The bot's single source of runtime configuration. Environment is read exactly once, here, so
// every other module imports a frozen fact rather than poking process.env.
import type { GatheringJob } from '@aresrpg/immutable'

import { NETWORK, RPC_URL } from './shared/network_config.ts'

export type PlayToggles = Readonly<{
  /** harvest resource nodes the zone seed draws */
  gather: boolean
  /** engage roaming mob groups */
  fight: boolean
  /** drift to stronger zones when the local prey is trivial */
  roam: boolean
  /** craft recipes once ingredients and job level permit */
  craft: boolean
  /** fight as ONE party: the leader engages and every other character joins the same fight */
  group: boolean
}>

const env_flag = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

const env_int = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === '') return null
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Expected an integer env value, got "${raw}"`)
  return parsed
}

/** What a character does with its non-combat time.
 *  - `craft`        rotates through every crafting job (a pure levelling crafter);
 *  - `gather`       harvests ONLY the assigned gathering job, so the party covers every gatherer slot;
 *  - `gather_all`   rotates through EVERY gathering job (the all-resource gatherer, e.g. archero);
 *  - `gather_craft` harvests one gathering job AND rotates the crafting jobs (e.g. omori);
 *  - `none`         does no chore at all.
 *  Every character still fights for xp regardless of its chore role. */
export type ChoreRole =
  | Readonly<{ kind: 'craft' }>
  | Readonly<{ kind: 'gather'; job: GatheringJob }>
  | Readonly<{ kind: 'gather_all' }>
  | Readonly<{ kind: 'gather_craft'; job: GatheringJob }>
  | Readonly<{ kind: 'none' }>

/** Per-character chore plan, keyed by lowercased character name. */
export type ChorePlan = Readonly<Record<string, ChoreRole>>

export const GATHERING_JOBS = Object.freeze(['FARMER', 'HERBALIST', 'MINER'] as const)

/** The default roster: omori gathers herbs while still rotating every crafting job (gather_craft),
 *  memorien and llokan each own a gathering job, and archero rotates EVERY gathering job so the
 *  party covers all gathering leaves and craft professions with an all-resource gatherer. */
const DEFAULT_CHORE_PLAN: ChorePlan = Object.freeze({
  omori: Object.freeze({ kind: 'gather_craft', job: 'HERBALIST' }),
  memorien: Object.freeze({ kind: 'gather', job: 'FARMER' }),
  llokan: Object.freeze({ kind: 'gather', job: 'MINER' }),
  archero: Object.freeze({ kind: 'gather_all' }),
})

/** Parse `BOT_CHORE_PLAN` — a JSON object mapping character name to `"craft"`, `"none"`, or one of
 *  `"FARMER" | "HERBALIST" | "MINER"`. Absent, the default roster above is used. */
const parse_chore_plan = (raw: string | undefined): ChorePlan => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CHORE_PLAN
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const is_gathering_job = (value: unknown): value is GatheringJob =>
    typeof value === 'string' && (GATHERING_JOBS as readonly string[]).includes(value)
  const plan: Record<string, ChoreRole> = {}
  for (const [name, value] of Object.entries(parsed)) {
    const key = name.toLowerCase()
    if (value === 'craft') plan[key] = Object.freeze({ kind: 'craft' })
    else if (value === 'none') plan[key] = Object.freeze({ kind: 'none' })
    else if (value === 'gather_all') plan[key] = Object.freeze({ kind: 'gather_all' })
    else if (is_gathering_job(value)) plan[key] = Object.freeze({ kind: 'gather', job: value })
    else if (
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: unknown }).kind === 'gather_craft' &&
      is_gathering_job((value as { job?: unknown }).job)
    )
      plan[key] = Object.freeze({ kind: 'gather_craft', job: (value as { job: GatheringJob }).job })
    else throw new Error(`Invalid BOT_CHORE_PLAN entry for "${name}": ${JSON.stringify(value)}`)
  }
  return Object.freeze(plan)
}

export type BotConfig = Readonly<{
  network: typeof NETWORK
  rpc_url: string
  /** authenticated live-state websocket */
  server_ws_url: string
  /** the browser origin the server's handshake expects */
  origin: string
  enoki_api_key: string | undefined
  google_client_id: string | undefined
  /** local port the interactive zkLogin capture server listens on */
  login_port: number
  discord_webhook_url: string | undefined
  discord_mention: string | undefined
  /** target character (optional — discovered at runtime from the signer's roster when absent) */
  character_id: string | null
  /** target world (optional — the character's own joined world when absent) */
  world: string | null
  play: PlayToggles
  /** how long to wait between full decision passes when idle */
  idle_sleep_ms: number
  /** durable state directory for pending-transaction records + the activity ledger */
  state_dir: string
  /** maximum number of characters to drive simultaneously over the one shared WebSocket */
  party_size: number
  /** per-character chore assignment (gather a single job / rotate all crafting jobs / none) */
  chore_plan: ChorePlan
  /** the character name that leads the party into a shared fight */
  leader_name: string
  /** minutes between party-wide Discord progress digests (0 disables them) */
  digest_minutes: number
}>

export const config: BotConfig = Object.freeze({
  network: NETWORK,
  rpc_url: RPC_URL,
  server_ws_url: process.env.ARES_SERVER_WS_URL ?? 'wss://server.aresrpg.world/',
  origin: process.env.ARES_ORIGIN ?? 'https://aresrpg.world',
  enoki_api_key: process.env.ENOKI_API_KEY,
  google_client_id: process.env.ENOKI_GOOGLE_CLIENT_ID,
  login_port: env_int(process.env.ENOKI_LOGIN_PORT) ?? 5173,
  discord_webhook_url: process.env.DISCORD_WEBHOOK_URL,
  discord_mention: process.env.DISCORD_MENTION,
  character_id: process.env.ARES_CHARACTER_ID ?? null,
  world: process.env.ARES_WORLD ?? "nauvis",
  play: Object.freeze({
    gather: env_flag(process.env.BOT_GATHER, true),
    fight: env_flag(process.env.BOT_FIGHT, true),
    roam: env_flag(process.env.BOT_ROAM, true),
    craft: env_flag(process.env.BOT_CRAFT, true),
    group: env_flag(process.env.BOT_GROUP, true),
  }),
  idle_sleep_ms: env_int(process.env.BOT_IDLE_SLEEP_MS) ?? 5_000,
  state_dir: process.env.BOT_STATE_DIR ?? '.state',
  party_size: Math.min(Math.max(env_int(process.env.BOT_PARTY_SIZE) ?? 4, 1), 4),
  chore_plan: parse_chore_plan(process.env.BOT_CHORE_PLAN),
  leader_name: process.env.BOT_LEADER ?? 'omori',
  digest_minutes: Math.max(0, env_int(process.env.BOT_DIGEST_MINUTES) ?? 60),
})
