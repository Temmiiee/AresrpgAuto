// HTML for cli_control_panel.ts, split out to keep the server file readable. Shares
// cli_dashboard.ts's visual language (same dark palette, card grid) so the two feel like one
// product even though this one adds real actions on top of read-only monitoring.
const SHARED_STYLE = `
  :root {
    color-scheme: dark;
    --bg: #0b0d12; --panel: #12151d; --panel-2: #171b26; --border: #232838;
    --text: #e7eaf3; --muted: #8b93a7; --accent: #7c9fff;
    --win: #35d08a; --loss: #ff6b6b; --warn: #ffb547;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "Segoe UI", Inter, sans-serif; padding: 20px; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  button {
    font: inherit; font-weight: 650; border-radius: 10px; border: 1px solid var(--border);
    background: var(--panel-2); color: var(--text); padding: 12px 18px; cursor: pointer;
  }
  button:active { transform: scale(0.98); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #0b0d12; }
  button.danger { background: rgba(255,107,107,.15); border-color: rgba(255,107,107,.4); color: var(--loss); }
  button:disabled { opacity: 0.5; cursor: default; }
  input {
    font: inherit; background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 10px; padding: 12px 14px; width: 100%;
  }
`

export const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AresRPG Bot — Sign in</title>
<style>${SHARED_STYLE}
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  form { width: 100%; max-width: 320px; display: flex; flex-direction: column; gap: 14px; }
  .error { color: var(--loss); font-size: 13px; min-height: 18px; }
