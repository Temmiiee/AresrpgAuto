// session – multi-character play loop.
//
// The bot drives up to 5 characters over ONE authenticated WebSocket connection. This is not an
// optimization: the realtime server seats at most ONE socket per address (`promote()` in the
// server's index.ts closes the previous seat with `REPLACED`/`ALREADY_CONNECTED`), and it tracks
// the whole capped roster on that single connection (`player.ts` -> `allowed_characters`,
// `MAX_TRACKED_CHARACTERS = 6`). Opening a second socket for the same signer evicts the first, so
// the old one-socket-per-character design left exactly one live character and silently dropped the
// rest. One socket, one roster, one shared projection — every character sends its own
// `packet/position`/fight packets with its own `character_id` over that connection.
//
// Each character runs its own play loop in parallel, sharing the projection and the link:
//   1. settle/close  — reconcile any fight the chain reports as ended
//   2. drive fight   — placement / our turn, while the character is seated
//   3. freshness     — refuse to spend on a stale projection
//   4. roam          — pick where to stand
//   5. engage        — screen live mob groups with a local preview
//   6. chores        — gather one node and craft one batch
//
// Gas optimization:
//   - Only engage fights the preview twin wins reliably (MIN_WIN_RATE = 0.8)
//   - Only gather resources the character can actually harvest (tier + tool)
//   - Batch crafting maximizes items per transaction
//   - Efficient travel: chain-proof-gated, speed-law-compliant
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { Signer } from '@mysten/sui/cryptography'
import type { CharacterRow, ClientPacket, ServerPacket } from '@aresrpg/protocol'

import { create_server_link, type ServerLink, type ServerLinkStatus } from './server_link.ts'
import { config, GATHERING_JOBS, type ChoreRole, type PlayToggles } from '../config.ts'
import { log_info, log_warn, log_error, log_debug, log_trace, sleep } from '../shared/logger.ts'
import { notify } from '../shared/discord_notify.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { create_ledger } from '../chain/ledger.ts'
import { create_mover, is_travel_too_far_error, type Mover } from '../actions/travel.ts'
import { create_roamer, type Roamer } from '../actions/roam.ts'
import { gather_once, resolve_pending_ambush } from '../actions/gather.ts'
import { drive_craft } from '../actions/craft.ts'
import {
  empty_stats,
  format_summary,
  record_craft,
  record_fight,
  record_gather,
  type PlayStats,
} from '../actions/play_stats.ts'
import { close_pending, drive_fight, engage_once, handle_fight_packet, settle_pending } from '../actions/combat.ts'
import {
  create_party,
  follower_group_step,
  hop_toward,
  join_dungeon_followers,
  leader_group_step,
  leader_live_pose,
  log_rejoin_due,
  needs_rejoin,
  party_attempting,
  PARTY_RADIUS,
  rally_to_leader,
  regroup_step,
  reset_rendezvous,
  window_viable,
  type PartyState,
} from '../actions/party.ts'
import {
  maybe_start_excursion,
  excursion_done,
  finish_excursion,
  type PartyPose,
  type Excursion,
} from '../actions/excursion.ts'
import { safe_travel_to } from '../actions/roam.ts'
import { dungeon_key_targets, maybe_craft_dungeon_key, party_key_stock, should_run_dungeons } from '../actions/dungeon.ts'
import { create_dungeon_runner, follower_dungeon_step, type DungeonRunner } from '../actions/dungeon_run.ts'
import { create_cross_world_gatherer, type CrossWorldGatherer } from '../actions/cross_world.ts'
import { create_fight_runtimes } from '../actions/fight_registry.ts'
import { create_group_claims, create_serial_queue, type ActionContext } from '../actions/context.ts'
import { auto_equip_party, type EquipTarget } from '../actions/equip.ts'
import { maybe_progress } from '../actions/progression.ts'
import { gear_goal_outputs } from '../actions/gear.ts'
import { describe_strategy, type Strategy } from '../actions/strategy.ts'
import { compute_strategy_offload } from '../actions/strategy_offload.ts'
import { active_fight_of, freshness, unavailable_item_ids, version_gate_active } from '../state/selectors.ts'
import { initial_game_state, reduce, type GameState } from '../state/store.ts'
import { recipe_detail, recipes_by_output, tool_category_of_job, type GatheringJob } from '../content/catalog.ts'
import { plan_recipe, craft_gather_demand, craft_once } from '../actions/craft.ts'
import { is_equipment_category, job_level_from_xp, job_slugs } from '@aresrpg/immutable'

/** Fired when the socket connection is lost / expired. */
export type SessionEvent =
  | { type: 'connecting' }
  | { type: 'authenticating' }
  | { type: 'accepted'; address: string }
  | { type: 'rejected'; reason: string }
  | { type: 'replaced'; reason: string }
  | { type: 'violation'; reason: string }
  | { type: 'failed'; error: string }
  | { type: 'disconnected' }

export type Session = {
  send: (packet: Readonly<ClientPacket>) => boolean
  status: () => ServerLinkStatus
  dispose: () => void
  /** Register handler for session disconnect events. */
  onDisconnect: (handler: (event: SessionEvent) => void) => void
  /** Register handler for session status updates. */
  on_status: (status: ServerLinkStatus) => void
}

/** Create an authenticated live-state websocket session. */
export const create_session = (
  signer: Signer,
  address: string,
  on_packet: (packet: ServerPacket) => void = () => {}
): Session => {
  let disconnectHandler: ((event: SessionEvent) => void) | null = null

  let link: ServerLink

  const session: Session = {
    send: (packet) => link.send(packet),
    status: () => link.status(),
    dispose: () => {
      link.dispose()
      disconnectHandler?.({ type: 'disconnected' })
    },
    onDisconnect: (handler) => {
      disconnectHandler = handler
    },
    // Default status handler — the play loop replaces it with the reporting one.
    on_status: (status) => {
      log_info('session', `status: ${status.kind}`)
    },
  }

  link = create_server_link({
    address,
    signer,
    on_packet,
    on_status: (status) => session.on_status(status),
  })

  return session
}

// ── play loop ────────────────────────────────────────────────────────

/** How long to wait between passes while a fight is mid-resolution (a mob is acting). The poll is a
 *  local checkpoint read, not a transaction, so a sub-second beat just lets us take our turn the
 *  instant the mob's resolves instead of up to a second later — the single biggest inter-turn
 *  latency we control. */
const FIGHT_POLL_MS = 400
/** How long to wait after a settlement batch before re-reading the resolutions feed. */
const SETTLE_POLL_MS = 1_000
/** How long to wait before retrying a settlement that did not complete. */
const SETTLE_RETRY_MS = 15_000
/** After an engage, how long to wait for the roster to reflect the new fight before re-screening. */
const ENGAGE_GRACE_MS = 45_000
/** How long to wait before re-checking auto-equip while a party member is seated in a fight. */
const EQUIP_RETRY_MS = 8_000
/** The world used when neither the character nor config names one. */
const WORLD_FALLBACK = 'nauvis'
/** How many settled fights between console progress digests. */
const SUMMARY_EVERY_FIGHTS = 10
/** How many craft batches one chore beat submits (while affordable). Crafting XP scales with the
 *  batch, and one batch per settled fight left every crafting job far behind the gatherers; the loop
 *  stops the moment nothing is affordable, so it never blocks the pass on an empty inventory. */
const CRAFT_BATCHES_PER_CHORE = 3
/** How often the party-wide Discord digest is sent (configurable; 0 disables). */
const DIGEST_INTERVAL_MS = config.digest_minutes * 60_000
const STRATEGY_STARTUP_DELAY_MS = 90_000
const HEALTH_HEARTBEAT_MS = 15_000
const SLOW_PASS_WARN_MS = 60_000
/** How far (in blocks) a party member may wander for a node while the party is grouping. Two zones is
 *  about 90s of travel under the speed law, cheap enough that the next rendezvous still lands. */
const PARTY_GATHER_RADIUS = 1_024
type XpMark = Readonly<{ experience: bigint; jobs: Readonly<Record<string, bigint>> }>

const xp_snapshot = (character: CharacterRow): XpMark =>
  Object.freeze({
    experience: BigInt(character.experience ?? '0'),
    jobs: Object.freeze(
      Object.fromEntries(Object.entries(character.jobs ?? {}).map(([job, xp]) => [job, BigInt(xp)]))
    ),
  })

