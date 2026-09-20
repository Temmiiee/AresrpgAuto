# AresRPG RL

A research system for [AresRPG](https://github.com/aresrpg/aresrpg) tactical combat.
Two intended outputs:

1. **Composition analysis** — which 4-character team compositions are strongest, measured
   across a broad distribution of enemies, levels, maps and seeds; generalists vs.
   specialists, with statistically meaningful rankings.
2. **Exact fight solver** — given one concrete fight state, estimate win probability,
   recommend the best action (and a full line), explain why, and offer alternatives.

The eventual architecture combines a learned policy/value model with exact simulation and
search. See `docs/ROADMAP.md` for the phased plan and `docs/DESIGN_NOTES.md` for the
design principles behind phases 2–5.

## Core principle

**Never reimplement AresRPG combat rules in Python.** The real `@aresrpg/fight` engine
(TypeScript, in the AresRPG repo) is the only source of truth for legality, state
transitions, and combat math. Python owns RL, scenario generation, datasets, evaluation,
and search orchestration — it calls the engine, never re-derives it. See
`CONTRIBUTING.md` for the full list of rules this implies.

## Status (2026-09-10)

**Phase 0–1 complete**: a real fight can be generated, trained against, won or lost,
logged, and visualized. Real AresRPG classes, spells, and mobs; exact legal-action
enumeration (all filtered through the engine's own legality checks); bridge bugs that
were silently breaking every action are fixed.

**Phase 2 (RL) — documented dead end + working pivot**:
MaskablePPO training (7 configurations) collapsed to entropy=0 in every run without
recovery — documented in detail in `docs/ROADMAP.md` so nobody repeats it. Pivoted to a
**(mu+lambda) evolution strategy** over a 6-weight vector (`base_weight`, `priority_decay`,
`finish_weight`, `heal_weight`, `strike_bias`, `element_weight`). Two fully validated
runs completed; second result: training-set +20.46, held-out **+43.50** — healthy
generalization gap. Policy exported to AresRPGBot and cross-validated independently.

**Phase 2b remaining items** (all implemented, not yet run at scale):
- `element_weight` is now fully supported: `bridge/server.ts` exposes mob elemental
  resistances, `rl/policy.py` and `rl/scored_decide.py` use them.
- `--seed` now fully reproduces a run (mutations and crossovers use a seeded `random.Random`).
- `tools/multi_evolve.py` runs N independent training runs in parallel and keeps the
  best validated result — cheap insurance against single-run overfitting.
- `tools/record_replay.py` records fights as JSON frames compatible with the AresRPGBot
  HTML viewer.

**Phase 3 (composition research) — scaffolding complete**:
`tools/compositions.py` sweeps all C(15,4)=1365 team multisets (duplicates allowed, per
`ScenarioGenerator.DUPLICATE_CLASS_PROB`) against every mob archetype, ranks by Wilson
95% CI lower bound, reports generalist/specialist breakdowns, and parallelizes via
`--workers`. A full 1365-composition sweep at meaningful episode count hasn't been run
yet — results are only as good as the policy checkpoint driving them.

**Phase 4–5**: not started.

## Architecture

```text
AresRPG repo → @aresrpg/fight engine → Bun bridge (bridge/server.ts)
                                              │  NDJSON over stdin/stdout
                                              ▼
                                      Python (rl/, tools/)
                              scenario generator ─┬─ evolutionary policy
                                                   ▼
                                          exact simulator (the bridge)
```

Full detail in `docs/ARCHITECTURE.md`. The key invariant: `bridge/server.ts` is the only
file that imports `@aresrpg/fight`; Python never re-derives combat rules.

## Repo layout

```
bridge/server.ts       the only place that talks to @aresrpg/fight — one long-lived Bun
                        process per training env, JSON-per-line protocol
rl/
  bridge.py            subprocess wrapper for bridge/server.ts
  env.py               Gymnasium env (AresFightEnv)
  scenarios.py         random fight generator (ScenarioGenerator)
  policy.py            6-weight vector (base_weight … element_weight)
  scored_decide.py     weighted turn-decision function using the policy
  heuristic.py         simple fixed baseline (always attack lowest-HP enemy)
  evolve.py            (mu+lambda) ES trainer with held-out validation gate
  spell_catalog.py     per-spell damage/support-per-AP scoring
  movement.py          shared move-toward-nearest-enemy helper
  policy_store.py      JSON persistence for trained policies
tools/
  build_content.py     pulls real classes/spells/mobs from an AresRPG checkout into data/
  benchmark.py         quick episode throughput and win-rate check (heuristic)
  compositions.py      Phase 3: composition × archetype win-rate matrix, Wilson ranking
  benchmark.py         quick episode throughput and win-rate check (heuristic)
  record_replay.py     records fights as JSON frames for the HTML viewer
  multi_evolve.py      runs N rl.evolve in parallel, keeps the best validated result
  export_policy_to_bot.py  translates models/policy.json into AresRPGBot's format
  solve_fight.py       stub — Phase 4, not implemented
data/                  archetypes.json, spells.json — generated, not hand-authored
docs/                  ARCHITECTURE.md, ROADMAP.md, DESIGN_NOTES.md, COLAB.md
models/policy.json     current validated policy (base_weight=0.86 … element_weight=0.0)
```

## Quickstart

You need an AresRPG checkout alongside this repo — it is the only source of truth for
combat, so there is no vendored copy here.

```bash
git clone https://github.com/aresrpg/aresrpg.git --branch edge
export ARES_RPG_ROOT=$(pwd)/aresrpg

pip install -r requirements.txt
python -m rl.smoke_test       # expect Reset -> ok = True
```

No `bun install` needed — `bridge/server.ts` imports `@aresrpg/fight` straight from
`$ARES_RPG_ROOT`'s source.

Never used Google Colab? `docs/COLAB.md` is a full walkthrough, free-tier, no local
setup at all.

### Generate the content pack

```bash
python tools/build_content.py --root "$ARES_RPG_ROOT"
```

Re-run whenever the AresRPG content pack changes and commit the diff.

### Run the evolutionary trainer

```bash
python -m rl.evolve --generations 8 --population 10 --scenarios 8
```

Writes `models/policy.json` only if held-out improvement clears `--min-holdout-improvement`
(default 1.0). `--checkpoint` + `--resume` for crash-safe runs. See `docs/ROADMAP.md` for
the full parameter story and the two validated results.

For multiple independent runs (cheap overfitting insurance):

```bash
python -m tools.multi_evolve --runs 4 --generations 8 --population 10 --scenarios 8
```

### Record fights for the HTML viewer

```bash
python -m tools.record_replay --count 10 --out runs/replays
```

Load any `runs/replays/replay_*.json` into the
[AresRPGBot HTML viewer](https://claude.ai/code/artifact/76ebe6c6-025f-4d18-a987-39459d388e61).

### Quick baseline check

```bash
python -m tools.benchmark --episodes 100
```

### Composition research

```bash
# Sample 30 random team compositions against all mob archetypes, 15 episodes each
python -m tools.compositions --policy models/policy.json --compositions 30 --episodes 15

# Full sweep — all C(15,4)=1365 multisets (duplicates allowed), 4 parallel workers
python -m tools.compositions --compositions all --workers 4 --episodes 15
```

## Contributing

Read `CONTRIBUTING.md` first — in particular: never reimplement combat rules, pin the
AresRPG commit used for any experiment, separate training scenarios from held-out
evaluation, and don't commit model checkpoints to normal git history.
