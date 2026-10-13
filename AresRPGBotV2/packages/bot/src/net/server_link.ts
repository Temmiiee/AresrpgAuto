// Authenticated live-state websocket to the AresRPG realtime server.
//
// The frontend's server_link.ts (browser) is the reference for the handshake:
//   1. connect to `${server_ws_url}?address=<0x…>` with the game's Origin header
//   2. the server answers with a fresh `packet/signature_request` challenge
//   3. sign UTF-8 `aresrpg::<challenge>` — a genuine chain personal message — and answer
//      `packet/signature_response`; the server verifies the recovered address owns the claim
//   4. `packet/connection_accepted` opens the door: app packets flow only from then on
//
// This is a long-lived daemon link. It survives transient drops with exponential backoff
// (1s → 30s), retries a rule-violation drop (SPEED/RATE_LIMIT) only on a slow 60s cadence
// because the server's cool-off ban holds the door shut anyway, and treats signature
// rejections and same-account takeovers as terminal — retrying either can only steal a
// seat back or hammer a ban.
import { parse_server_packet, type ClientPacket, type ServerPacket } from '@aresrpg/protocol'
import type { Signer } from '@mysten/sui/cryptography'

import { config } from '../config.ts'
import { log_info, log_warn } from '../shared/logger.ts'

const BACKOFF_START_MS = 1_000
const BACKOFF_CAP_MS = 30_000
/** retry pace while the server's violation cool-off holds the door shut */
const VIOLATION_RETRY_MS = 60_000
const LATENCY_INTERVAL_MS = 5_000
const SESSION_TERMINAL_REASONS = new Set(['INVALID_SIGNATURE', 'INVALID_PACKET'])
const TAKEOVER_REASONS = new Set(['ALREADY_CONNECTED', 'REPLACED'])
/** continuous/noise traffic — never logged */
const SILENT_PACKETS: ReadonlySet<string> = new Set([
  'packet/position',
  'packet/players_moved',
  'packet/ping',
  'packet/pong',
  'packet/signature_response',
])

export type ServerLinkStatus =
  | Readonly<{ kind: 'connecting' }>
  | Readonly<{ kind: 'awaiting_signature' }>
  | Readonly<{ kind: 'authenticating' }>
  | Readonly<{ kind: 'accepted'; address: string }>
  | Readonly<{ kind: 'latency'; latency_ms: number }>
  /** auth refused — the signer does not own this address; reconnecting cannot fix it */
  | Readonly<{ kind: 'rejected'; reason: string }>
  /** the same account seated elsewhere — terminal for this socket, never fight back */
  | Readonly<{ kind: 'replaced'; reason: string }>
  /** dropped for a rule violation; a slow retry is scheduled (server cool-off) */
  | Readonly<{ kind: 'violation'; reason: string }>
  /** transient failure; an exponential-backoff retry is scheduled */
  | Readonly<{ kind: 'failed'; error: string }>
  | Readonly<{ kind: 'disposed' }>

export type ServerLinkOptions = Readonly<{
  /** the claimed zkLogin address (the socket signs proof of ownership of it) */
  address: string
  /** proves ownership of the address on this exact socket */
  signer: Signer
  /** every parsed server packet, in arrival order (the store's reducer input) */
  on_packet: (packet: ServerPacket) => void
  /** transport lifecycle facts — the daemon loop and the status CLI both watch this */
  on_status: (status: ServerLinkStatus) => void
}>

export type ServerLink = Readonly<{
  /** eager app packets are refused (return false) until connection_accepted — true once sent */
  send: (packet: Readonly<ClientPacket>) => boolean
  /** the latest transport status — for the status/doctor CLIs to inspect on demand */
  status: () => ServerLinkStatus
  dispose: () => void
}>

