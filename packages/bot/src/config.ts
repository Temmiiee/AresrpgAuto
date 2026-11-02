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
  /** let the designated character periodically detach to gather a richer world (e.g. yakutia) */
  cross_world: boolean
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

/** Optional combat/farm teams. Each array lists character names in order; its first member leads. */
const parse_teams = (raw: string | undefined): readonly (readonly string[])[] | null => {
  if (raw === undefined || raw.trim() === '') return null
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || parsed.length < 2)
    throw new Error('BOT_TEAMS must be a JSON array with at least two character arrays')
  const teams = parsed.map((team, index) => {
    if (!Array.isArray(team) || team.length === 0 || team.some((name) => typeof name !== 'string' || !name.trim()))
      throw new Error(`BOT_TEAMS team ${index + 1} must be a non-empty array of character names`)
    return Object.freeze(team.map((name: string) => name.trim().toLowerCase()))
  })
  const names = teams.flat()
  if (new Set(names).size !== names.length) throw new Error('BOT_TEAMS cannot assign a character to multiple teams')
  return Object.freeze(teams)
}

/** What a character does with its non-combat time.
 *  - `craft`        pursues the current key/tool/gear craft; rotates jobs only with no objective;
 *  - `gather`       harvests ONLY the assigned gathering job, so the party covers every gatherer slot;
 *  - `gather_all`   rotates through EVERY gathering job (the all-resource gatherer, e.g. archero);
 *  - `gather_craft` harvests one gathering job AND runs the objective-driven crafter;
 *  - `gather_all_craft` rotates EVERY gathering job AND runs the objective-driven crafter;
 *  - `none`         does no chore at all.
 *  Every character still fights for xp regardless of its chore role. */
export type ChoreRole =
  | Readonly<{ kind: 'craft' }>
  | Readonly<{ kind: 'gather'; job: GatheringJob }>
  | Readonly<{ kind: 'gather_all' }>
  | Readonly<{ kind: 'gather_craft'; job: GatheringJob }>
  | Readonly<{ kind: 'gather_all_craft' }>
  | Readonly<{ kind: 'none' }>

/** Per-character chore plan, keyed by lowercased character name. */
export type ChorePlan = Readonly<Record<string, ChoreRole>>

export const GATHERING_JOBS = Object.freeze(['FARMER', 'HERBALIST', 'MINER'] as const)

/** The default roster deliberately concentrates progression instead of spreading it over four
 *  copies of every trade. Omori owns crafting; the other three each keep one gathering job and its
 *  matching tool. This avoids paid tool churn and makes every craft XP batch advance the crafter
 *  that will actually unlock the party's target recipes. */