</style></head>
<body>
  <form id="f">
    <h1>AresRPG Bot</h1>
    <div class="sub">Enter the control panel password</div>
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password" />
    <button class="primary" type="submit">Sign in</button>
    <div class="error" id="err"></div>
  </form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  const err = document.getElementById('err');
  err.textContent = 'Signing in…';
  try {
    const res = await fetch('/login', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ password: pw }) });
    if (res.ok) { location.reload(); return; }
    err.textContent = 'Wrong password.';
  } catch { err.textContent = 'Could not reach the server.'; }
});
</script>
</body></html>`

export const APP_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AresRPG Bot</title>
<style>${SHARED_STYLE}
  header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; flex-wrap: wrap; gap: 12px; }
  .status-pill { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 999px; padding: 7px 14px; font-size: 12.5px; color: var(--muted); max-width: 480px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.running { background: var(--win); box-shadow: 0 0 0 3px rgba(53,208,138,.18); animation: pulse 1.6s infinite; }
  .dot.stopped { background: #4a5165; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
  .status-msg { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .controls { display: flex; gap: 10px; margin-bottom: 18px; }
  .controls button { flex: 1; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 21px; font-weight: 650; margin-top: 4px; }
  .card .value.win { color: var(--win); } .card .value.loss { color: var(--loss); }

  .party { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .char-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; min-width: 140px; flex: 1; }
  .char-card b { display: block; font-size: 13.5px; }
  .char-card .classe { color: var(--muted); font-size: 11.5px; text-transform: capitalize; }
  .char-card .lvl { color: var(--accent); font-size: 12.5px; margin-top: 4px; }
  .char-card .pts { color: var(--warn); font-size: 11.5px; }

  .warn-box { background: rgba(255,181,71,.08); border: 1px solid rgba(255,181,71,.35); color: var(--warn); border-radius: 10px; padding: 10px 14px; margin-bottom: 18px; font-size: 13px; }

  section { margin-bottom: 20px; }
  section h2 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
  section h2 button { font-size: 11px; padding: 5px 10px; }

  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 550; text-transform: uppercase; font-size: 10.5px; letter-spacing: .04em; background: var(--panel-2); }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; }
  .badge.win { background: rgba(53,208,138,.15); color: var(--win); }
  .badge.loss { background: rgba(255,107,107,.15); color: var(--loss); }
  .badge.error { background: rgba(255,181,71,.15); color: var(--warn); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 24px; text-align: center; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
  .scroll-x { overflow-x: auto; }

  .log-box { background: #05070a; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; max-height: 220px; overflow-y: auto; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; white-space: pre-wrap; color: #a8b3c7; }

  .sell-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .sell-row:last-child { border-bottom: none; }
  .sell-actions { display: flex; gap: 10px; margin-top: 12px; }
  .sell-actions button { flex: 1; }

  .fight-board-wrap { overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
  .fight-board { position: relative; background: var(--panel-2); border-radius: 6px; margin: 0 auto;
    background-image: linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px); }
  .fb-cell { position: absolute; }
  .fb-cell.floor { background: rgba(255,255,255,0.02); }
  .fb-cell.obstacle { background: #232838; }
  .fb-cell.hole { background: rgba(255,107,107,.12); }
  .fb-cell.start_a { background: rgba(124,159,255,.08); }
  .fb-cell.start_b { background: rgba(255,107,107,.08); }
  .fb-token { position: absolute; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-weight: 700; color: #0b0d12; transition: left 0.4s ease, top 0.4s ease; }
  .fb-token.team-0 { background: var(--accent); }
  .fb-token.team-1 { background: var(--loss); }
  .fb-token.dead { opacity: .25; filter: grayscale(1); }
  .fb-token.acting::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--warn); animation: pulse 1.1s infinite; }
  .fight-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
</style></head>
<body>
  <header>
    <div><h1>AresRPG Bot</h1><div class="sub" id="address">—</div></div>
    <div class="status-pill"><span class="dot" id="dot"></span><span class="status-msg" id="status-msg">loading…</span></div>
  </header>

  <div class="controls">
    <button class="primary" id="btn-start">▶ Start session</button>
    <button class="danger" id="btn-stop">■ Stop session</button>
  </div>

  <section id="fight-section" style="display:none">
    <h2>Current fight</h2>
    <div class="fight-meta"><span id="fight-meta-left"></span><span id="fight-meta-right"></span></div>
    <div class="fight-board-wrap"><div class="fight-board" id="fight-board"></div></div>
  </section>

  <div class="party" id="party"></div>
  <div class="cards" id="cards"></div>
  <div id="warn-box"></div>

  <section>
    <h2>Live log <button id="btn-refresh-log">refresh</button></h2>
    <div class="log-box" id="log-box">—</div>
  </section>

  <section>
    <h2>Inventory value <button id="btn-refresh-inventory">refresh</button></h2>
    <div id="inventory-panel" class="empty">loading…</div>
  </section>

  <section>
    <h2>Sell spare items <button id="btn-sell-plan">check what's sellable</button></h2>
    <div id="sell-panel" class="empty">Tap "check what's sellable" to preview — nothing is listed until you confirm.</div>
  </section>

  <section>
    <h2>Characters</h2>
    <div id="char-cards" class="party"><div class="empty">loading…</div></div>
  </section>

  <section>
    <h2>Recent fights</h2>
    <div class="scroll-x" id="table-wrap"></div>
  </section>

<script>
const fmt = (n) => new Intl.NumberFormat().format(n);
const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
};
const api = (path, opts) => fetch(path, opts).then(async (r) => {
  if (r.status === 401) { location.reload(); throw new Error('logged out'); }
  return r.json();
});

async function refreshData() {
  let data;
  try { data = await api('/api/data'); } catch { document.getElementById('status-msg').textContent = 'lost contact with server'; return; }

  document.getElementById('address').textContent = data.address;

  const dot = document.getElementById('dot'), msg = document.getElementById('status-msg');
  if (data.status) {
    dot.className = 'dot ' + (data.status.running ? 'running' : 'stopped');
    msg.textContent = (data.status.running ? '' : '(stopped) ') + data.status.message + ' — ' + timeAgo(data.status.updated_at);
  } else {
    dot.className = 'dot stopped'; msg.textContent = 'no session has run yet';
  }
  document.getElementById('btn-start').disabled = data.session_running;
  document.getElementById('btn-stop').disabled = !data.session_running;

  document.getElementById('party').innerHTML = data.characters.map((c) => \`<div class="chip" style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12.5px"><b>\${c.name}</b> <span class="muted">\${c.classe}</span></div>\`).join('');

  const s = data.stats;
  const profitCls = s.is_net_profitable ? 'win' : 'loss';
  const cards = [
    ['Fights', s.total, ''], ['Won', s.wins, 'win'], ['Lost', s.losses, 'loss'],
    ['Win rate', s.win_rate === null ? '—' : Math.round(s.win_rate * 100) + '%', ''],
    ['Total gas', s.total_sui + ' SUI', ''],
    ['Est. Loot Value', '+' + s.total_drops_value_sui.toFixed(4) + ' SUI', 'win'],
    ['Net Profit', (s.net_profit_sui >= 0 ? '+' : '') + s.net_profit_sui.toFixed(4) + ' SUI', profitCls],
  ];
  document.getElementById('cards').innerHTML = cards.map(([label, value, cls]) => \`<div class="card"><div class="label">\${label}</div><div class="value \${cls}">\${value}</div></div>\`).join('');
  const xpLine = Object.entries(s.xp_totals).map(([n, xp]) => n + ' +' + fmt(xp)).join('  ·  ');
  const dropsLine = Object.entries(s.drops_totals).map(([item, qty]) => item + ' x' + qty).join('  ·  ') || 'none';
  document.getElementById('cards').innerHTML += \`<div class="card" style="grid-column:1/-1"><div class="label">Items Dropped</div><div class="value" style="font-size:14px;color:var(--win)">\${dropsLine}</div></div>\`;
  if (xpLine) document.getElementById('cards').innerHTML += \`<div class="card" style="grid-column:1/-1"><div class="label">XP gained</div><div class="value" style="font-size:14px">\${xpLine}</div></div>\`;

  document.getElementById('warn-box').innerHTML = s.expensive_count > 0
    ? \`⚠ \${s.expensive_count} fight(s) cost \${s.gas_warn_sui}+ SUI — worth a look.\` : '';

  const rows = data.recent;
  const wrap = document.getElementById('table-wrap');
  wrap.innerHTML = rows.length === 0 ? '<div class="empty">No fights logged yet.</div>' : \`<table><thead><tr>
      <th>When</th><th>Result</th><th>Mobs</th><th>Turns</th><th>Drops</th><th>Gas</th><th>Est. Loot</th><th>Net</th><th>XP</th>
    </tr></thead><tbody>\${rows.map(rowHtml).join('')}</tbody></table>\`;
}

function rowHtml(r) {
  if (r.error) return \`<tr><td>\${timeAgo(r.at)}</td><td><span class="badge error">error</span></td><td class="muted" colspan="7">\${r.error}</td></tr>\`;
  const badge = r.won ? '<span class="badge win">won</span>' : '<span class="badge loss">lost</span>';
  const xp = Object.entries(r.xp_gained).map(([n, xp]) => n + ' +' + xp).join(', ') || '—';
  const mobs = r.mobs.map((m) => m.mob_type + (m.level > 0 ? ' (lv' + m.level + ')' : '')).join(', ') || '—';
  const drops = r.drops ? Object.entries(r.drops).map(([k, v]) => k + ' x' + v).join(', ') : 'none';
  const dropsVal = r.drops_value_sui !== undefined ? '+' + Number(r.drops_value_sui).toFixed(4) + ' SUI' : '—';
  const netProfit = r.net_profit_sui !== undefined ? (r.net_profit_sui >= 0 ? '+' : '') + Number(r.net_profit_sui).toFixed(4) + ' SUI' : '—';
  const netCls = r.net_profit_sui !== undefined && r.net_profit_sui >= 0 ? 'style="color:var(--win);font-weight:600"' : 'style="color:var(--loss)"';
  return \`<tr><td>\${timeAgo(r.at)}</td><td>\${badge}</td><td>\${mobs}</td><td>\${r.turns}</td><td class="muted">\${drops}</td><td>\${r.gas_sui} SUI</td><td style="color:var(--win)">\${dropsVal}</td><td \${netCls}>\${netProfit}</td><td class="muted">\${xp}</td></tr>\`;
}

async function refreshLog() {
  const { lines } = await api('/api/logs');
  const box = document.getElementById('log-box');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.textContent = lines.length ? lines.join('\\n') : 'no output yet';
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function refreshCharacters() {
  const wrap = document.getElementById('char-cards');
  try {
    const { characters } = await api('/api/characters');
    wrap.innerHTML = characters.map((c) => \`
      <div class="char-card">
        <b>\${c.name}</b><div class="classe">\${c.classe}</div>
        <div class="lvl">Level \${c.level} · \${fmt(c.experience)} XP</div>
        \${c.available_points > 0 || c.available_spell_points > 0 ? \`<div class="pts">\${c.available_points} stat pts, \${c.available_spell_points} spell pts unspent</div>\` : ''}
      </div>\`).join('');
  } catch { wrap.innerHTML = '<div class="empty">could not reach chain right now</div>'; }
}

const RARITY_COLOR = { epic: 'var(--warn)', rare: 'var(--accent)', uncommon: 'var(--win)', common: 'var(--muted)' };
async function refreshInventory() {
  const panel = document.getElementById('inventory-panel');
  try {
    const data = await api('/api/inventory');
    if (data.error) { panel.innerHTML = 'error: ' + data.error; panel.className = 'empty'; return; }
    panel.className = '';
    const top = [...data.lines].sort((a, b) => b.total_sui - a.total_sui).slice(0, 15);
    const rows = top.map((l) => {
      const color = RARITY_COLOR[l.rarity || 'common'];
      const tag = l.rarity ? \` <span class="muted" style="color:\${color}">[\${l.rarity}]</span>\` : '';
      return \`<div class="sell-row"><span>\${l.name}\${tag}\${l.priced_from === 'estimated' ? ' <span class="muted">(estimated)</span>' : ''}</span><b>\${l.total_sui.toFixed(4)} SUI</b></div>\`;
    }).join('');
    panel.innerHTML = \`<div class="card" style="margin-bottom:10px"><div class="label">Total (\${data.lines.length} items — \${data.listed_count} listed, \${data.unlisted_count} unlisted)</div><div class="value win">\${data.total_sui.toFixed(4)} SUI</div></div>\` + (rows || '<div class="empty">kiosk is empty</div>');
  } catch { panel.innerHTML = 'could not reach chain right now'; panel.className = 'empty'; }
}

const CELL = 30;
let boardBuilt = false;
async function refreshFight() {
  const section = document.getElementById('fight-section');
  let data;
  try { data = await api('/api/current-fight'); } catch { return; }
  if (!data.active) { section.style.display = 'none'; boardBuilt = false; return; }
  section.style.display = '';

  document.getElementById('fight-meta-left').textContent = 'Round ' + data.round + (data.ended ? (data.won ? ' — WON' : ' — LOST') : '');
  document.getElementById('fight-meta-right').textContent = data.ended ? '' : 'acting: ' + (data.fighters.find(f => f.id === data.actor)?.name ?? '?');

  const boardEl = document.getElementById('fight-board');
  if (!boardBuilt) {
    boardEl.style.width = (data.board.width * CELL) + 'px';
    boardEl.style.height = (data.board.height * CELL) + 'px';
    boardEl.style.backgroundSize = CELL + 'px ' + CELL + 'px';
    boardEl.innerHTML = data.board.cells.map((c) =>
      \`<div class="fb-cell \${c.kind}" style="left:\${c.x*CELL}px;top:\${c.y*CELL}px;width:\${CELL}px;height:\${CELL}px"></div>\`
    ).join('') + data.fighters.map((f) =>
      \`<div class="fb-token team-\${f.team}" id="fb-token-\${f.id}" title="\${f.name}" style="width:\${CELL-6}px;height:\${CELL-6}px;font-size:11px"></div>\`
    ).join('');
    boardBuilt = true;
  }
  data.fighters.forEach((f) => {
    const t = document.getElementById('fb-token-' + f.id);
    if (!t) return;
    t.style.left = (f.x * CELL + 3) + 'px'; t.style.top = (f.y * CELL + 3) + 'px';
    t.textContent = f.name.slice(0, 1).toUpperCase();
    t.classList.toggle('dead', f.dead);
    t.classList.toggle('acting', f.id === data.actor && !f.dead && !data.ended);
    const frac = Math.max(0, f.hp / f.max_hp);
    const color = frac <= 0 ? 'var(--loss)' : frac < 0.35 ? 'var(--loss)' : frac < 0.7 ? 'var(--warn)' : 'var(--win)';
    t.style.boxShadow = f.dead ? '' : \`0 0 0 2px \${color}\`;
  });
}

document.getElementById('btn-start').addEventListener('click', async () => {
  document.getElementById('btn-start').disabled = true;
  await api('/api/session/start', { method: 'POST' });
  refreshData();
});
document.getElementById('btn-stop').addEventListener('click', async () => {
  if (!confirm('Stop the session? The current fight (if any) will finish first.')) return;
  await api('/api/session/stop', { method: 'POST' });
  refreshData();
});
document.getElementById('btn-refresh-log').addEventListener('click', refreshLog);

document.getElementById('btn-refresh-inventory').addEventListener('click', refreshInventory);

// Categories a character actually wears/wields -- never touched by "bulk sell non-equipment",
// only ever opted into one at a time by hand (seed/content/items.json's own category list,
// 2026-09-06). Everything else (resources, consumables, runes, tools, and anything not in this
// game's content yet) is fair game for the bulk button.
const EQUIPMENT_CATEGORIES = new Set(['cloak','hat','amulet','boots','belt','ring','sword','daggers','bow','spear','axe','relic','pet','title','key']);

function sellRowHtml(d) {
  return \`<label class="sell-row" style="cursor:pointer">
    <span><input type="checkbox" class="sell-check" data-id="\${d.item_id}" style="margin-right:8px" />\${d.name} <span class="muted">[\${d.category}]</span>\${d.estimated_price ? ' <span class="muted">(estimated)</span>' : ''}</span>
    <b>\${d.price_sui} SUI</b>
  </label>\`;
}

document.getElementById('btn-sell-plan').addEventListener('click', async () => {
  const panel = document.getElementById('sell-panel');
  panel.innerHTML = 'checking kiosk…'; panel.className = '';
  const data = await api('/api/sell/plan');
  if (data.error) { panel.innerHTML = 'error: ' + data.error; return; }
  if (data.decisions.length === 0) { panel.innerHTML = 'nothing to sell right now.'; panel.className = 'empty'; return; }
  const nonEquipCount = data.decisions.filter((d) => !EQUIPMENT_CATEGORIES.has(d.category)).length;
  panel.innerHTML = data.decisions.map(sellRowHtml).join('')
    + \`<div class="sell-actions">
         <button id="btn-sell-bulk">Select \${nonEquipCount} non-equipment</button>
         <button class="primary" id="btn-sell-confirm">Sell selected (0)</button>
       </div>\`;

  const checks = () => Array.from(panel.querySelectorAll('.sell-check'));
  const confirmBtn = document.getElementById('btn-sell-confirm');
  const updateCount = () => {
    const n = checks().filter((c) => c.checked).length;
    confirmBtn.textContent = \`Sell selected (\${n})\`;
    confirmBtn.disabled = n === 0;
  };
  confirmBtn.disabled = true;
  panel.addEventListener('change', (e) => { if (e.target.classList.contains('sell-check')) updateCount(); });

  document.getElementById('btn-sell-bulk').addEventListener('click', () => {
    for (const c of checks()) c.checked = !EQUIPMENT_CATEGORIES.has(data.decisions.find((d) => d.item_id === c.dataset.id).category);
    updateCount();
  });

  confirmBtn.addEventListener('click', async () => {
    const item_ids = checks().filter((c) => c.checked).map((c) => c.dataset.id);
    if (item_ids.length === 0) return;
    if (!confirm(\`List \${item_ids.length} item(s) on the marketplace now?\`)) return;
    panel.innerHTML = 'listing…';
    const res = await api('/api/sell/confirm', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ item_ids }) });
    panel.innerHTML = res.error ? 'error: ' + res.error : \`listed \${res.results.length} item(s).\`;
  });
});

refreshData(); refreshLog(); refreshCharacters(); refreshFight(); refreshInventory();
setInterval(refreshData, 3000);
setInterval(refreshLog, 5000);
setInterval(refreshCharacters, 20000);
setInterval(refreshFight, 3000);
setInterval(refreshInventory, 30000);
</script>
</body></html>`