/** Total character xp and per-job xp gained since the mark. */
const xp_delta = (before: XpMark, now: XpMark): Readonly<{ xp: bigint; jobs: Readonly<Record<string, bigint>> }> => {
  const jobs: Record<string, bigint> = {}
  for (const [job, value] of Object.entries(now.jobs)) {
    const gained = value - (before.jobs[job] ?? value)
    if (gained > 0n) jobs[job] = gained
  }
  return Object.freeze({ xp: now.experience - before.experience, jobs: Object.freeze(jobs) })
}

/** Per-character runtime state for the parallel play loop. The socket itself is shared. */
type CharRuntime = {
  character: CharacterRow
  ctx: ActionContext
  mover: Mover
  roamer: Roamer
  dungeon: DungeonRunner
  cross_world: CrossWorldGatherer
  stats: PlayStats
  xp_mark: XpMark | null
  chore_pending: boolean
  /** the non-combat chore this character owns (gather one job / rotate crafts / rotate all gathers / none) */
  chore: ChoreRole
  /** rotation cursor for the `gather_all` chore (index into GATHERING_JOBS) */
  gather_cursor: number
  /** set right after an engage; engages are suppressed until the fight surfaces or the grace ends */
  awaiting_fight_ms: number | null
  /** timestamp of last dungeon key craft attempt (rate limit) */
  last_key_craft_attempt_ms: number | null
  /** last time this character's chore genuinely acted (gathered or crafted); the forced window reads it */
  last_chore_ms: number
  /** true on this character's very first pass — auto-equip is deferred past it so the character can
   *  land its first settle/chore/engage before gear swaps start firing. */
  first_pass: boolean
  pass_started_ms: number | null
  last_pass_completed_ms: number | null
  last_pass_error: string | null
}

/** The forced-chore floor: once this character has gone a full interval with NO chore, its pass runs
 *  the chore BEFORE it stages another fight, so gathering/crafting keeps pace behind a wall of engages
 *  instead of only on the settle beat. Stamped only when a chore genuinely acts, so an empty beat does
 *  not reset it. Disabled when `BOT_CHORE_INTERVAL_MS` is 0. */
const chore_due = (rt: CharRuntime): boolean =>
  config.chore_interval_ms > 0 && Date.now() - rt.last_chore_ms >= config.chore_interval_ms

/** Human-readable one-liner for a chore role, logged at startup so it is obvious what each
 *  character will do with its non-combat time. */
const describe_chore = (chore: ChoreRole): string => {
  switch (chore.kind) {
    case 'craft':
      return 'rotate all crafting jobs'
    case 'gather':
      return `gather ${chore.job}`
    case 'gather_all':
      return `gather all (${GATHERING_JOBS.join('/')})`
    case 'gather_craft':
      return `gather ${chore.job} + rotate crafts`
    case 'gather_all_craft':
      return `gather all (${GATHERING_JOBS.join('/')}) + rotate crafts`
    case 'none':
      return 'none'
  }
}

