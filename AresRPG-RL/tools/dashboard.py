"""Render a self-contained HTML report from a training run's Monitor CSV(s).

python -m tools.dashboard --log runs/monitor --out runs/dashboard.html

--log is the directory rl.train --log writes to (one CSV per worker) — or a single
CSV file, for a log from before --workers existed. No dependencies beyond the
standard library (no matplotlib, no internet access needed) so it works the same
on a laptop or inside a Colab cell.
"""
import argparse
import csv
import sys
from collections import deque
from pathlib import Path


def _load_file(path):
    # Read as raw bytes and filter, rather than handing the file straight to
    # csv.DictReader: a Monitor CSV from a long multi-process training run has been
    # observed with stray embedded NUL bytes in individual rows (Windows, one worker
    # out of five, cause not pinned down -- SB3's own writer flushes after every row and
    # isn't the source) that otherwise crash float() parsing later. None of this format's
    # fields are ever multi-line/quoted, so splitting on plain "\n" is safe here.
    lines = Path(path).read_bytes().decode("utf-8", errors="replace").split("\n")
    if lines and lines[0].startswith("#"):
        lines = lines[1:]  # drop the '#{"t_start":...}' header line, if present
    if not lines or not lines[0].strip():
        return []
    header, data_lines = lines[0], [l for l in lines[1:] if l.strip()]  # drop the trailing blank line after the last "\r\n"
    clean = [l for l in data_lines if "\x00" not in l and "�" not in l]
    skipped = len(data_lines) - len(clean)
    if skipped:
        print(f"warning: {path} has {skipped} corrupted row(s) (stray NUL bytes) -- skipped", file=sys.stderr)
    return list(csv.DictReader([header] + clean))


def _load(path):
    # rl.train --workers > 1 writes one Monitor CSV per worker process (they can't
    # share a file); merge them all here, in roughly chronological order across
    # workers (each worker's own "t" is elapsed seconds since ITS start, but workers
    # start together, so sorting the merge by t approximates a single timeline).
    p = Path(path)
    if p.is_dir():
        rows = [row for file in sorted(p.glob("*.monitor.csv")) for row in _load_file(file)]
        rows.sort(key=lambda r: float(r["t"]))
        return rows
    return _load_file(p)


def _rolling_mean(values, window):
    out, q, total = [], deque(), 0.0
    for v in values:
        q.append(v); total += v
        if len(q) > window:
            total -= q.popleft()
        out.append(total / len(q))
    return out


def _sparkline(values, width=760, height=160, color="#3b82f6", pad=12):
    if len(values) < 2:
        return f'<svg width="{width}" height="{height}"></svg>'
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1
    n = len(values)
    xs = [pad + (width - 2 * pad) * i / (n - 1) for i in range(n)]
    ys = [height - pad - (height - 2 * pad) * (v - lo) / span for v in values]
    points = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys))
    baseline = height - pad
    area = f"{xs[0]:.1f},{baseline:.1f} {points} {xs[-1]:.1f},{baseline:.1f}"
    return f'''<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" preserveAspectRatio="none">
  <polygon points="{area}" fill="{color}" opacity="0.12"/>
  <polyline points="{points}" fill="none" stroke="{color}" stroke-width="2.5"/>
  <text x="{pad}" y="16" font-size="12" fill="#6b7280">max {hi:.1f}</text>
  <text x="{pad}" y="{height - 4}" font-size="12" fill="#6b7280">min {lo:.1f}</text>
</svg>'''


def _card(label, value):
    return f'<div class="card"><div class="card-label">{label}</div><div class="card-value">{value}</div></div>'


def _chart(title, values, window, color):
    smoothed = _rolling_mean(values, window)
    return f'''<section class="chart">
  <h2>{title}</h2>
  {_sparkline(smoothed, color=color)}
</section>'''


def build_html(rows, window):
    n = len(rows)
    reward = [float(r["r"]) for r in rows]
    length = [float(r["l"]) for r in rows]
    win = [float(r["win"]) for r in rows]
    dealt = [float(r["damage_dealt"]) for r in rows]
    taken = [float(r["damage_taken"]) for r in rows]
    kills = [float(r["kills"]) for r in rows]
    deaths = [float(r["deaths"]) for r in rows]
    rounds = [float(r["rounds"]) for r in rows]
    recent = rows[-window:] if n > window else rows
    recent_winrate = sum(float(r["win"]) for r in recent) / len(recent)

    cards = "".join([
        _card("Episodes", n),
        _card("Overall win rate", f"{100*sum(win)/n:.1f}%"),
        _card(f"Win rate (last {len(recent)})", f"{100*recent_winrate:.1f}%"),
        _card("Avg reward", f"{sum(reward)/n:.1f}"),
        _card("Avg episode length", f"{sum(length)/n:.0f} steps"),
        _card("Avg rounds/fight", f"{sum(rounds)/n:.1f}"),
        _card("Avg damage dealt", f"{sum(dealt)/n:.0f}"),
        _card("Avg damage taken", f"{sum(taken)/n:.0f}"),
        _card("Avg kills / deaths", f"{sum(kills)/n:.1f} / {sum(deaths)/n:.1f}"),
    ])

    charts = "".join([
        _chart(f"Win rate (rolling {window}-episode average)", win, window, "#16a34a"),
        _chart(f"Episode reward (rolling {window}-episode average)", reward, window, "#3b82f6"),
        _chart(f"Episode length (rolling {window}-episode average)", length, window, "#a855f7"),
        _chart(f"Damage dealt vs taken (rolling {window}, dealt)", dealt, window, "#f97316"),
        _chart(f"Damage dealt vs taken (rolling {window}, taken)", taken, window, "#ef4444"),
    ])

    return f'''<!doctype html>
<html><head><meta charset="utf-8"><title>AresRPG RL training dashboard</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, sans-serif; background:#f8fafc; color:#111827; margin:0; padding:32px; }}
  h1 {{ margin:0 0 4px; }}
  .subtitle {{ color:#6b7280; margin-bottom:24px; }}
  .cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:32px; }}
  .card {{ background:white; border:1px solid #e5e7eb; border-radius:10px; padding:14px 16px; }}
  .card-label {{ font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:.04em; }}
  .card-value {{ font-size:22px; font-weight:600; margin-top:4px; }}
  .chart {{ background:white; border:1px solid #e5e7eb; border-radius:10px; padding:16px 20px; margin-bottom:16px; }}
  .chart h2 {{ font-size:14px; font-weight:600; color:#374151; margin:0 0 8px; }}
  svg {{ width:100%; height:auto; display:block; }}
</style></head>
<body>
  <h1>AresRPG RL training dashboard</h1>
  <div class="subtitle">{n} logged episodes &middot; generated by tools/dashboard.py</div>
  <div class="cards">{cards}</div>
  {charts}
</body></html>'''


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--log", default="runs/monitor",
                   help="directory of per-worker Monitor CSVs from rl.train --log (or a single CSV file)")
    p.add_argument("--out", default="runs/dashboard.html")
    p.add_argument("--window", type=int, default=50, help="rolling-average window, in episodes")
    a = p.parse_args()
    rows = _load(a.log)
    if not rows:
        raise SystemExit(f"no completed episodes in {a.log} yet -- run training first")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(build_html(rows, a.window), encoding="utf-8")
    print(f"wrote {a.out} ({len(rows)} episodes)")


if __name__ == "__main__":
    main()