const DEFAULT_CHORE_PLAN: ChorePlan = Object.freeze({
  omori: Object.freeze({ kind: 'craft' }),
  memorien: Object.freeze({ kind: 'gather', job: 'FARMER' }),
  llokan: Object.freeze({ kind: 'gather', job: 'MINER' }),
  archero: Object.freeze({ kind: 'gather', job: 'HERBALIST' }),
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
    else if (value === 'gather_all_craft') plan[key] = Object.freeze({ kind: 'gather_all_craft' })
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
  /** how long the interactive zkLogin capture server waits for the Google sign-in (ms) */
  login_timeout_ms: number
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
  /** optional independent group-fight teams; the first name in each team is its leader */
  teams: readonly (readonly string[])[] | null
  /** per-character chore assignment (gather a single job / rotate all crafting jobs / none) */
  chore_plan: ChorePlan
  /** how long a character may go with no chore before its pass runs one BEFORE staging another
   *  fight (ms), so gathering/crafting never sits idle behind a wall of engages; 0 disables the floor */
  chore_interval_ms: number
  /** the character name that leads the party into a shared fight */
  leader_name: string
  /** minutes between party-wide Discord progress digests (0 disables them) */
  digest_minutes: number
  /** the character (lowercased name) that periodically detaches for cross-world gathering */
  cross_world_gatherer: string
  /** explicit cross-world target world; null = the richest resource world the detacher can reach */
  cross_world_world: string | null
  /** how long between cross-world trips (ms); 0 disables the trip cycle */
  cross_world_interval_ms: number
  /** how long the detacher spends gathering in the target world before returning (ms) */
  cross_world_dwell_ms: number
  /** run the periodic whole-content strategy brain (global farm targeting + gear acquisition) */
  strategy: boolean
  /** how long between strategy passes (ms); 0 disables the periodic recompute */
  strategy_interval_ms: number
  /** periodically compare bundled game content with aresrpg/aresrpg:edge */
  content_watch: boolean
  content_watch_interval_ms: number
  /** write complete per-fight JSONL diagnostics under packages/bot/logs/fights */
  combat_analytics: boolean
}>

export const config: BotConfig = Object.freeze({
  network: NETWORK,
  rpc_url: RPC_URL,
  server_ws_url: process.env.ARES_SERVER_WS_URL ?? 'wss://server.aresrpg.world/',
  origin: process.env.ARES_ORIGIN ?? 'https://aresrpg.world',
  enoki_api_key: process.env.ENOKI_API_KEY,
  google_client_id: process.env.ENOKI_GOOGLE_CLIENT_ID,
  login_port: env_int(process.env.ENOKI_LOGIN_PORT) ?? 5173,
  // The interactive zkLogin wait. The old 5 minutes is far too short for an operator who is away
  // from the machine: the link lands in Discord, they open it on another device, and the window is
  // already gone. 30 minutes (env-tunable) lets them reach it; the process still fails fast if nobody
  // signs in, and the fatal path notifies Discord.
  login_timeout_ms: Math.max(env_int(process.env.ENOKI_LOGIN_TIMEOUT_MS) ?? 30 * 60_000, 60_000),
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
    cross_world: env_flag(process.env.BOT_CROSS_WORLD, true),
  }),
  // The idle beat is pure overhead stacked on top of each pass's blocking work (a staging leg, a
  // follower rally): it delays the next rendezvous/regroup check, never a transaction. 3s keeps the
  // loop responsive without meaningfully raising the pass rate over a five-second beat.
  idle_sleep_ms: env_int(process.env.BOT_IDLE_SLEEP_MS) ?? 3_000,
  state_dir: process.env.BOT_STATE_DIR ?? '.state',
  // The realtime roster supports six and every current combat board has six player start cells.
  // Default to five so a newly-created Tomoda joins the existing four-character farm team.
  party_size: Math.min(Math.max(env_int(process.env.BOT_PARTY_SIZE) ?? 5, 1), 5),
  teams: parse_teams(process.env.BOT_TEAMS),
  chore_plan: parse_chore_plan(process.env.BOT_CHORE_PLAN),
  chore_interval_ms: Math.max(env_int(process.env.BOT_CHORE_INTERVAL_MS) ?? 5 * 60_000, 0),
  leader_name: process.env.BOT_LEADER ?? 'omori',
  digest_minutes: Math.max(0, env_int(process.env.BOT_DIGEST_MINUTES) ?? 60),
  cross_world_gatherer: (process.env.BOT_CROSS_WORLD_GATHERER ?? 'archero').toLowerCase(),
  cross_world_world: process.env.BOT_CROSS_WORLD_WORLD ?? null,
  cross_world_interval_ms: Math.max(0, env_int(process.env.BOT_CROSS_WORLD_INTERVAL_MS) ?? 1_800_000),
  cross_world_dwell_ms: Math.max(0, env_int(process.env.BOT_CROSS_WORLD_DWELL_MS) ?? 600_000),
  // The periodic "brain": for each zone band it simulates the couple of in-level families with the
  // best authored XP through the same fight twin the engage uses, plus the all-item gear acquisition
  // route. 30 minutes reacts to level/gear moves without hammering the shared loop with sim bursts.
  strategy: env_flag(process.env.BOT_STRATEGY, true),
  strategy_interval_ms: Math.max(0, env_int(process.env.BOT_STRATEGY_INTERVAL_MS) ?? 30 * 60_000),
  content_watch: env_flag(process.env.BOT_CONTENT_WATCH, true),
  content_watch_interval_ms: Math.max(env_int(process.env.BOT_CONTENT_WATCH_INTERVAL_MS) ?? 21_600_000, 60_000),
  combat_analytics: env_flag(process.env.BOT_COMBAT_ANALYTICS, false),
})