export const play_loop = async (
  signer: Signer,
  address: string,
  toggles: PlayToggles,
  idle_sleep_ms: number = 5_000
): Promise<void> => {
  // ── crash-recovery guard ────────────────────────────────────────────
  // A crash between recording and confirming a transaction leaves a `submitted` record in the
  // durable journal. On the next start the SDK recovers it once and then permanently refuses every
  // further transaction ("previous transaction recovered … refresh your game state") — and there is
  // no API to clear that in-memory state. A fresh process IS the refresh the SDK asks for (the
  // server re-pushes the whole projection), and the journal holds only a digest — never bytes to
  // resubmit — so discard any leftover record instead of bricking every character. Must run before
  // `create_bot_sdk`, which reads the file.
  const journal_path = join(config.state_dir, 'pending-transactions.json')
  try {
    if (existsSync(journal_path) && readFileSync(journal_path, 'utf8').trim() !== '{}') {
      log_warn('session', `discarding stale pending-transaction journal at ${journal_path} (crash recovery)`)
      rmSync(journal_path, { force: true })
    }
  } catch (error) {
    log_warn(
      'session',
      `could not inspect pending-transaction journal: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // ── bot initialization ──────────────────────────────────────────────
  const sdk_started_ms = Date.now()
  const bot = create_bot_sdk(signer, {
    transaction_storage_path: journal_path,
  })
  log_info('startup', `SDK ready in ${Date.now() - sdk_started_ms}ms`)
  const ledger = create_ledger(join(config.state_dir, 'activity.log'))
  const fight_runtimes = create_fight_runtimes()
  const claims = create_group_claims()
  /** Serialize planning and submission against the party's shared kiosk inventory. */
  const craft_queue = create_serial_queue()
  /** Kiosk object ids already consumed while the websocket inventory projection catches up. */
  const party_craft_burned = new Set<string>()
  const prune_party_craft_burned = (): void => {
    const live_ids = new Set(game_state.inventory.map((item) => item.id))
    for (const id of party_craft_burned) if (!live_ids.has(id)) party_craft_burned.delete(id)
  }
  /** One rendezvous state per configured team; claims and transactions remain socket-wide. */
  const party_states = new Map<string, PartyState>()
  const party_state_by_character = new Map<string, PartyState>()

  // ── party-wide Discord digest window ────────────────────────────────
  // A single accumulator for the WHOLE party, separate from each runtime's per-character console
  // stats (which reset every SUMMARY_EVERY_FIGHTS). Folded at each fight/gather/craft and flushed
  // to Discord on a timer, then reset. `digest_marks` snapshots every character's xp so the digest
  // can report the xp gained inside the window without extra chain reads.
  let digest_stats: PlayStats = empty_stats
  const digest_marks = new Map<string, XpMark>()

  // ── shared game state (folded from the one connection) ─────────────
  let game_state: GameState = initial_game_state

  // ── shared link lifecycle ───────────────────────────────────────────
  let stopped = false
  let link_accepted = false
  let started_notified = false
  let party_label = 'party'

  // ── ONE authenticated socket for the whole roster ───────────────────
  // The server pushes the roster on connect (`packet/characters`) and auto-tracks every character
  // in it, so a second socket for the same address would only evict this one.
  const session = create_session(signer, address, (packet: ServerPacket) => {
    game_state = reduce(game_state, { kind: 'packet', packet })
    handle_fight_packet(game_state, fight_runtimes, packet)
  })

  session.on_status = (status: ServerLinkStatus) => {
    if (status.kind === 'accepted' || status.kind === 'latency') link_accepted = true
    else link_accepted = false

    if (status.kind === 'accepted') {
      if (started_notified) {
        log_info('session', 'reconnected')
        return
      }
      started_notified = true
      log_info('session', `connected — driving ${party_label}`)
      return
    }
    if (status.kind === 'awaiting_signature') {
      log_info('startup', 'realtime server connected; waiting for its authentication challenge')
      return
    }
    if (status.kind === 'authenticating') {
      log_info('startup', 'signing realtime server challenge')
      return
    }
    if (status.kind === 'replaced') {
      if (stopped) return
      stopped = true
      log_error('session', `replaced by another login: ${status.reason}`)
      notify(`session replaced by another login (${status.reason}) — stopping`, 'error')
      // Force exit after a short delay to allow notification to send
      setTimeout(() => process.exit(1), 2000)
      return
    }
    if (status.kind === 'rejected') {
      if (stopped) return
      stopped = true
      log_error('session', `auth rejected: ${status.reason}`)
      notify(`auth rejected (${status.reason}) — stopping`, 'error')
    }
    if (status.kind === 'failed') {
      log_warn('session', `connection failed: ${status.error}`)
    }
    if (status.kind === 'violation') {
      log_warn('session', `connection violation: ${status.reason}`)
    }
  }

  // The link is long-lived: a transient drop keeps this session object and reconnects in place, so
  // the same handler fires again on recovery. A hard stop is only the terminal statuses above.

  // ── discover characters from the roster ────────────────────────────
  // Poll fast at first (200ms × 10 = 2s) so a responsive server doesn't cost 30s, then fall back
  // to 1s cadence. The server pushes `packet/characters` on connect, so a healthy link populates
  // the roster within a beat.
  log_info('startup', 'connecting to realtime server and waiting for the character roster')
  const roster_started_ms = Date.now()
  let roster_ready = false
  for (let i = 0; i < 30; i++) {
    if (game_state.characters.length > 0) {
      roster_ready = true
      break
    }
    await sleep(i < 10 ? 200 : 1000)
  }
  if (!roster_ready) {
    log_error('session', `no characters found in roster after ${Date.now() - roster_started_ms}ms`)
    session.dispose()
    return
  }
  log_info(
    'startup',
    `roster ready: ${game_state.characters.length} characters in ${Date.now() - roster_started_ms}ms`
  )

  // Keep the current four in their established order, then prefer a Tomoda as the fifth member.
  // Other owned characters follow deterministically, so the new support joins without requiring a
  // rename. The server roster has a six-character cap; config.party_size is capped at five.
  const knownNameOrder = ['omori', 'memorien', 'llokan', 'archero']
  const rank_of = (character: CharacterRow): number => {
    const name = character.name.toLowerCase()
    const index = knownNameOrder.indexOf(name)
    if (index >= 0) return index
    if (character.classe.toLowerCase() === 'tomoda') return knownNameOrder.length
    if (name === 'archerro') return knownNameOrder.length + 1
    return knownNameOrder.length + 2
  }
  const ordered = game_state.characters
    .slice()
    .sort((a, b) => rank_of(a) - rank_of(b) || a.name.localeCompare(b.name))
  const explicit_names = config.teams?.flat() ?? null
  const requested = explicit_names
    ? explicit_names.flatMap((name) => {
        const character = ordered.find((row) => row.name.toLowerCase() === name)
        if (!character) log_warn('party', `BOT_TEAMS character "${name}" is not in the account roster`)
        return character ? [character] : []
      })
    : ordered
  const party = requested.slice(0, config.party_size)
  if (requested.length > config.party_size)
    log_warn('party', `BOT_TEAMS asks for ${requested.length} characters but BOT_PARTY_SIZE permits ${config.party_size}; trailing members are omitted`)
  const first_team_leader = config.teams?.[0]?.[0]
  const leader = party.find((c) => c.name.toLowerCase() === (first_team_leader ?? config.leader_name).toLowerCase()) ?? party[0]
  if (!leader) {
    log_error('session', 'no characters available to drive')
    session.dispose()
    return
  }
  if (!config.teams && leader.name.toLowerCase() !== config.leader_name.toLowerCase())
    log_warn('session', `configured leader "${config.leader_name}" not in the party — ${leader.name} leads instead`)

  // Compute effective level: the party's maximum character level
  const effectiveLevel = party.length > 0 ? Math.max(...party.map((c) => c.level)) : 0

  // A default one-team setup preserves existing behavior. Explicit BOT_TEAMS partitions the
  // roster into independently coordinated squads; each squad owns its rendezvous/dungeon state.
  const team_rows = config.teams
    ? config.teams.map((names) => names.flatMap((name) => {
        const row = party.find((c) => c.name.toLowerCase() === name)
        return row ? [row] : []
      })).filter((rows) => rows.length > 0)
    : [party]
  team_rows.forEach((rows, index) => {
    const team_leader = rows.find((row) => row.name.toLowerCase() === (config.teams?.[index]?.[0] ?? config.leader_name).toLowerCase()) ?? rows[0]!
    const state = create_party()
    state.leader_id = team_leader.id
    state.members = Object.freeze(rows.map((row) => row.id))
    const key = `team-${index + 1}`
    party_states.set(key, state)
    for (const row of rows) party_state_by_character.set(row.id, state)
    log_info('party', `${key}: leader=${team_leader.name} members=${rows.map((row) => row.name).join(', ')}`)
  })

  party_label = `lvl ${effectiveLevel} · ${team_rows.map((rows, i) => `team ${i + 1}: ${rows.map((c) => c.name).join(', ')}`).join(' | ')}`
  log_info(
    'session',
    `party: leader=${leader.name} members=${party.length} group=${toggles.group} — effective_lvl=${effectiveLevel}`
  )

  // Startup diagnostic: log every character's job levels so we can see the actual state.
  const job_lines: string[] = []
  for (const c of party) {
    const levels = (job_slugs as readonly string[])
      .map((j) => {
        const xp = Number(c.jobs?.[j] ?? '0')
        return `${j.slice(0, 3)}:${job_level_from_xp(xp)}`
      })
      .join(' ')
    log_info('session', `${c.name} jobs — ${levels}`)
    job_lines.push(`**${c.name}** (lvl ${c.level}) — ${levels}`)
  }

  // Startup notification: reassure the operator the bot resumed, which party it drives and at what
  // job levels. This is the "it is running" heartbeat the operator asked for; the periodic digest
  // (below) is the recurring "what it is doing" follow-up.
  notify(
    [
      `✅ AresRPGAuto started — ${party_label}`,
      `leader=${leader.name} · group=${toggles.group} · world=${leader.world ?? config.world ?? WORLD_FALLBACK}`,
      ...job_lines,
    ].join('\n'),
    'success'
  )

  // ── create per-character runtimes (all on the shared socket) ────────
  const runtimes: CharRuntime[] = []
  // All characters draw tools and stacks from the same kiosk inventory. A queue per runtime still
  // lets two characters claim the same projected item concurrently, so serialize these mutations
  // across the whole party.
  const equipment_queue = create_serial_queue()

  for (const character of party) {
    const world = character.world ?? config.world ?? WORLD_FALLBACK
    const team_state = party_state_by_character.get(character.id)!
    // Cross-world trips return to this team's leader world, including after a restart mid-trip.
    const home_world = party.find((row) => row.id === team_state.leader_id)?.world ?? config.world ?? WORLD_FALLBACK

    const ctx: ActionContext = {
      sdk: bot,
      address,
      character_id: character.id,
      world,
      state: () => game_state,
      send: (packet) => session.send(packet),
      equipment_queue,
      ledger,
      notify,
      fight_runtimes,
      claims,
      party_state: party_state_by_character.get(character.id)!,
      dungeon_blacklist: new Map<string, number>(),
      strategy: () => strategy_ref.get(party_state_by_character.get(character.id)!) ?? null,
    }

    const mover = create_mover(ctx)
    const roamer = create_roamer(ctx)
    const dungeon = create_dungeon_runner(ctx)
    const cross_world = create_cross_world_gatherer(ctx, home_world)

    // The chore plan is keyed by character name: omori rotates every crafting job while each other
    // character owns ONE gathering job, so the party covers every gathering leaf and craft trade.
    const chore: ChoreRole = config.chore_plan[character.name.toLowerCase()] ?? Object.freeze({ kind: 'none' })
    log_info('session', `${character.name}: chore = ${describe_chore(chore)}`)
    if (chore.kind === 'none' && character.classe.toLowerCase() === 'tomoda')
      log_info('session', `${character.name}: Tomoda is left chore-free to focus on party support in combat`)
    else if (chore.kind === 'none')
      log_warn('session', `${character.name}: no chore assignment — this character will only fight`)

    runtimes.push({
      character,
      ctx,
      mover,
      roamer,
      dungeon,
      cross_world,
      stats: empty_stats,
      xp_mark: xp_snapshot(character),
      chore_pending: false,
      chore,
      gather_cursor: 0,
      awaiting_fight_ms: null,
      last_key_craft_attempt_ms: null,
      last_chore_ms: Date.now(),
      first_pass: true,
      pass_started_ms: null,
      last_pass_completed_ms: null,
      last_pass_error: null,
    })
  }

  // ── auto-equip ──────────────────────────────────────────────────────
  // Every character keeps the best gear it can actually wear. A check runs once the party is up, then
  // again whenever NEW equipment lands in the shared kiosk (a mob drop, a craft, a purchase): the
  // inventory carries worn and held items alike, so "an equipment id the party has never seen" is the
  // drop signal. Runs are COALESCED — four parallel passes schedule at most one party-wide pass — and
  // each character claims its picks so two never reach for the same item.
  /** party-wide: the last time ANY member attempted the dungeon-key craft */
  let last_party_key_craft_ms = 0
  let seen_gear_ids = new Set<string>()
  let equip_running = false
  let equip_requested = false
  const equip_targets = (): readonly EquipTarget[] =>
    runtimes.map((rt) => ({
      ctx: rt.ctx,
      tool_category:
        rt.chore.kind === 'gather' || rt.chore.kind === 'gather_craft'
          ? tool_category_of_job(rt.chore.job)
          : undefined,
    }))
  const run_auto_equip = async (): Promise<void> => {
    if (equip_running) {
      equip_requested = true
      return
    }
    equip_running = true
    try {
      do {
        equip_requested = false
        if (version_gate_active()) break
        let blocked = 0
        try {
          const report = await auto_equip_party(equip_targets())
          blocked = report.blocked
        } catch (error) {
          log_warn('session', `auto-equip failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (version_gate_active()) break
        // A character seated in a fight (or not yet fresh) is reported blocked; a drop that lands
        // mid-fight is thus re-checked until the party is out, instead of being lost until restart.
        if (blocked > 0 && !stopped) {
          equip_requested = true
          await sleep(EQUIP_RETRY_MS)
        }
      } while (equip_requested && !stopped)
    } finally {
      equip_running = false
    }
  }
  const request_auto_equip = (): void => {
    void run_auto_equip()
  }

  // ── periodic strategy brain ─────────────────────────────────────────
  // The whole-content plan (the global farm distance + the gear acquisition routes), recomputed by
  // `strategy_loop` and read by the roam and the engage. One mutable ref shared by every character's
  // ctx: `farm.distance` is where the party should stand, `wanted_mobs` biases the engage toward
  // families whose loot carries a wanted upgrade.
  const strategy_ref = new Map<PartyState, Strategy>()

  // ── gear craft goals ────────────────────────────────────────────────
  // The craft planner's priority list: the best CRAFTABLE weapon/armour/accessory for each character at
  // its level and affinity (see `actions/gear.ts`). Computed once per shared projection and reused by
  // every character's chore in the same beat, because all four craft against the same inventory. The
  // projection object is replaced on every packet, so identity is a faithful cache key.
  let gear_goal_cache: Readonly<{ state: GameState; outputs: readonly string[] }> | null = null
  const current_gear_goals = (): readonly string[] => {
    if (gear_goal_cache && gear_goal_cache.state === game_state) return gear_goal_cache.outputs
    const driven_characters = runtimes.flatMap((runtime) => {
      const character = game_state.characters.find((row) => row.id === runtime.character.id)
      return character ? [character] : []
    })
    const outputs = gear_goal_outputs(driven_characters, game_state)
    gear_goal_cache = Object.freeze({ state: game_state, outputs })
    return outputs
  }
  const TOOL_OUTPUT_BY_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
    tool_farmer: 'old_hoe',
    tool_herbalist: 'tool_herbalist',
    tool_miner: 'basic_pickaxe',
  })
  let tool_goal_cache: Readonly<{ state: GameState; outputs: readonly string[] }> | null = null
  const current_tool_goals = (): readonly string[] => {
    if (tool_goal_cache && tool_goal_cache.state === game_state) return tool_goal_cache.outputs
    if (!toggles.gather) return Object.freeze([])
    const unavailable = unavailable_item_ids(game_state)
    const outputs = new Set<string>()
    for (const rt of runtimes) {
      const jobs: readonly GatheringJob[] =
        rt.chore.kind === 'gather' || rt.chore.kind === 'gather_craft'
          ? [rt.chore.job]
          : rt.chore.kind === 'gather_all' || rt.chore.kind === 'gather_all_craft'
            ? GATHERING_JOBS
            : []
      if (jobs.length === 0) continue
      const character = game_state.characters.find((row) => row.id === rt.character.id)
      if (!character) continue
      for (const job of jobs) {
        const category = tool_category_of_job(job)
        const worn_here = character.equipment.some((item) => item.category === category)
        const available_in_kiosk = game_state.inventory.some(
          (item) => item.category === category && !unavailable.has(item.id)
        )
        if (worn_here || available_in_kiosk) continue
        const output = TOOL_OUTPUT_BY_CATEGORY[category]
        if (output) outputs.add(output)
      }
    }
    const result = Object.freeze([...outputs])
    tool_goal_cache = Object.freeze({ state: game_state, outputs: result })
    return result
  }
  /** true once, on the first pass that sees an equipment id the party has never seen (boot, drop,
   *  craft). The seen set is only advanced when something new appeared, so a removed id re-triggers
   *  if it ever comes back. */
  const take_gear_trigger = (state: GameState): boolean => {
    let fresh = false
    const next = new Set<string>()
    for (const item of state.inventory) {
      if (!is_equipment_category(item.category)) continue
      next.add(item.id)
      if (!seen_gear_ids.has(item.id)) fresh = true
    }
    if (fresh) seen_gear_ids = next
    return fresh
  }

  if (!config.discord_webhook_url)
    log_warn('session', 'DISCORD_WEBHOOK_URL is unset — notifications are disabled')

  // ── bulk-craft command ──────────────────────────────────────────────
  // Usage: bun run bot bulk-craft <output_type> <quantity> [output_type <quantity>] ...
  // Example: bun run bot bulk-craft quartzbound_hoe 4 quartzbound_sickle 4
  // The command crafts the specified output_types the given quantities for each character,
  // then the bot enters its normal play loop.
  const bulkArgs = process.argv.slice(2)
  if (bulkArgs[0] === 'bulk-craft') {
    await craft_queue.run(async () => {
    prune_party_craft_burned()
    // All characters share one kiosk inventory. Until the websocket projection catches up,
    // never submit a kiosk object id consumed by an earlier bulk-craft transaction.
    const bulkBurned = new Set<string>()
    for (const rt of runtimes) {
      const results: Array<{ output_type: string; success: boolean; message: string }> = []
      for (let i = 1; i + 1 < bulkArgs.length; i += 2) {
        const outputType = bulkArgs[i]
        const quantity = Number(bulkArgs[i + 1])
        if (isNaN(quantity) || quantity <= 0) {
          results.push({
            output_type: outputType,
            success: false,
            message: `invalid quantity: ${bulkArgs[i + 1]}`,
          })
          continue
        }
        const raw = recipes_by_output[outputType]
        if (!raw) {
          results.push({
            output_type: outputType,
            success: false,
            message: `unknown recipe: ${outputType}`,
          })
          continue
        }
        const detail = recipe_detail(raw)
        let crafted = 0
        while (crafted < quantity) {
          const character = game_state.characters.find((c) => c.id === rt.character.id)
          if (!character) {
            results.push({
              output_type: outputType,
              success: false,
              message: `character ${rt.character.name} not found`,
            })
            break
          }
          prune_party_craft_burned()
          const unavailable = new Set([...unavailable_item_ids(game_state), ...bulkBurned, ...party_craft_burned])
          const plan = plan_recipe(character, detail, game_state.inventory, unavailable)
          if (!plan) {
            results.push({
              output_type: outputType,
              success: false,
              message: `cannot craft: missing ingredients or insufficient level for ${outputType}`,
            })
            break
          }
          const result = await craft_once(rt.ctx, plan)
          if (result.success) {
            for (const id of result.input_item_ids) party_craft_burned.add(id)
            crafted += result.successes
            for (const id of result.input_item_ids) bulkBurned.add(id)
            results.push({
              output_type: outputType,
              success: true,
              message: `crafted ${result.successes} × ${outputType}`,
            })
          } else {
            results.push({
              output_type: outputType,
              success: false,
              message: `craft failed: ${result.outcome}`,
            })
            break
          }
        }
      }
      const successCount = results.filter((r) => r.success).length
      const failCount = results.filter((r) => !r.success).length
      const summary = successCount
        ? `${rt.character.name}: bulk-craft: ${successCount} succeeded, ${failCount} failed`
        : `${rt.character.name}: bulk-craft: all ${failCount} failed`
      log_info('session', summary)
    }
    })
    return
  }

  // ── per-character decision pass ─────────────────────────────────────
  // ARES_DIAGNOSTIC_PATCH_V1
  const trace_step = async <T>(
    character: string,
    step: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now()
    log_trace('trace', () => `${character}: >>> ${step}`)

    try {
      const result = await operation()
      log_trace(
        'trace',
        () => `${character}: <<< ${step} (${Date.now() - started}ms)`,
      )
      return result
    } catch (error) {
      log_error(
        'trace',
        `${character}: !!! ${step} after ${Date.now() - started}ms: ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }`,
      )
      throw error
    }
  }

  const pass_diag = new Map<string, string>()
  const run_pass = async (rt: CharRuntime): Promise<number> => {
    const { ctx, mover, roamer, character } = rt
    const party_state = ctx.party_state
    const strategy_plan = strategy_ref.get(party_state) ?? null
    const team_level = Math.max(
      0,
      ...party_state.members.flatMap((id) => {
        const row = game_state.characters.find((candidate) => candidate.id === id)
        return row ? [row.level] : []
      })
    )

    // Re-read the character from the latest state
    const current = game_state.characters.find((c) => c.id === character.id)
    if (!current) return idle_sleep_ms

    // A package-version abort is process-wide and latched. Do not let other characters continue
    // issuing doomed transactions while the deployment pins / gate are inconsistent.
    if (version_gate_active()) return idle_sleep_ms

    mover.sync(current)

    // Verbose trace (BOT_DEBUG=1): log whenever the pose, anchor or roster row changes, so a pose
    // that snaps backward can be attributed to whoever moved it (sync vs a travel leg).
    {
      const a = mover.anchor()
      const p = mover.pose()
      const sig = `pose=${p.x},${p.z} anchor=${a ? `${a.x},${a.z}@${a.at_ms}` : 'null'} row=${current.x},${current.z}@${current.at_ms}`
      if (pass_diag.get(character.id) !== sig) {
        pass_diag.set(character.id, sig)
        log_debug('pass', `${character.name}: ${sig}`)
      }
    }

    // Track the LIVE streamed pose, NOT the chain checkpoint the roster row reports. The push lags
    // the chain by minutes and a row only moves on an action door, so a follower that is merely
    // RALLYING keeps reporting the spot it last searched. Every consumer of this map asks "where is
    // this character now" — `party_center` (the engage preview's pose, the rendezvous target, the
    // leader's keep-together geometry) and the excursion reach check — so a frozen row made the
    // preview screen the same mob groups no matter how far the party walked (observed: identical
    // win rates at every zone for hours, and a percentile cap that never let the party engage).
    const live_pose = mover.pose()
    party_state.poses.set(character.id, { x: live_pose.x, z: live_pose.z })

    // 0. freshness gate — refuse to submit ANY transaction (settle, drive, engage, gather, equip)
    // while the link is unauthenticated, gameplay is frozen, indexing lag is unacceptable, or the
    // chain clock is stale. Placed BEFORE settle/drive so a paused game never emits a single tx.
    const fresh = freshness(game_state, Date.now())
    if (!fresh.ok) {
      log_warn('session', `${character.name}: holding — ${fresh.reason}`)
      return idle_sleep_ms
    }

    // 1. reconcile any ended fight (settle loot, then close the fight object)
    log_debug(
      'pass',
      `${character.name}: active_fight=${active_fight_of(current) ?? '-'} resolutions=${game_state.resolutions.length} group_attempting=${party_attempting(party_state)}`
    )
    const settled = await trace_step(character.name, 'settle_pending', () => settle_pending(ctx))
    if (settled.settled) {
      log_info('session', `${character.name}: ${settled.detail}`)
      rt.stats = settled.reports.reduce(record_fight, rt.stats)
      digest_stats = settled.reports.reduce(record_fight, digest_stats)
      rt.chore_pending = true
      flush_summary(rt)
      return SETTLE_POLL_MS
    }
    if (settled.pending) {
      log_warn('session', `${character.name}: settlement incomplete: ${settled.detail}`)
      return SETTLE_RETRY_MS
    }
    await trace_step(character.name, 'close_pending', () => close_pending(ctx))

    // 2. drive whatever our active fight needs right now. The per-fight lock serializes allied
    // seats: in a group fight the leader and its partners place/ready/turn on the same object, so
    // only one of them may submit at a time.
    const active_fight = active_fight_of(current)
    if (active_fight) {
      rt.awaiting_fight_ms = null
      const outcome = await fight_runtimes.with_lock(active_fight, () => drive_fight(ctx))
      log_debug('pass', `${character.name}: fight outcome=${outcome.kind}${outcome.detail ? ` (${outcome.detail})` : ''}`)
      if (outcome.kind !== 'waiting_turn' && outcome.kind !== 'not_our_turn')
        log_info('session', `${character.name}: fight ${outcome.kind}${outcome.detail ? ` (${outcome.detail})` : ''}`)
      return FIGHT_POLL_MS
    }

    // A fired resource-protector verdict roots the character until resolve_ambush succeeds. Recover
    // it here even if gathering was disabled or the original resolve transaction failed. This must
    // follow active-fight handling because the projection can show the verdict briefly after the
    // fight itself has already appeared.
    if (await trace_step(character.name, 'resolve_pending_ambush', () => resolve_pending_ambush(ctx, current))) return FIGHT_POLL_MS

    // 2b. spend stat capital / spell points a level-up granted (out of fight only — the chain
    // borrows the character from the kiosk, which a seated fighter cannot lend).
    if (await trace_step(character.name, 'maybe_progress', () => maybe_progress(ctx, current))) return SETTLE_POLL_MS

    // 2b. an engage was just submitted but the roster has not caught up yet: do not re-engage into
    // the indexing window (that is the double-engage that aborts on chain).
    if (rt.awaiting_fight_ms !== null) {
      if (Date.now() - rt.awaiting_fight_ms < ENGAGE_GRACE_MS) return idle_sleep_ms
      rt.awaiting_fight_ms = null
    }

    // 3a. auto-equip. The first pass that meets a new equipment id gears the WHOLE party (coalesced),
    // so a drop is equipped the moment it lands rather than at the next restart. Deferred past the
    // very first pass so the character can land its first settle/chore/engage before gear swaps fire.
    if (!rt.first_pass && take_gear_trigger(game_state)) request_auto_equip()
    rt.first_pass = false

    // 3b. group fight: while the party wants to fight as ONE side, a follower must not wander off to
    // a chore — that strands the rendezvous and forces a fresh multi-minute convergence. So the group
    // step runs FIRST for followers; the leader instead CRAFTS first (below) so omori's crafting jobs
    // still level while the party chains fights. A settled fight re-forms the party before harvesting.
    //
    // Dungeon runs are now GROUP activities: the leader starts each room's fight, then all followers
    // join it. The leader is rooted at the portal but the fight is a normal group fight.
    const group_mode = toggles.group && party_attempting(party_state)
    const is_leader = character.id === party_state.leader_id

    // 3b-bis. group dungeon: when the leader has committed the party to a run, every key-holder must
    // ENTER it before the dungeon door will accept its join. A follower walks to the portal and burns
    // its own key here — before the routed steps below can send it off gathering. The step also gives
    // up a run the leader is no longer driving, so a follower never sits rooted at a portal.
    if (toggles.group && !is_leader) {
      if (await trace_step(character.name, 'follower_dungeon_step', () => follower_dungeon_step(ctx, mover))) return idle_sleep_ms
    }

    // 3c. keep the party together. Every activity below can hand the LEADER a far target — the
    // recipe-driven chore's demanded node, a dungeon city, an excursion zone, a roam band — and each
    // walks it there in ONE silent `travel_to` leg (a healthy multi-minute walk logs nothing while
    // the followers, left at the old spot, are eventually written off as stragglers). So before any
    // of them runs, and before the leader opens a rendezvous, a leader that has drifted outside
    // PARTY_RADIUS walks back to the party and does nothing else this pass. A live dungeon run owns
    // the character at the portal, so it is exempt — this gate collects it the moment the run ends.
    if (group_mode && is_leader && !current.dungeon_run) {
      const regroup = regroup_step(party_state, mover.pose())
      if (regroup) {
        // One bounded hop toward the party, not a full leg: a full leg blocks for the whole walk, and
        // the followers (rallying toward the leader's moving pose) would cross past it. Hopping lets
        // both sides re-read each other each pass and meet in the middle.
        const hop = hop_toward(mover.pose(), { x: regroup.x, z: regroup.z }, PARTY_RADIUS)
        // Throttled: a long walk back re-runs this once per idle pass, and unthrottled it buried the
        // operator log under hundreds of identical lines.
        if (log_rejoin_due(character.id, Date.now()))
          log_warn(
            'party',
            `${character.name}: regrouping — ${Math.round(regroup.offset)} blocks from the party centre, walking back to ${hop.x},${hop.z}`
          )
        try {
          await trace_step(character.name, 'regroup.travel_to', () => mover.travel_to(hop.x, hop.z))
        } catch (error) {
          log_warn('party', `regroup leg paused: ${error instanceof Error ? error.message : String(error)}`)
        }
        return idle_sleep_ms
      }
    }

    // Dungeon (leader only): while omori holds a key it runs the dungeon. This runs before the
    // excursion/group steps — a live run roots the character at the portal, so travelling would only
    // fail. Step 2 above drives the room turns; step 1 routes the ended room's settlement through
    // the dungeon door, which advances the run or ends it.
    // When the leader starts a room, it becomes the party's active group fight — followers join it.
    if (should_run_dungeons(current, ctx)) {
      const dungeon = await trace_step(character.name, 'dungeon.run_once', () => rt.dungeon.run_once(mover))
      if (dungeon !== null) {
        if (dungeon.kind !== 'skipped' && dungeon.kind !== 'waiting')
          log_info('session', `${character.name}: dungeon ${dungeon.kind} — ${dungeon.detail}`)
        // The room fight was started: join every follower that has ENTERED the run. A dungeon room
        // refuses the ordinary join (its door policy), so each seat goes through the dungeon door; a
        // member that never entered is skipped (the door would abort).
        if (dungeon.kind === 'started' && dungeon.fight_id) {
          const dungeon_name = current.dungeon_run?.dungeon ?? party_state.dungeon?.dungeon ?? null
          const followers = party_state.members.filter((id) => {
            if (id === party_state.leader_id || party_state.detached.has(id)) return false
            const row = game_state.characters.find((c) => c.id === id)
            if (!row?.dungeon_run) return false
            return dungeon_name === null || row.dungeon_run.dungeon === dungeon_name
          })
          if (followers.length > 0) {
            try {
              await join_dungeon_followers(ctx, followers, dungeon.fight_id)
            } catch (error) {
              log_warn('party', `dungeon join failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          party_state.fight = dungeon.fight_id
          party_state.phase = 'active'
          party_state.active_since_ms = Date.now()
          party_state.failures = 0
          log_info('party', `dungeon room fight ${dungeon.fight_id} — party engaged`)
        }
        return idle_sleep_ms
      }
    }

    // Cross-world gathering (the designated detacher only): drive its trip state machine. A detacher
    // is marked on the shared party so the leader's rendezvous ignores the missing seat; while it is
    // away its whole pass belongs to the trip, so it never wanders back into a nauvis rendezvous.
    if (toggles.cross_world) {
      const cross = await trace_step(character.name, 'cross_world.run_once', () => rt.cross_world.run_once(party_state, mover))
      if (cross.handled) {
        log_debug('cross_world', `${character.name}: ${cross.detail}`)
        return idle_sleep_ms
      }
    }

    // Excursion management (leader only): if the party is grouping, check whether a gather gap
    // has persisted and plan a relocation. This runs BEFORE the group step so the leader walks to
    // the resource instead of staging a fight.
    if (group_mode && is_leader) {
      const pose: PartyPose = mover.pose()
      if (party_state.excursion) {
        // Active excursion: check if it's done (dwell elapsed or all needs satisfied).
        if (excursion_done(game_state, party_state)) {
          finish_excursion(party_state)
        } else if (party_state.excursion.arrived_ms === 0) {
          // Still traveling: move the leader toward the destination.
          // Don't plan new fights while traveling.
          if (await safe_travel_to(mover, party_state.excursion.x, party_state.excursion.z)) {
            // Arrived at the zone center; prove the leg and discover the zone so the window updates.
            if (await trace_step(character.name, 'excursion.prove_ready', () => mover.prove_ready(party_state.excursion!.x, party_state.excursion!.z))) {
              await trace_step(character.name, 'ensure_zone', () => mover.ensure_zone(false))
            }
            party_state.excursion = Object.freeze({
              ...party_state.excursion,
              arrived_ms: Date.now(),
            })
            log_info('party', `excursion: arrived at ${party_state.excursion.zx}:${party_state.excursion.zz}`)
          }
          return idle_sleep_ms
        }
        // Dwell phase (arrived_ms > 0 but not done): allow normal fight staging at the destination.
        // Fall through to leader_group_step which will pick fights at the excursion zone.
      } else if (await trace_step(character.name, 'maybe_start_excursion', async () => maybe_start_excursion(ctx, party_state, current, pose))) {
        // Excursion just started; skip this pass so the leader begins walking.
        return idle_sleep_ms
      }
    }

    if (group_mode && is_leader && (rt.chore_pending || chore_due(rt))) {
      rt.chore_pending = false
      // Bounded to the party's neighbourhood: an unbounded chore hands the leader the demanded node
      // the crafting rotation owes, which may be zones away, and walks it there alone in one silent
      // leg. Bounded, the leader harvests what is local and lets the party relocate when needed.
      if (await trace_step(character.name, 'run_chore_leader', () => run_chore(rt, true))) return idle_sleep_ms
    }

    if (group_mode) {
      const handled = is_leader
        ? await trace_step(character.name, 'leader_group_step', () => leader_group_step(ctx, mover, current, party_state))
        : party_state.detached.has(current.id)
          ? null
          : await trace_step(character.name, 'follower_group_step', () => follower_group_step(ctx, mover, current, party_state))
      if (handled !== null) return handled
      // The group step found nothing to stage in the CURRENT window — only now does the leader
      // roam, with a bounded step (PARTY_RADIUS) so a relocation creeps toward the band and the
      // followers keep the rendezvous inside the staging timeout instead of being left behind for a
      // single 20_000-block leg. This must run AFTER the group step, never before: a `waiting`/
      // `roamed` return skipped the leader's `leader_group_step` travel_to AND its stage-timeout
      // check for a whole pass, so an already-staged group sat parked (observed: 13:52 staging ->
      // 14:53 engage).
      if (is_leader && toggles.roam) {
        const roamed = await trace_step(character.name, 'roamer.roam_once', () => roamer.roam_once(
          mover,
          team_level,
          PARTY_RADIUS,
          window_viable(party_state),
          strategy_plan?.farm?.distance ?? null,
          strategy_plan?.loot_focus ?? null
        ))
        if (roamed.kind === 'roamed') log_info('session', `${character.name}: roamed — ${roamed.detail}`)
        if (
          roamed.kind === 'roamed' ||
          roamed.kind === 'joined' ||
          roamed.kind === 'traveling' ||
          roamed.kind === 'waiting'
        )
          return idle_sleep_ms
      }
    }

    // 3d. rejoin gate. A follower left far behind (a world-join drop, or a leader that strayed before
    // the keep-together gate existed) must walk home BEFORE it does any chore: a gather/craft
    // re-anchors its chain checkpoint where it stands, so the member keeps spending its travel budget
    // on the wrong place and never closes the gap — which is how one sat at the world centre for hours
    // while the party fought at three seats. Every hop also re-anchors (`search_zone`) at the streamed
    // pose, exactly like the rendezvous staging leg, so the on-chain checkpoint genuinely hops toward
    // the leader instead of only the reported pose. Runs after the group step so an in-flight
    // rendezvous still owns the pass.
    if (needs_rejoin(party_state, game_state, current.id, mover.pose())) {
      const leader_pose = leader_live_pose(party_state, game_state)
      if (leader_pose) {
        if (log_rejoin_due(current.id, Date.now())) {
          const pose = mover.pose()
          const away = Math.round(Math.max(Math.abs(leader_pose.x - pose.x), Math.abs(leader_pose.z - pose.z)))
          log_warn('party', `${character.name}: ${away} blocks from the leader — walking home before any chore`)
        }
        const before = mover.pose()
        await trace_step(character.name, 'rally_to_leader', () => rally_to_leader(mover, leader_pose))
        const after = mover.pose()
        if (after.x !== before.x || after.z !== before.z) {
          try {
            await trace_step(character.name, 'ensure_zone', () => mover.ensure_zone(false))
          } catch (error) {
            log_warn('party', `${character.name}: could not re-anchor while walking home: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return idle_sleep_ms
    }

    // 3c. chores — a settled fight is the natural beat to harvest one node and craft one batch; a
    // character that has since blown the forced window runs one too, so no engage cadence starves it.
    if (rt.chore_pending || chore_due(rt)) {
      rt.chore_pending = false
      if (await trace_step(character.name, 'run_chore', () => run_chore(rt, group_mode))) return idle_sleep_ms
    }

    // 4. fight: never burn gas on trivial prey
    if (toggles.fight) {
      // While the party is grouping, a follower does NOT roam to its own band — it rallies to the
      // leader and holds, so the next rendezvous is a short hop instead of a fresh convergence.
      if (group_mode && character.id !== party_state.leader_id) {
        const leader_row = game_state.characters.find((c) => c.id === party_state.leader_id)
        const leader_pose = leader_live_pose(party_state, game_state)
        // Rally only while the leader is in this member's world. A member in another world (a
        // cross-world trip, a fresh world-join) cannot walk to a pose in a different world, so it
        // falls through to its own chore instead of burning the pass on an impossible leg.
        const same_world =
          leader_row === undefined ||
          leader_row.world === undefined ||
          current.world === undefined ||
          leader_row.world === current.world
        if (leader_pose && same_world) {
          await trace_step(character.name, 'rally_to_leader', () => rally_to_leader(mover, leader_pose))
          return idle_sleep_ms
        }
      }

      // Leader already roamed before group step. Followers already rallied.
      // Solo play (no group): roam and engage with default step (2500 blocks).
      if (!group_mode && toggles.roam) {
        const roamed = await trace_step(character.name, 'roamer.roam_once', () => roamer.roam_once(
          mover,
          team_level,
          undefined,
          undefined,
          strategy_plan?.farm?.distance ?? null,
          strategy_plan?.loot_focus ?? null
        ))
        if (roamed.kind === 'roamed') log_info('session', `${character.name}: roamed — ${roamed.detail}`)
        if (
          roamed.kind === 'roamed' ||
          roamed.kind === 'joined' ||
          roamed.kind === 'traveling' ||
          roamed.kind === 'waiting'
        )
          return idle_sleep_ms
      }

      // Solo play: leader owns every engage
      if (!group_mode) {
        const engaged = await engage_once(ctx, mover)
        if (engaged.kind === 'engaged') {
          rt.awaiting_fight_ms = Date.now()
          return idle_sleep_ms
        }
        if (engaged.kind === 'traveling') return idle_sleep_ms
      }
    }

    // 5. chores fallback: with no fight on offer, harvest and craft rather than idle.
    if (await trace_step(character.name, 'run_chore', () => run_chore(rt, group_mode))) return idle_sleep_ms

    return idle_sleep_ms
  }

  /** Log one digest once the window holds enough fights, then reset the window. */
  const flush_summary = (rt: CharRuntime): void => {
    if (rt.stats.fights < SUMMARY_EVERY_FIGHTS) return
    const current = game_state.characters.find((c) => c.id === rt.character.id)
    if (!current) return
    const now = xp_snapshot(current)
    const delta = xp_delta(rt.xp_mark ?? now, now)
    log_info('session', `${rt.character.name}: ${format_summary(rt.stats, delta.xp, delta.jobs)}`)
    rt.stats = empty_stats
    rt.xp_mark = now
  }

  /** Run this character's assigned chore; true when it acted. When `local_only`, a gather is capped
   *  to the party's neighbourhood so a follower never strands itself chasing a node across zones. */
  const run_chore = async (rt: CharRuntime, local_only = false): Promise<boolean> => {
    const { ctx, mover, chore, character } = rt
    const party_state = ctx.party_state
    let acted = false

    // Which gathering job this pass should harvest, if any. `gather_all` and `gather_all_craft`
    // rotate every job via a per-character cursor; `gather` and `gather_craft` target their one job.
    const gather_job =
      chore.kind === 'gather' || chore.kind === 'gather_craft'
        ? chore.job
        : chore.kind === 'gather_all' || chore.kind === 'gather_all_craft'
          ? GATHERING_JOBS[rt.gather_cursor % GATHERING_JOBS.length]
          : undefined

    if (gather_job !== undefined && toggles.gather) {
      // Recipe-driven gathering: the party shares ONE kiosk inventory and ONE crafter, so the
      // leader's job levels decide which inputs the rotations still owe — every gatherer then
      // walks toward those (and the dungeon-key materials) instead of the tier ladder alone.
      const crafter = game_state.characters.find((c) => c.id === party_state.leader_id)
      const key_outputs = crafter
        ? dungeon_key_targets(
            game_state.inventory,
            unavailable_item_ids(game_state),
            rt.ctx.dungeon_blacklist,
            Date.now(),
            party_key_stock(party_state)
          )
        : []
      const demand = crafter
        ? craft_gather_demand(crafter, game_state.inventory, unavailable_item_ids(game_state), [
            ...key_outputs,
            ...current_tool_goals(),
            ...current_gear_goals(),
          ])
        : undefined
      const gathered = await gather_once(ctx, mover, gather_job, local_only ? PARTY_GATHER_RADIUS : undefined, demand)
      if (gathered.kind === 'gathered') {
        rt.stats = record_gather(rt.stats, gathered.item_type, gathered.quantity)
        digest_stats = record_gather(digest_stats, gathered.item_type, gathered.quantity)
        acted = true
        if (gathered.protector) {
          // The resolver has extracted this character into a solo fight. Do not send a craft or
          // another chore using the now-stale kiosk custody from this same pass.
          rt.last_chore_ms = Date.now()
          return true
        }
      } else {
        // A skip used to be silent, which hid a dead gather pipeline for a whole night (the roster
        // showed zero harvests and nothing said why). One line per chore is cheap next to that.
        log_info('gather', `${character.name}: no harvest — ${gathered.reason}`)
      }
      // Advance the rotation so the all-resource gatherer sweeps FARMER → HERBALIST → MINER.
      if (chore.kind === 'gather_all' || chore.kind === 'gather_all_craft') rt.gather_cursor = (rt.gather_cursor + 1) % GATHERING_JOBS.length
    }
    const is_leader = character.id === party_state.leader_id
    const crafts = (chore.kind === 'craft' || chore.kind === 'gather_craft' || chore.kind === 'gather_all_craft') && toggles.craft

    // Leader (omori): the DUNGEON KEY comes FIRST. A key and an old tool can share the same
    // ingredient count — the same crafting XP — but only the key unlocks a farmable run, and the
    // rotation would otherwise spend the shared materials on the tool. When a key is affordable it
    // owns this pass's crafting; the rotation resumes whenever no key can be made. Rate-limited so a
    // key that keeps failing cannot starve the rotation.
    let key_crafted = false
    // ANY crafting member may mint the key (the leader's own trade is often not the key's job);
    // a party-wide spacing keeps two crafters from spending the same projected stack at once.
    if (crafts && party_state.members.includes(character.id)) {
      const KEY_CRAFT_COOLDOWN_MS = 60_000
      const PARTY_KEY_CRAFT_SPACING_MS = 20_000
      const now = Date.now()
      if (
        now - (rt.last_key_craft_attempt_ms ?? 0) >= KEY_CRAFT_COOLDOWN_MS &&
        now - last_party_key_craft_ms >= PARTY_KEY_CRAFT_SPACING_MS
      ) {
        rt.last_key_craft_attempt_ms = now
        last_party_key_craft_ms = now
        key_crafted = await craft_queue.run(async () => {
          prune_party_craft_burned()
          return maybe_craft_dungeon_key(ctx, party_craft_burned)
        })
        if (key_crafted) acted = true
      }
    }

    if (crafts && !key_crafted) {
      // The projection behind the craft only advances on the next server push, so a second batch
      // planned from the SAME snapshot reuses ingredient ids the chain has already consumed and aborts
      // `kiosk::borrow` (code 11) — one wasted transaction per chore. Feeding each batch's burned ids
      // forward makes the next batch pick a different recipe (or stop) instead.
      const burned = new Set<string>()
      // Dungeon-key materials win the pass: the run a key opens is the whole point of the farm, and
      // its chain is long (refinements -> plumes/trinkets -> key), so waiting for every input to
      // happen to be held (the leader-only `maybe_craft_dungeon_key`) meant nothing ever built the
      // chain. `select_craft_target` drills through the key's missing prerequisites, so the party
      // now mints the flour/powder/weave the keys eat before spending those materials on xp filler.
      // Gear goals follow, then the XP rotation.
      const leader = game_state.characters.find((c) => c.id === party_state.leader_id)
      const key_outputs = leader
        ? dungeon_key_targets(
            game_state.inventory,
            unavailable_item_ids(game_state),
            ctx.dungeon_blacklist,
            Date.now(),
            party_key_stock(party_state)
          )
        : []
      const craft_priorities = [...key_outputs, ...current_tool_goals(), ...current_gear_goals()]
      for (let batch = 0; batch < CRAFT_BATCHES_PER_CHORE; batch++) {
        const crafted = await craft_queue.run(async () => {
          prune_party_craft_burned()
          const shared_unavailable = new Set([...burned, ...party_craft_burned])
          const result = await drive_craft(ctx, shared_unavailable, craft_priorities)
          if (result.success) for (const id of result.input_item_ids) party_craft_burned.add(id)
          return result
        })
        if (!crafted.success) {
          break
        }
        for (const id of crafted.input_item_ids) burned.add(id)
        rt.stats = record_craft(rt.stats, crafted.output_type, crafted.successes)
        digest_stats = record_craft(digest_stats, crafted.output_type, crafted.successes)
        acted = true
      }
    }

    // Only a chore that genuinely did something pushes the forced window out; an empty beat keeps it
    // due, so a blocked pass retries instead of silently resetting the floor.
    if (acted) rt.last_chore_ms = Date.now()
    return acted
  }

  // ── run all characters in parallel ──────────────────────────────────
  const run_character = async (rt: CharRuntime): Promise<void> => {
    const { character } = rt
    log_info('session', `starting loop for ${character.name} (${character.id})`)

    try {
      while (!stopped) {
        if (!link_accepted) {
          await sleep(idle_sleep_ms)
          continue
        }

        try {
          const pass_started_ms = Date.now()
          rt.pass_started_ms = pass_started_ms
          const passed = await run_pass(rt)
          const pass_completed_ms = Date.now()
          rt.pass_started_ms = null
          rt.last_pass_completed_ms = pass_completed_ms
          rt.last_pass_error = null
          const pass_duration_ms = pass_completed_ms - pass_started_ms
          if (pass_duration_ms >= SLOW_PASS_WARN_MS)
            log_warn('health', `${character.name}: decision pass took ${Math.round(pass_duration_ms / 1_000)}s`)
          if (passed !== undefined) {
            await sleep(passed)
          }
        } catch (error) {
          rt.pass_started_ms = null
          rt.last_pass_completed_ms = Date.now()
          rt.last_pass_error = error instanceof Error ? error.message : String(error)
          if (is_travel_too_far_error(error)) {
            log_warn('session', `${character.name}: transaction rejected by prove_move (305; not submitted); refreshing the travel anchor`)
            try {
              await rt.mover.refresh_anchor(true)
            } catch (refresh_error) {
              log_warn(
                'session',
                `${character.name}: anchor refresh after prove_move 305 failed: ${refresh_error instanceof Error ? refresh_error.message : String(refresh_error)}`
              )
            }
            await sleep(idle_sleep_ms)
            continue
          }
          const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
          log_error('session', `${character.name} pass error: ${detail}`)
          await sleep(idle_sleep_ms)
        }
      }
    } catch (error) {
      log_error('session', `${character.name} loop error: ${error}`)
    }
  }

  /** The party-wide progress digest: every DIGEST_INTERVAL_MS, send ONE Discord message with the
   *  fights, xp, loot, gathering and crafting the whole party accumulated since the last digest,
   *  then start a fresh window. Seeded marks so the first digest measures from startup.
   *
   *  The wait is aligned to the wall clock (top of the hour for the default 60m), NOT measured from
   *  startup. A fixed `sleep(interval)` from boot meant every restart pushed the next ping a full
   *  interval away — the operator restarted the bot several times and never saw an hourly digest. */
  const digest_loop = async (rts: readonly CharRuntime[]): Promise<void> => {
    if (config.digest_minutes <= 0) return
    for (const rt of rts) {
      const c = game_state.characters.find((x) => x.id === rt.character.id)
      if (c) digest_marks.set(rt.character.id, xp_snapshot(c))
    }
    let last_fired_ms = 0
    while (!stopped) {
      // Sleep to the NEXT wall-clock boundary. This used to compute `into_window` and sleep the
      // remainder, which DOUBLE-FIRED whenever the timer woke a few ms early: `into_window` was then
      // still ~a full interval, so the loop slept the last few ms and sent a SECOND digest with empty
      // deltas (the marks had just been advanced). The operator saw two notifications every hour, one
      // of them empty. Anchoring to an absolute boundary and refusing to fire the same one twice makes
      // an early (or late) timer harmless.
      const boundary = (Math.floor(Date.now() / DIGEST_INTERVAL_MS) + 1) * DIGEST_INTERVAL_MS
      await sleep(Math.max(1, boundary - Date.now()))
      if (stopped) break
      if (boundary <= last_fired_ms) continue
      last_fired_ms = boundary
      let total_xp = 0n
      const jobs: Record<string, bigint> = {}
      for (const rt of rts) {
        const c = game_state.characters.find((x) => x.id === rt.character.id)
        if (!c) continue
        const now = xp_snapshot(c)
        const delta = xp_delta(digest_marks.get(rt.character.id) ?? now, now)
        total_xp += delta.xp
        for (const [job, gained] of Object.entries(delta.jobs)) jobs[job] = (jobs[job] ?? 0n) + gained
        digest_marks.set(rt.character.id, now)
      }
      const body = format_summary(digest_stats, total_xp, jobs)
      log_info('session', `digest: ${body.replace(/\n/g, ' | ')}`)
      notify(`📊 AresRPGAuto digest — last ${config.digest_minutes}m · ${party_label}\n${body}`, 'info')
      digest_stats = empty_stats
    }
  }

  /** A quiet operational heartbeat: confirms each loop is responsive, shows any active fight or
   *  stale-state gate, and names the last successful on-chain action. */
  const health_loop = async (rts: readonly CharRuntime[]): Promise<void> => {
    while (!stopped) {
      await sleep(HEALTH_HEARTBEAT_MS)
      if (stopped) break
      const now = Date.now()
      const fresh = freshness(game_state, now)
      const last_action = ledger.read().at(-1)
      const action_label = last_action
        ? `${last_action.kind} ${Math.max(0, Math.floor((now - last_action.at_ms) / 1_000))}s ago`
        : 'none yet'
      const characters = rts.map((rt) => {
        const current = game_state.characters.find((row) => row.id === rt.character.id)
        const pass = rt.pass_started_ms !== null
          ? `running ${Math.floor((now - rt.pass_started_ms) / 1_000)}s`
          : rt.last_pass_completed_ms !== null
            ? `responsive ${Math.floor((now - rt.last_pass_completed_ms) / 1_000)}s ago`
            : 'waiting for first pass'
        const fight = current ? active_fight_of(current) ?? 'none' : 'not in roster'
        const error = rt.last_pass_error ? ` error=${rt.last_pass_error.slice(0, 100)}` : ''
        return `${rt.character.name}[${pass},fight=${fight}${error}]`
      })
      const state_label = fresh.ok ? 'fresh' : `held:${fresh.reason}`
      log_info(
        'health',
        `link=${link_accepted ? 'online' : session.status().kind} state=${state_label} last_action=${action_label} | ${characters.join(' | ')}`
      )
    }
  }

  /** The periodic strategy brain. Every `BOT_STRATEGY_INTERVAL_MS` it re-derives, from the FULL seed
   *  content and each team, the farm distance and gear acquisition routes, logs the verdict, and
   *  publishes a team-local hint for roam (band) and engage (wanted mobs). The
   *  first pass is delayed so full-seed simulations cannot stall the first gameplay actions. */
  const strategy_loop = async (rts: readonly CharRuntime[]): Promise<void> => {
    if (!config.strategy) return
    // `compute_strategy` is synchronous and can occupy the main thread for several seconds. Let
    // characters connect, take their first action, and begin roaming before running the full scan.
    const startup_delay_ms =
      config.strategy_interval_ms > 0
        ? Math.min(config.strategy_interval_ms, STRATEGY_STARTUP_DELAY_MS)
        : 0
    await sleep(startup_delay_ms)
    while (!stopped) {
      let ran = false
      try {
        for (const state of party_states.values()) {
          const members = rts.filter((rt) => rt.ctx.party_state === state)
          const rows = members.flatMap((rt) => {
            const row = game_state.characters.find((c) => c.id === rt.character.id)
            return row ? [row] : []
          })
          if (rows.length === 0) continue
          const started_ms = Date.now()
          const plan = await compute_strategy_offload(rows, game_state, {
            party_level: Math.max(...rows.map((row) => row.level)),
            dungeon_blacklist: members[0]?.ctx.dungeon_blacklist,
            extra_outputs: current_tool_goals(),
          })
          strategy_ref.set(state, plan)
          log_info('strategy', `${state.members.length > 1 ? 'team' : 'solo'} [${rows.map((row) => row.name).join(', ')}]`)
          for (const line of describe_strategy(plan)) log_info('strategy', line)
          log_info('strategy', `pass complete in ${Date.now() - started_ms}ms`)
          ran = true
        }
      } catch (error) {
        // A failed pass keeps the previous plan; back off a full interval rather than hot-looping.
        ran = true
        log_error('strategy', `strategy pass failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (stopped || config.strategy_interval_ms <= 0) break
      // No roster yet (a startup race): retry soon instead of waiting a whole interval.
      await sleep(ran ? config.strategy_interval_ms : Math.min(config.strategy_interval_ms, 5_000))
    }
  }

  // Launch all character loops in parallel. The health heartbeat is console-only; Discord still gets
  // only the configured party digest and actionable authentication/crash notifications.
  await Promise.all([
    ...runtimes.map((rt) => run_character(rt)),
    digest_loop(runtimes),
    health_loop(runtimes),
    strategy_loop(runtimes),
  ])
}
