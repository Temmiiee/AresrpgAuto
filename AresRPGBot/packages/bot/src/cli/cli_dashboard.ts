// bun run src/cli_dashboard.ts — a tiny local web dashboard for the bot session. Reads only
// local files (session.jsonl, status.local.json) — no chain calls, so it's safe/free to leave
// open and polling while `bun run session` runs in another terminal, and it works even if no
// session has ever run (shows an empty state).
import { read_log } from '../state/session_log.ts'
import { compute_stats, mist_to_sui, GAS_WARN_MIST } from '../state/session_stats.ts'
import { read_status } from '../state/status_state.ts'
import { read_position } from '../state/position_state.ts'
import { CHARACTERS } from '../config/party_config.ts'

const PORT = 5180
const STALE_AFTER_MS = 60_000 // no status update in this long -> treat the session as stopped

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AresRPG Bot</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d12;
    --panel: #12151d;
    --panel-2: #171b26;
    --border: #232838;
    --text: #e7eaf3;
    --muted: #8b93a7;
    --accent: #7c9fff;
    --win: #35d08a;
    --loss: #ff6b6b;
    --warn: #ffb547;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, "Segoe UI", Inter, sans-serif;
    padding: 24px;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  header {
    display: flex; align-items: flex-start; justify-content: space-between;
    margin-bottom: 20px; flex-wrap: wrap; gap: 12px;
  }
  .status-pill {
    display: flex; align-items: center; gap: 8px;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 999px; padding: 7px 14px; font-size: 12.5px; color: var(--muted);
    max-width: 480px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.running { background: var(--win); box-shadow: 0 0 0 3px rgba(53,208,138,.18); animation: pulse 1.6s infinite; }
  .dot.stopped { background: #4a5165; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
  .status-msg { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 21px; font-weight: 650; margin-top: 4px; }
  .card .value.win { color: var(--win); }
  .card .value.loss { color: var(--loss); }

  .party { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
  .chip {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 12px; font-size: 12.5px; display: flex; gap: 6px; align-items: baseline;
  }
  .chip b { color: var(--text); }
  .chip span { color: var(--muted); }

  .warn-box {
    background: rgba(255,181,71,.08); border: 1px solid rgba(255,181,71,.35); color: var(--warn);
    border-radius: 10px; padding: 10px 14px; margin-bottom: 18px; font-size: 13px;
  }

  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 550; text-transform: uppercase; font-size: 10.5px; letter-spacing: .04em; background: var(--panel-2); }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; }
  .badge.win { background: rgba(53,208,138,.15); color: var(--win); }
  .badge.loss { background: rgba(255,107,107,.15); color: var(--loss); }
  .badge.error { background: rgba(255,181,71,.15); color: var(--warn); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 30px; text-align: center; }
  section h2 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px; font-weight: 600; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>AresRPG Bot</h1>
      <div class="sub" id="address">—</div>
    </div>
    <div class="status-pill"><span class="dot" id="dot"></span><span class="status-msg" id="status-msg">loading…</span></div>
  </header>

  <div class="party" id="party"></div>

  <div class="cards" id="cards"></div>

  <div id="warn-box"></div>

  <section>
    <h2>Recent fights</h2>
    <div id="table-wrap"></div>
  </section>

<script>
const fmt = (n) => new Intl.NumberFormat().format(n)
const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return Math.floor(s) + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  return Math.floor(s / 3600) + 'h ago'
}