export const create_server_link = ({ address, signer, on_packet, on_status }: ServerLinkOptions): ServerLink => {
  let socket: WebSocket | null = null
  let accepted = false
  let disposed = false
  let retry_ms = BACKOFF_START_MS
  let retry_timer: ReturnType<typeof setTimeout> | null = null
  let latency_timer: ReturnType<typeof setInterval> | null = null
  let next_probe_id = 1
  let pending_probe: Readonly<{ id: number; started_ms: number }> | null = null
  let current: ServerLinkStatus = Object.freeze({ kind: 'connecting' })

  const report = (next: ServerLinkStatus): void => {
    current = next
    on_status(next)
  }

  const connection_url = (): string => {
    const url = new URL(config.server_ws_url)
    url.searchParams.set('address', address)
    return url.href
  }

  const send = (target: WebSocket, packet: Readonly<ClientPacket>): void => {
    if (!SILENT_PACKETS.has(packet.type)) log_info('ws', `→ ${packet.type}`)
    target.send(JSON.stringify(packet))
  }

  const stop_latency = (): void => {
    if (latency_timer) clearInterval(latency_timer)
    latency_timer = null
    pending_probe = null
  }

  const probe_latency = (): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const id = next_probe_id
    next_probe_id += 1
    pending_probe = Object.freeze({ id, started_ms: Date.now() })
    send(socket, { type: 'packet/ping', id })
  }

  const start_latency = (): void => {
    stop_latency()
    probe_latency()
    latency_timer = setInterval(probe_latency, LATENCY_INTERVAL_MS)
  }

  const schedule = (delay: number): void => {
    stop_latency()
    retry_timer = setTimeout(() => void open(), delay)
  }

  const schedule_retry = (message: string): void => {
    report(Object.freeze({ kind: 'failed', error: message }))
    const delay = retry_ms
    retry_ms = Math.min(retry_ms * 2, BACKOFF_CAP_MS)
    schedule(delay)
  }

  const sign_and_answer = async (challenge: string): Promise<void> => {
    const target = socket
    if (!target || target.readyState !== WebSocket.OPEN) return
    report(Object.freeze({ kind: 'authenticating' }))
    try {
      const proof = await signer.signPersonalMessage(new TextEncoder().encode(`aresrpg::${challenge}`))
      if (disposed || socket !== target || target.readyState !== WebSocket.OPEN) return
      send(target, Object.freeze({ type: 'packet/signature_response', ...proof }))
    } catch (error) {
      if (disposed || socket !== target) return
      // A local signing hiccup is transport failure — the remembered wallet is fine, retry.
      schedule_retry(`local signing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handle_packet = (target: WebSocket, packet: ServerPacket): void => {
    if (packet.type === 'packet/pong') {
      if (pending_probe?.id !== packet.id) return
      const latency_ms = Math.max(0, Date.now() - pending_probe.started_ms)
      pending_probe = null
      report(Object.freeze({ kind: 'latency', latency_ms }))
      return
    }
    if (packet.type === 'packet/signature_request') {
      void sign_and_answer(packet.payload)
      return
    }
    if (packet.type === 'packet/connection_accepted') {
      accepted = true
      retry_ms = BACKOFF_START_MS
      report(Object.freeze({ kind: 'accepted', address: packet.address }))
      start_latency()
    }
    if (!SILENT_PACKETS.has(packet.type)) log_info('ws', `← ${packet.type}`)
    on_packet(packet)
  }

  const open = async (): Promise<void> => {
    report(Object.freeze({ kind: 'connecting' }))
    try {
      const url = connection_url()
      if (disposed) return
      const next = new WebSocket(url, { headers: { Origin: config.origin } })
      socket = next
      accepted = false
      next.addEventListener('message', ({ data }) => {
        if (disposed || socket !== next) return
        let packet: ServerPacket
        try {
          packet = parse_server_packet(String(data))
        } catch (error) {
          log_warn('ws', `malformed server frame ignored: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        handle_packet(next, packet)
      })
      next.addEventListener('close', ({ code, reason }) => {
        if (disposed || socket !== next) return
        socket = null
        accepted = false
        if (code === 1008 && SESSION_TERMINAL_REASONS.has(reason)) {
          report(Object.freeze({ kind: 'rejected', reason }))
          return
        }
        if (TAKEOVER_REASONS.has(reason) && (code === 1000 || code === 1008)) {
          report(Object.freeze({ kind: 'replaced', reason }))
          return
        }
        if (code === 1008 && (reason === 'SPEED' || reason === 'RATE_LIMIT')) {
          report(Object.freeze({ kind: 'violation', reason }))
          schedule(VIOLATION_RETRY_MS)
          return
        }
        schedule_retry(reason || `connection closed (${code})`)
      })
    } catch (error) {
      if (disposed) return
      schedule_retry(error instanceof Error ? error.message : String(error))
    }
  }

  void open()

  return Object.freeze({
    send: (packet: Readonly<ClientPacket>): boolean => {
      if (!socket || !accepted || socket.readyState !== WebSocket.OPEN) return false
      send(socket, packet)
      return true
    },
    status: (): ServerLinkStatus => current,
    dispose: (): void => {
      disposed = true
      stop_latency()
      if (retry_timer) clearTimeout(retry_timer)
      retry_timer = null
      socket?.close(1000, 'CLIENT_CLOSED')
      socket = null
      accepted = false
      report(Object.freeze({ kind: 'disposed' }))
    },
  })
}