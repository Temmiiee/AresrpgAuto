// session – multi-character play loop.
//
// The bot drives up to 4 characters over ONE authenticated WebSocket connection. This is not an
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
import { config, type ChoreRole, type PlayToggles } from '../config.ts'
import { log_info, log_warn, log_error, sleep } from '../shared/logger.ts'
import { notify } from '../shared/discord_notify.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { create_ledger } from '../chain/ledger.ts'
import { create_mover, type Mover } from '../actions/travel.ts'
import { create_roamer, type Roamer } from '../actions/roam.ts'
import { gather_once } from '../actions/gather.ts'
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
  leader_group_step,
  party_attempting,
  rally_to_leader,
} from '../actions/party.ts'
import { create_fight_runtimes } from '../actions/fight_registry.ts'
import { create_group_claims, type ActionContext } from '../actions/context.ts'
import { active_fight_of, freshness, unavailable_item_ids } from '../state/selectors.ts'
import { initial_game_state, reduce, type GameState } from '../state/store.ts'
import { recipe_detail, recipes_by_output } from '../content/catalog.ts'
import { plan_recipe, craft_once } from '../actions/craft.ts'

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

/** How long to wait between passes while a fight is mid-resolution (a mob is acting). */
const FIGHT_POLL_MS = 1_000
/** How long to wait after a settlement batch before re-reading the resolutions feed. */
const SETTLE_POLL_MS = 2_000
/** How long to wait before retrying a settlement that did not complete. */
const SETTLE_RETRY_MS = 15_000
/** After an engage, how long to wait for the roster to reflect the new fight before re-screening. */
const ENGAGE_GRACE_MS = 45_000
/** The world used when neither the character nor config names one. */
const WORLD_FALLBACK = 'nauvis'
/** How many settled fights between console progress digests. */
const SUMMARY_EVERY_FIGHTS = 10
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
  stats: PlayStats
  xp_mark: XpMark | null
  chore_pending: boolean
  /** the non-combat chore this character owns (gather one job / rotate crafts / none) */
  chore: ChoreRole
  /** set right after an engage; engages are suppressed until the fight surfaces or the grace ends */
  awaiting_fight_ms: number | null
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
  const bot = create_bot_sdk(signer, {
    transaction_storage_path: journal_path,
  })
  const ledger = create_ledger(join(config.state_dir, 'activity.log'))
  const fight_runtimes = create_fight_runtimes()
  const claims = create_group_claims()
  /** The shared group-fight rendezvous, filled in once the roster is known. */
  const party_state = create_party()

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
    if (status.kind === 'replaced') {
      if (stopped) return
      stopped = true
      log_error('session', `replaced by another login: ${status.reason}`)
      notify(`session replaced by another login (${status.reason}) — stopping`, 'error')
      return
    }
    if (status.kind === 'rejected') {
      if (stopped) return
      stopped = true
      log_error('session', `auth rejected: ${status.reason}`)
      notify(`auth rejected (${status.reason}) — stopping`, 'error')
    }
  }

  // The link is long-lived: a transient drop keeps this session object and reconnects in place, so
  // the same handler fires again on recovery. A hard stop is only the terminal statuses above.

  // ── discover characters from the roster ────────────────────────────
  let roster_ready = false
  for (let i = 0; i < 30; i++) {
    if (game_state.characters.length > 0) {
      roster_ready = true
      break
    }
    await sleep(1000)
  }
  if (!roster_ready) {
    log_error('session', 'no characters found in roster after 30s')
    session.dispose()
    return
  }

  // Select up to config.party_size characters. The configured party order is preferred; every other
  // owned character follows, so a renamed/missing character still yields a full, stable party.
  const knownNameOrder = ['omori', 'memorien', 'llokan', 'archero', 'archerro']
  const rank_of = (name: string): number => {
    const index = knownNameOrder.indexOf(name.toLowerCase())
    return index < 0 ? knownNameOrder.length : index
  }
  const ordered = game_state.characters
    .slice()
    .sort((a, b) => rank_of(a.name) - rank_of(b.name) || a.name.localeCompare(b.name))
  const party = ordered.slice(0, config.party_size)
  const leader = party.find((c) => c.name.toLowerCase() === config.leader_name.toLowerCase()) ?? party[0]
  if (!leader) {
    log_error('session', 'no characters available to drive')
    session.dispose()
    return
  }
  if (leader.name.toLowerCase() !== config.leader_name.toLowerCase())
    log_warn('session', `configured leader "${config.leader_name}" not in the party — ${leader.name} leads instead`)

  // Compute effective level: the party's maximum character level
  const effectiveLevel = party.length > 0 ? Math.max(...party.map((c) => c.level)) : 0

  // The group-fight rendezvous every character in the party shares.
  party_state.leader_id = leader.id
  party_state.members = Object.freeze(party.map((c) => c.id))

  party_label = `lvl ${effectiveLevel} · ${party.map((c) => c.name).join(', ')}`
  log_info(
    'session',
    `party: leader=${leader.name} members=${party.length} group=${toggles.group} — effective_lvl=${effectiveLevel}`
  )

  // ── create per-character runtimes (all on the shared socket) ────────
  const runtimes: CharRuntime[] = []

  for (const character of party) {
    const world = character.world ?? config.world ?? WORLD_FALLBACK

    const ctx: ActionContext = {
      sdk: bot,
      address,
      character_id: character.id,
      world,
      state: () => game_state,
      send: (packet) => session.send(packet),
      ledger,
      notify,
      fight_runtimes,
      claims,
    }

    const mover = create_mover(ctx)
    const roamer = create_roamer(ctx)

    // The chore plan is keyed by character name: omori rotates every crafting job while each other
    // character owns ONE gathering job, so the party covers every gathering leaf and craft trade.
    const chore: ChoreRole = config.chore_plan[character.name.toLowerCase()] ?? Object.freeze({ kind: 'none' })
    if (chore.kind === 'none')
      log_warn('session', `${character.name}: no chore assignment — this character will only fight`)

    runtimes.push({
      character,
      ctx,
      mover,
      roamer,
      stats: empty_stats,
      xp_mark: xp_snapshot(character),
      chore_pending: false,
      chore,
      awaiting_fight_ms: null,
    })
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
          const plan = plan_recipe(character, detail, game_state.inventory, unavailable_item_ids(game_state))
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
            crafted += result.successes
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
    return
  }

  // ── per-character decision pass ─────────────────────────────────────
  const run_pass = async (rt: CharRuntime): Promise<number> => {
    const { ctx, mover, roamer, character } = rt

    // Re-read the character from the latest state
    const current = game_state.characters.find((c) => c.id === character.id)
    if (!current) return idle_sleep_ms

    mover.sync(current)

    // 1. reconcile any ended fight (settle loot, then close the fight object)
    const settled = await settle_pending(ctx)
    if (settled.settled) {
      log_info('session', `${character.name}: ${settled.detail}`)
      rt.stats = settled.reports.reduce(record_fight, rt.stats)
      rt.chore_pending = true
      flush_summary(rt)
      return SETTLE_POLL_MS
    }
    if (settled.pending) {
      log_warn('session', `${character.name}: settlement incomplete: ${settled.detail}`)
      return SETTLE_RETRY_MS
    }
    await close_pending(ctx)

    // 2. drive whatever our active fight needs right now. The per-fight lock serializes allied
    // seats: in a group fight the leader and its partners place/ready/turn on the same object, so
    // only one of them may submit at a time.
    const active_fight = active_fight_of(current)
    if (active_fight) {
      rt.awaiting_fight_ms = null
      const outcome = await fight_runtimes.with_lock(active_fight, () => drive_fight(ctx))
      if (outcome.kind !== 'waiting_turn' && outcome.kind !== 'not_our_turn')
        log_info('session', `${character.name}: fight ${outcome.kind}${outcome.detail ? ` (${outcome.detail})` : ''}`)
      return FIGHT_POLL_MS
    }

    // 2b. an engage was just submitted but the roster has not caught up yet: do not re-engage into
    // the indexing window (that is the double-engage that aborts on chain).
    if (rt.awaiting_fight_ms !== null) {
      if (Date.now() - rt.awaiting_fight_ms < ENGAGE_GRACE_MS) return idle_sleep_ms
      rt.awaiting_fight_ms = null
    }

    // 3. a spendy field action needs a fresh projection + live chain clock
    const fresh = freshness(game_state, Date.now())
    if (!fresh.ok) {
      log_warn('session', `${character.name}: holding — ${fresh.reason}`)
      return idle_sleep_ms
    }

    // 3b. group fight: while the party wants to fight as ONE side, a follower must not wander off to
    // a chore — that strands the rendezvous and forces a fresh multi-minute convergence. So the group
    // step runs FIRST for followers; the leader instead CRAFTS first (below) so omori's crafting jobs
    // still level while the party chains fights. A settled fight re-forms the party before harvesting.
    const group_mode = toggles.group && party_attempting(party_state)
    const is_leader = character.id === party_state.leader_id
    if (group_mode && is_leader && rt.chore_pending) {
      rt.chore_pending = false
      if (await run_chore(rt, false)) return idle_sleep_ms
    }
    if (group_mode) {
      const handled = is_leader
        ? await leader_group_step(ctx, mover, current, party_state)
        : await follower_group_step(ctx, mover, current, party_state)
      if (handled !== null) return handled
    }

    // 3c. chores — a settled fight is the natural beat to harvest one node and craft one batch
    if (rt.chore_pending) {
      rt.chore_pending = false
      if (await run_chore(rt, group_mode)) return idle_sleep_ms
    }

    // 4. fight: never burn gas on trivial prey
    if (toggles.fight) {
      // While the party is grouping, a follower does NOT roam to its own band — it rallies to the
      // leader and holds, so the next rendezvous is a short hop instead of a fresh convergence.
      if (group_mode && character.id !== party_state.leader_id) {
        const leader = game_state.characters.find((c) => c.id === party_state.leader_id)
        if (leader) {
          await rally_to_leader(mover, leader)
          return idle_sleep_ms
        }
      }

      if (toggles.roam) {
        const roamed = await roamer.roam_once(mover, effectiveLevel)
        if (roamed.kind === 'roamed') log_info('session', `${character.name}: roamed — ${roamed.detail}`)
        if (
          roamed.kind === 'roamed' ||
          roamed.kind === 'joined' ||
          roamed.kind === 'traveling' ||
          roamed.kind === 'waiting'
        )
          return idle_sleep_ms
      }

      // While grouping, the leader owns every engage — a solo fight would only block the rendezvous.
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
    if (await run_chore(rt, group_mode)) return idle_sleep_ms

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
    const { ctx, mover, chore } = rt
    let acted = false
    if (chore.kind === 'gather' && toggles.gather) {
      const gathered = await gather_once(ctx, mover, chore.job, local_only ? PARTY_GATHER_RADIUS : undefined)
      if (gathered.kind === 'gathered') {
        rt.stats = record_gather(rt.stats, gathered.item_type, gathered.quantity)
        acted = true
      }
    }
    if (chore.kind === 'craft' && toggles.craft) {
      const crafted = await drive_craft(ctx)
      if (crafted.success) {
        rt.stats = record_craft(rt.stats, crafted.output_type, crafted.successes)
        acted = true
      }
    }
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
          const passed = await run_pass(rt)
          if (passed !== undefined) {
            await sleep(passed)
          }
        } catch (error) {
          const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
          log_error('session', `${character.name} pass error: ${detail}`)
          await sleep(idle_sleep_ms)
        }
      }
    } catch (error) {
      log_error('session', `${character.name} loop error: ${error}`)
    }
  }

  // Launch all character loops in parallel. The shared socket requires no heartbeat task: the
  // server pushes liveness packets continuously, so there is no periodic Discord ping any more.
  await Promise.all(runtimes.map((rt) => run_character(rt)))
}
