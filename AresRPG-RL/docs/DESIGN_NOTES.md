# Design notes for phases 2-5

None of this is built yet (see `ROADMAP.md` for what's actually done). These are the
design principles to follow when building it, consolidated from earlier planning docs.

## Reinforcement learning (phase 2)

**Baseline**: MaskablePPO (already wired in `rl/train.py`). Discrete/structured actions,
illegal actions maskable, stable, easy to parallelize. Don't tune hyperparameters before
the environment itself is correct.

**Observation** (`rl/env.py`'s `_obs`, currently a crude fixed-size float array — the
last open Phase 1 item): should eventually encode, for every fighter, class/level,
HP/max HP, AP/MP, position, alive/dead, effects, cooldowns, spell levels, weapon; plus
board geometry, traps/glyphs/zones, round, current actor, turn order. Keep it
deterministic and versioned — a change to the encoding invalidates old checkpoints.

**Reward**: terminal win/loss dominates; damage/kill/death shaping only to accelerate
learning (already in `env.py`). Periodically check for reward hacking — a policy that
farms damage or survives without improving win rate isn't succeeding.

**Curriculum**: start small (1v1, 2v2) before full 4v4-vs-N. Increase difficulty when the
agent clears a target success rate. Keep a "hard-fight" replay pool (losses, near-losses,
policy disagreements) and replay it more often than average.

**Throughput**: the simulator is one Bun subprocess per env, driven over a JSON
stdin/stdout pipe (~130-155 steps/sec measured single-process). Vectorized workers
(Phase 2, done) are the main lever before this scales past a toy training budget.

Profiled server-side per step (2026-09-01, `bridge/server.ts` instrumented with
`Bun.nanoseconds()` around each stage, 600 steps): `fight.apply()` (the real engine's own
combat resolution) is ~56-59% of per-step time, this project's own `candidates()` (legal-
action enumeration: a full path computed per reachable cell via `fight_path_to`, plus a
legality check per spell/weapon per candidate cell) is ~37-41%, everything else (JSON
parse/stringify, `create_fight`, `summary()`) is ~3-4% combined and not worth chasing.
`apply()` is the authoritative engine and stays untouched (see "Core principle" in
`README.md`); `candidates()` calls the engine's own exported query functions
(`reachable_fight_cells`/`fight_path_to`/`spell_target_cells`/`weapon_target_cells`) whose
internal cost isn't controlled from this repo either. So per-step latency is
fundamentally engine-bound -- there's no cheap win left there; more `--workers` (bounded
by physical core count) is still the real lever, not micro-optimizing one step.

One real, separate waste WAS found and fixed: `ScenarioGenerator.setup()` re-sent every
unlocked spell's full definition on *every* episode reset (~330KB, ~93% of a ~354KB reset
payload) even though the same ~12-class spell catalog barely changes across an entire
training run. Fixed by caching the full catalog once per Bun subprocess lifetime
(`AresBridge.__init__` sends it via a new `load_spells` op) and having `reset` send only
spell *names* thereafter (`rl/bridge.py`, `rl/scenarios.py`, `bridge/server.ts`) -- cut the
reset payload to ~8.6KB (97.6% smaller) and the reset round trip from ~25ms to ~17ms.
Modest (resets are ~1 in 120 requests per episode), but free and safe: pure caching, no
behavior change, verified against a real fight end-to-end.

## Evaluation (phase 2-3)

Training win rate is not a benchmark. Keep a frozen, held-out scenario set (never used
for training) covering: balanced teams, heterogeneous levels, enemy level near/above team
level, unseen enemy groups, unseen seeds, unusual compositions, hard fights. Report per
checkpoint: episodes, win rate + 95% interval (Wilson, not raw fractions when sample
counts differ), average turns, average deaths, average HP remaining, invalid-action rate
— broken down by scenario category, not just in aggregate. A new checkpoint is better
only if it improves the held-out set, not the training reward.

## Composition research (phase 3)

Goal: find strong 4-character compositions, not just a policy that wins with one fixed
team. For every candidate composition, sample many scenarios and record win rate (with
confidence interval, not raw), average turns, deaths, remaining HP, damage dealt/taken,
and performance broken out by enemy archetype / difficulty ratio / level distribution.
Report generalists vs. specialists (best overall vs. best-against-melee vs.
best-on-open-maps, etc.) separately — don't collapse them into one ranking.

Don't enumerate every possible build. Broad random sampling first, keep promising
compositions, mutate/cross or bandit-allocate, then intensively evaluate the shortlist.

Scenario generation should keep covering the full spread: four distinct classes,
duplicate classes, double-DPS, double-support, no-healer, no-frontline, extreme level
differences (e.g. 50/45/35/20 must be as valid a target as 40/40/40/40) — same idea on
the enemy side (one strong enemy vs. many weak, mixed levels, bosses, ranged/melee/control
groups). Keep train/validation/held-out/challenge scenario distributions separate, with
deterministic seeds so benchmark runs reproduce exactly.

## Exact combat solver (phase 4)

Given one concrete fight state, return: best immediate action, a recommended sequence,
estimated win probability, expected casualties, alternative lines, and a tactical
explanation. RL alone finds a generally good policy but not necessarily the best line for
one unusual position — combine policy + value network + Beam Search or MCTS + the exact
simulator as ground truth (clone/snapshot state, apply a candidate, evaluate, repeat for
a limited horizon, compare branches).

The explanation layer must be generated from actual simulator events and measured state
changes, never a hallucinated narrative of game mechanics.

## Interface (phase 5)

Upload/enter a fight, visual board, best move, full recommended line, alternatives,
composition optimizer. Not started; no design notes yet beyond "consume the solver's
output," since the solver itself doesn't exist.
