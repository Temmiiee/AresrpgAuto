// bun run src/cli_control_panel.ts — a password-protected web app for running the bot remotely
// (2026-09-05, project owner: "start the bot on my phone and monitor it without my computer
// open"). Extends cli_dashboard.ts's read-only view (same local-file data, same visual style)
// with three things that need a live wallet connection: starting/stopping the session loop as a
// supervised child process, live per-character stats (level/xp/stat points) straight from chain,
// and a review-then-confirm sell flow reusing auto_sell.ts's existing plan/execute split (selling
// is deliberately never one-click — see auto_sell.ts's own comment on why).
//
// Meant to run unattended on a small always-on server (see README "Remote control panel") with
// your phone as a thin client — nothing about this assumes it's running on your own machine.
// CONTROL_PANEL_PASSWORD must be set or this refuses to start: this process holds your zkLogin
// session and can sign real transactions, so it must never be reachable without a password.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import { plan_auto_sell, execute_auto_sell, type SellDecision } from '../market/auto_sell.ts'
import { read_inventory_value } from '../market/inventory_value.ts'
import { read_log } from '../state/session_log.ts'
import { compute_stats, mist_to_sui, GAS_WARN_MIST } from '../state/session_stats.ts'
import { read_status } from '../state/status_state.ts'
import { read_position } from '../state/position_state.ts'
import { read_group_state } from '../state/group_state.ts'
import { build_live_fight_snapshot } from '../fight/live_fight_snapshot.ts'
import { normalize_fight_json } from '../fight/fight_session.ts'
import { CHARACTERS } from '../config/party_config.ts'
import type { SimPartyMember } from '../ai/simulate.ts'
import { LOGIN_PAGE, APP_PAGE } from './control_panel_pages.ts'

const PORT = Number(process.env.CONTROL_PANEL_PORT ?? 5181)
const STALE_AFTER_MS = 60_000
const PASSWORD = process.env.CONTROL_PANEL_PASSWORD
if (!PASSWORD) {
  console.error(
    'CONTROL_PANEL_PASSWORD is not set. This server holds a live wallet session and can sign real\n' +
      'transactions — refusing to start without a password. Set it and try again, e.g.:\n' +
      '  CONTROL_PANEL_PASSWORD="something long and random" bun run control-panel'
  )
  process.exit(1)
}

// ---------- auth: signed session cookie, no dependencies, no server-side session store ----------
const SECRET = createHash('sha256').update(PASSWORD).digest()
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60
const COOKIE_NAME = 'arb_session'
const COOKIE_SECURE = process.env.CONTROL_PANEL_INSECURE_COOKIE !== '1' // opt out for local http testing only