async function refresh() {
  let data
  try {
    data = await (await fetch('/api/data')).json()
  } catch {
    document.getElementById('status-msg').textContent = 'dashboard lost contact with local server'
    return
  }

  document.getElementById('address').textContent = data.address ?? 'no wallet configured yet'

  const dot = document.getElementById('dot')
  const msg = document.getElementById('status-msg')
  if (data.status) {
    dot.className = 'dot ' + (data.status.running ? 'running' : 'stopped')
    msg.textContent = (data.status.running ? '' : '(stopped) ') + data.status.message + ' — ' + timeAgo(data.status.updated_at)
  } else {
    dot.className = 'dot stopped'
    msg.textContent = 'no session has run yet — start it with: bun run session'
  }

  document.getElementById('party').innerHTML = data.characters
    .map((c) => \`<div class="chip"><b>\${c.name}</b><span>\${c.classe}</span></div>\`)
    .join('')

  const s = data.stats
  const profitCls = s.is_net_profitable ? 'win' : 'loss'
  const cards = [
    ['Fights', s.total, ''],
    ['Won', s.wins, 'win'],
    ['Lost', s.losses, 'loss'],
    ['Win rate', s.win_rate === null ? '—' : Math.round(s.win_rate * 100) + '%', ''],
    ['Total gas', s.total_sui + ' SUI', ''],
    ['Est. Loot Value', '+' + s.total_drops_value_sui.toFixed(4) + ' SUI', 'win'],
    ['Net Profit', (s.net_profit_sui >= 0 ? '+' : '') + s.net_profit_sui.toFixed(4) + ' SUI', profitCls],
  ]
  document.getElementById('cards').innerHTML = cards
    .map(([label, value, cls]) => \`<div class="card"><div class="label">\${label}</div><div class="value \${cls}">\${value}</div></div>\`)
    .join('')

  const xpLine = Object.entries(s.xp_totals).map(([n, xp]) => n + ' +' + fmt(xp)).join('  ·  ')
  const dropsLine = Object.entries(s.drops_totals).map(([item, qty]) => item + ' x' + qty).join('  ·  ') || 'none'
  
  document.getElementById('cards').innerHTML += \`<div class="card" style="grid-column:1/-1"><div class="label">Items Dropped & Estimated Loot</div><div class="value" style="font-size:14px;color:var(--win)">\${dropsLine}</div></div>\`
  if (xpLine) document.getElementById('cards').innerHTML += \`<div class="card" style="grid-column:1/-1"><div class="label">XP gained</div><div class="value" style="font-size:14px">\${xpLine}</div></div>\`

  document.getElementById('warn-box').innerHTML = s.expensive_count > 0
    ? \`⚠ \${s.expensive_count} fight(s) cost \${s.gas_warn_sui}+ SUI (well above the ~0.02 SUI/character baseline for this \${data.characters.length}-character party) — worth reporting to the dev with your address above and the fight id(s) below.\`
    : ''

  const rows = data.recent
  const wrap = document.getElementById('table-wrap')
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="empty">No fights logged yet.</div>'
  } else {
    wrap.innerHTML = \`<table><thead><tr>
        <th>When</th><th>Result</th><th>Mobs</th><th>Turns</th><th>Drops</th><th>Gas</th><th>Est. Loot</th><th>Net Profit</th><th>XP</th>
      </tr></thead><tbody>\${rows.map(rowHtml).join('')}</tbody></table>\`
  }
}

function rowHtml(r) {
  if (r.error) {
    return \`<tr><td>\${timeAgo(r.at)}</td><td><span class="badge error">error</span></td><td class="muted" colspan="7">\${r.error}</td></tr>\`
  }
  const badge = r.won ? '<span class="badge win">won</span>' : '<span class="badge loss">lost</span>'
  const xp = Object.entries(r.xp_gained).map(([n, xp]) => n + ' +' + xp).join(', ') || '—'
  const gasCls = Number(r.gas_sui) >= 0.1 ? 'style="color:var(--warn);font-weight:650"' : ''
  const mobs = r.mobs.map((m) => m.mob_type + (m.level > 0 ? ' (lv' + m.level + ')' : '')).join(', ') || '—'
  const drops = r.drops ? Object.entries(r.drops).map(([k, v]) => k + ' x' + v).join(', ') : 'none'
  const dropsVal = r.drops_value_sui !== undefined ? '+' + Number(r.drops_value_sui).toFixed(4) + ' SUI' : '—'
  const netProfit = r.net_profit_sui !== undefined ? (r.net_profit_sui >= 0 ? '+' : '') + Number(r.net_profit_sui).toFixed(4) + ' SUI' : '—'
  const netCls = r.net_profit_sui !== undefined && r.net_profit_sui >= 0 ? 'style="color:var(--win);font-weight:600"' : 'style="color:var(--loss)"'

  return \`<tr>
    <td>\${timeAgo(r.at)}</td><td>\${badge}</td><td>\${mobs}</td>
    <td>\${r.turns}</td><td class="muted">\${drops}</td><td \${gasCls}>\${r.gas_sui} SUI</td>
    <td style="color:var(--win)">\${dropsVal}</td><td \${netCls}>\${netProfit}</td><td class="muted">\${xp}</td>
  </tr>\`
}

refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`

Bun.serve({
  port: PORT,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/api/data') {
      const entries = read_log()
      const stats = compute_stats(entries)
      const status = read_status()
      const position = read_position()

      const body = {
        address: null as string | null, // no wallet loaded here — the dashboard is read-only/offline
        position,
        characters: CHARACTERS.map((c) => ({ name: c.name, classe: c.classe })),
        status: status && { ...status, running: Date.now() - new Date(status.updated_at).getTime() < STALE_AFTER_MS },
        stats: {
          total: stats.fights.length,
          wins: stats.wins.length,
          losses: stats.losses.length,
          win_rate: stats.win_rate,
          total_sui: mist_to_sui(stats.total_gas_mist),
          avg_sui: mist_to_sui(stats.avg_gas_mist),
          xp_totals: stats.xp_totals,
          drops_totals: stats.drops_totals,
          total_drops_value_sui: stats.total_drops_value_sui,
          net_profit_sui: stats.net_profit_sui,
          is_net_profitable: stats.is_net_profitable,
          expensive_count: stats.expensive.length,
          gas_warn_sui: mist_to_sui(GAS_WARN_MIST),
        },
        recent: [...entries]
          .reverse()
          .slice(0, 30)
          .map((e) => ({ ...e, gas_sui: mist_to_sui(BigInt(e.gas_mist)) })),
      }
      return Response.json(body)
    }
    return new Response('not found', { status: 404 })
  },
})

console.log(`dashboard running at http://localhost:${PORT} — open it in your browser`)
