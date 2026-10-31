// The one dependency bundle every action receives. Actions are effectful edges (they compose and
// submit transactions), so they take their collaborators explicitly instead of reaching for
// module globals — the play loop wires the real ones in one place.
import type { ClientPacket } from '@aresrpg/protocol'

import type { BotSdk } from '../auth/sdk_client.ts'
import type { Ledger } from '../chain/ledger.ts'
import type { GameState } from '../state/store.ts'
import type { NotifyLevel } from '../shared/discord_notify.ts'
import type { FightRuntimeStore } from './fight_registry.ts'
import type { PartyState } from './party.ts'

/**
 * A cross-character claim registry. Every character in the party shares ONE server connection and
 * therefore one live mob-group window, so two runtimes can pick the same group in the same pass.
 * An engage consumes the group's on-chain bit, so the loser's transaction aborts. Claiming a group
 * before walking to it keeps exactly one character per live group. Claims carry a TTL and an owner,
 * so a cancelled walk never strands a group and a character never blocks itself.
 */
export type GroupClaims = Readonly<{
  /** true when `key` was free or already held by `owner` (refreshing its TTL) */
  claim: (key: string, owner: string, ttl_ms?: number) => boolean
  /** drop a claim the owner is abandoning (a failed engage, a refused leg) */
  release: (key: string, owner: string) => void
}>

const DEFAULT_CLAIM_TTL_MS = 120_000

export const create_group_claims = (): GroupClaims => {
  const held = new Map<string, Readonly<{ owner: string; expires_ms: number }>>()
  const sweep = (now_ms: number): void => {
    for (const [key, claim] of held) if (claim.expires_ms <= now_ms) held.delete(key)
  }
  return Object.freeze({
    claim: (key, owner, ttl_ms = DEFAULT_CLAIM_TTL_MS) => {
      const now = Date.now()
      sweep(now)
      const existing = held.get(key)
      if (existing && existing.owner !== owner) return false
      held.set(key, Object.freeze({ owner, expires_ms: now + ttl_ms }))
      return true
    },
    release: (key, owner) => {
      const existing = held.get(key)
      if (existing?.owner === owner) held.delete(key)
    },
  })
}

/** FIFO queue for operations that mutate the party's shared kiosk inventory. */
export type SerialQueue = Readonly<{ run: <T>(task: () => Promise<T>) => Promise<T> }>

export const create_serial_queue = (): SerialQueue => {
  let tail: Promise<void> = Promise.resolve()
  return Object.freeze({
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      let release!: () => void
      const turn = new Promise<void>((resolve) => { release = resolve })
      const previous = tail
      tail = previous.then(() => turn)
      await previous
      try {
        return await task()
      } finally {
        release()
      }
    },
  })
}

export type StrategyHint = Readonly<{
  wanted_mobs: ReadonlySet<string>
  loot_focus?: Readonly<{
    item_type: string
    mob_type: string
    have: number
    need: number
    distance: number
  }> | null
}>

export type ActionContext = Readonly<{
  /** the shared SDK wired to this bot's signer + network */
  sdk: BotSdk
  /** the signer's address (fight seat ownership is checked against it) */
  address: string
  /** the character this bot drives (resolved once at startup) */
  character_id: string
  /** the world this bot farms */
  world: string
  /** the latest folded live projection */
  state: () => GameState
  /** the authenticated intent channel; false when the link is not accepted */
  send: (packet: Readonly<ClientPacket>) => boolean
  /** durable activity ledger */
  ledger: Ledger
  /** Discord (or console fallback) reporting */
  notify: (content: string, level?: NotifyLevel) => void
  /** the shared fight runtime registry, replaced from the fight_state stream */
  fight_runtimes: FightRuntimeStore
  /** the cross-character live-group claims, so the party never double-engages one group */
  claims: GroupClaims
  /** shared party state for dungeon/group coordination */
  party_state: PartyState
  /** session-scoped parked dungeon keys: key -> retry-after epoch ms. Shared by the dungeon runner
   *  (which parks a key whose first room previews as unwinnable) and the key crafter (which skips a
   *  parked key), so the two never disagree about which keys are worth committing to. */
  dungeon_blacklist: Map<string, number>
  /** the current periodic strategy brain's engage hint, or undefined before the first pass */
  strategy?: () => StrategyHint | null
}>

/** The wire custody pair for a character: the kiosk holding it plus its personal cap identity. */
export const custody_of = (character: Readonly<{ kiosk: string; kiosk_cap?: string }>) =>
  Object.freeze({ kiosk: character.kiosk, kiosk_cap: character.kiosk_cap })