const sign = (payload: string): string => createHmac('sha256', SECRET).update(payload).digest('base64url')
const make_session_cookie = (): string => {
  const expiry = String(Date.now() + SESSION_MAX_AGE_S * 1000)
  const token = `${expiry}.${sign(expiry)}`
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}; Path=/${COOKIE_SECURE ? '; Secure' : ''}`
}
const CLEAR_COOKIE = `${COOKIE_NAME}=; HttpOnly; Max-Age=0; Path=/`
const verify_session_token = (token: string | undefined): boolean => {
  if (!token) return false
  const [expiry, sig] = token.split('.')
  if (!expiry || !sig || Date.now() > Number(expiry)) return false
  const expected = Buffer.from(sign(expiry))
  const actual = Buffer.from(sig)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
const parse_cookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}
const is_authed = (request: Request): boolean => verify_session_token(parse_cookies(request.headers.get('cookie'))[COOKIE_NAME])

// A single shared (not per-IP) growing delay on failed logins -- simple brute-force deterrent
// appropriate for a single-user personal tool; a real multi-user service would need per-IP limits.
let consecutive_failures = 0
const check_password = async (input: string): Promise<boolean> => {
  if (consecutive_failures > 0) await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** consecutive_failures)))
  const a = createHash('sha256').update(input).digest()
  const b = createHash('sha256').update(PASSWORD).digest()
  const ok = a.length === b.length && timingSafeEqual(a, b)
  consecutive_failures = ok ? 0 : consecutive_failures + 1
  return ok
}

// ---------- wallet connection (shared across every request) ----------
console.log('Signing in (reuses the cached session in .enoki-session.json if present)…')
const signer = await get_enoki_signer()
const bot = create_bot_sdk(signer)
console.log(`Control panel bot address: ${bot.address}`)

// ---------- supervised session child process ----------
const BOT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LOG_MAX_LINES = 400
const log_lines: string[] = []
const push_log = (text: string) => {
  for (const line of text.split('\n')) if (line.trim() !== '') log_lines.push(line)
  if (log_lines.length > LOG_MAX_LINES) log_lines.splice(0, log_lines.length - LOG_MAX_LINES)
}
const pipe_to_log = async (stream: ReadableStream<Uint8Array> | null) => {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    push_log(decoder.decode(value))
  }
}

let session_child: ReturnType<typeof Bun.spawn> | null = null
const is_session_running = (): boolean => session_child !== null && session_child.exitCode === null
const start_session = (): boolean => {
  if (is_session_running()) return false
  session_child = Bun.spawn(['bun', 'run', 'src/cli_group_session.ts'], { cwd: BOT_ROOT, stdout: 'pipe', stderr: 'pipe' })
  pipe_to_log(session_child.stdout as ReadableStream<Uint8Array>)
  pipe_to_log(session_child.stderr as ReadableStream<Uint8Array>)
  push_log(`[control panel] started session loop (pid ${session_child.pid})`)
  return true
}
const stop_session = (): boolean => {
  if (!is_session_running()) return false
  session_child!.kill('SIGINT') // matches cli_group_session.ts's own documented "Ctrl+C to stop"
  push_log('[control panel] sent stop signal — current fight (if any) will finish first')
  return true
}

// ---------- sell decisions: bigint doesn't survive JSON, stringify it ----------
const serialize_decision = (d: SellDecision) => ({ ...d, price_mist: d.price_mist.toString() })

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init)
const unauthorized = () => new Response('unauthorized', { status: 401 })

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/login' && request.method === 'POST') {
      const { password } = (await request.json().catch(() => ({}))) as { password?: string }
      if (!password || !(await check_password(password))) return json({ ok: false }, { status: 401 })
      return json({ ok: true }, { headers: { 'set-cookie': make_session_cookie() } })
    }
    if (url.pathname === '/logout' && request.method === 'POST') return json({ ok: true }, { headers: { 'set-cookie': CLEAR_COOKIE } })

    if (url.pathname === '/') return new Response(is_authed(request) ? APP_PAGE : LOGIN_PAGE, { headers: { 'content-type': 'text/html' } })

    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 })
    if (!is_authed(request)) return unauthorized()

    if (url.pathname === '/api/data') {
      const entries = read_log()
      const stats = compute_stats(entries)
      const status = read_status()
      const position = read_position()
      return json({
        address: bot.address,
        position,
        characters: CHARACTERS.map((c) => ({ name: c.name, classe: c.classe })),
        session_running: is_session_running(),
        status: status && { ...status, running: Date.now() - new Date(status.updated_at).getTime() < STALE_AFTER_MS },
        stats: {
          total: stats.fights.length,
          wins: stats.wins.length,
          losses: stats.losses.length,
          win_rate: stats.win_rate,
          total_sui: mist_to_sui(stats.total_gas_mist),
          xp_totals: stats.xp_totals,
          drops_totals: stats.drops_totals,
          total_drops_value_sui: stats.total_drops_value_sui,
          net_profit_sui: stats.net_profit_sui,
          is_net_profitable: stats.is_net_profitable,
          expensive_count: stats.expensive.length,
          gas_warn_sui: mist_to_sui(GAS_WARN_MIST),
        },
        recent: [...entries].reverse().slice(0, 30).map((e) => ({ ...e, gas_sui: mist_to_sui(BigInt(e.gas_mist)) })),
      })
    }

    if (url.pathname === '/api/logs') return json({ lines: log_lines })

    if (url.pathname === '/api/session/start' && request.method === 'POST') return json({ started: start_session() })
    if (url.pathname === '/api/session/stop' && request.method === 'POST') return json({ stopped: stop_session() })

    // Live chain reads -- kept on their own slower-polled endpoint, not /api/data, since each
    // character costs a real RPC call (see live_character.ts) and the client polls /api/data
    // every few seconds; characters don't change that often.
    if (url.pathname === '/api/characters') {
      try {
        const characters = await Promise.all(
          CHARACTERS.map(async (c) => ({ name: c.name, classe: c.classe, ...(await read_live_character_stats(bot.sdk, c.id)) }))
        )
        return json({ characters })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
      }
    }

    if (url.pathname === '/api/current-fight') {
      const { fight_id } = read_group_state()
      if (!fight_id) return json({ active: false })
      try {
        const { objects } = await bot.sdk.sui_client.core.getObjects({ objectIds: [fight_id], include: { json: true } })
        const raw_json = objects[0]?.json
        if (!raw_json) return json({ active: false }) // fight concluded and was cleaned up
        // Fight.move's rewrite nested fighters/board/etc under `combat` and moved character
        // ownership into a parallel `authorities` array -- normalize_fight_json (fight_session.ts)
        // is the one place that already knows how to flatten this back to the shape
        // live_state_to_checkpoint expects.
        const raw = normalize_fight_json(raw_json as never)
        const sim_party_stats = new Map<string, SimPartyMember>(
          await Promise.all(
            CHARACTERS.map(async (c): Promise<[string, SimPartyMember]> => {
              const live = await read_live_character_stats(bot.sdk, c.id)
              return [c.id, { name: c.name, classe: c.classe, ...live }]
            })
          )
        )
        return json({ active: true, ...build_live_fight_snapshot(raw, sim_party_stats) })
      } catch (error) {
        return json({ active: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (url.pathname === '/api/inventory') {
      try {
        return json(await read_inventory_value(bot))
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
      }
    }

    if (url.pathname === '/api/sell/plan' && request.method === 'GET') {
      try {
        const decisions = await plan_auto_sell(bot)
        return json({ decisions: decisions.map(serialize_decision) })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
      }
    }
    if (url.pathname === '/api/sell/confirm' && request.method === 'POST') {
      try {
        // Prices are always recomputed fresh rather than trusting a client-supplied plan --
        // avoids the bigint/JSON round-trip entirely and matches cli_auto_sell.ts's own "plan
        // right before executing" shape closely enough for a personal single-user tool. WHICH
        // items to list is a legitimate client choice though (project owner, 2026-09-06: "j'aimerais
        // choisir ce que je vends") -- an item_ids list narrows the fresh plan down to just those;
        // omitting it (or an empty array) lists everything sellable, same as before.
        const { item_ids } = (await request.json().catch(() => ({}))) as { item_ids?: string[] }
        const decisions = await plan_auto_sell(bot)
        const selected =
          item_ids && item_ids.length > 0 ? decisions.filter((d) => item_ids.includes(d.item_id)) : decisions
        if (selected.length === 0) return json({ results: [] })
        const results = await execute_auto_sell(bot, selected)
        return json({ results: results.map((r) => ({ decision: serialize_decision(r.decision), digest: r.digest })) })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
      }
    }

    return new Response('not found', { status: 404 })
  },
})

console.log(`Control panel running on port ${PORT}`)
