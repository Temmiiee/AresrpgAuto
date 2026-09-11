# Roadmap

## Phase 0 — bootstrap ✓
Python/Bun bridge, Gymnasium environment, MaskablePPO training loop, scenario generator, Colab support.

## Phase 1 — exact simulator interface ✓
Real AresRPG classes, spells, and mobs pulled from the live engine via `tools/build_content.py`.
Exact legal-action enumeration (spell/weapon targets from the engine's own legality checks).
Exact movement enumeration via `reachable_fight_cells`/`fight_path_to`.
State encoder corrected (real HP fractions, grid-relative positions, max_hp in wire protocol).
Critical bridge bugs fixed (BigInt type mismatches, anti-spam clock, post-step index bug, bigint
event payloads). End-to-end verified: full random-policy episodes run clean, ~130 steps/sec.
Reset payload cut from ~354KB to ~8.6KB via spell catalog caching (`load_spells` op).

## Phase 2 — RL training

### MaskablePPO — documented dead end
Seven configurations (varying init, entropy coef, learning rate, gradient clipping, network
width, behavior-cloning warm-start, action space size) all collapsed to `entropy_loss=0`
within tens-to-hundreds of thousands of steps. Root cause identified: sb3-contrib's
MaskableCategorical float32 instability with large masked action spaces. `CollapseGuardCallback`
added to stop runs early. PPO code kept for reference; `rl/train.py` still works if this path
is ever revisited with a different approach.

### (mu+lambda) evolution strategy — current approach ✓
Pivoted to a weight-vector evolution strategy (ported from AresRPGBot's `cli_train.ts`).
Six policy weights: `base_weight`, `priority_decay`, `finish_weight`, `heal_weight`,
`strike_bias`, `element_weight`.

Infrastructure: calibrated scenario selection (filters scenarios to 15–90% win-rate band),
per-generation checkpointing with `--resume`, held-out validation gate (only saves if
held-out improvement ≥ `--min-holdout-improvement`), fitness function scoring only
winning rounds (not pooled — rewarding fast losses was a bug, fixed), `--seed` now fully
reproducible (mutations and crossovers use a seeded `random.Random`).

Two validated training runs completed:
- Run 1: +25.33 training, +52.88 held-out.
- Run 2 (current `models/policy.json`): +20.46 training, +43.50 held-out.
  `base_weight=0.86, priority_decay=0.47, finish_weight=1.08, heal_weight=0.37, strike_bias=-0.55`

The trained policy still underperforms `rl/heuristic.py` (simple focus-fire) on raw
uncalibrated scenarios — validated improvement is real but subtle (0.34% decision divergence
vs. default weights). The gap is most likely because `priority_decay` hasn't been pushed
high enough to approach the heuristic's absolute focus-fire behavior.

Policy exported to AresRPGBot and cross-validated independently. The bot's own validator
(`cli_validate_policy.ts`) showed a wash after calibration improvements — the TS-side
training distribution (fixed 4-class roster) is narrower than the Python side (all 12 classes),
so cross-transfer is unreliable. Both sides have now been fixed to use all 12 classes.

### Remaining Phase 2 items
- [ ] Run `tools/multi_evolve.py` at real scale (N=4+, `--generations 20 --population 14
  --scenarios 30`) to get multiple independently validated candidates and pick the best.
- [ ] Validate that `element_weight` learns a real signal once `bridge/server.ts`'s
  resistance normalization fix (2026-09-10) has run through a full training cycle.
- [x] Port `lookahead.ts`'s top-K-candidate-plans technique to `rl/lookahead.py` (2026-09-10).
  `choose_action_index(env, policy, top_k=5)` scores the top-K actions statically via
  `scored_decide`'s formula, simulates each one step forward via the bridge, evaluates the
  resulting state with a heuristic value function (ally HP fraction minus enemy HP fraction),
  and picks the action leading to the best state. Drop-in replacement for `scored_decide`.
  Also provides `choose_action_index_static_topk` (no bridge simulation, pure static
  top-K) as a cheaper intermediate baseline.
  Limitation: requires `env._episode_setup`/`env._episode_seed` to restore bridge state
  after simulation — works with `AresFightEnv` but not with `SimHandle` directly (falls
  back to static top-1 in that case). Phase 4 will add a proper bridge snapshot/restore op.
  Precondition: base policy should clearly beat the heuristic before lookahead adds value.
- [ ] Feed a newly trained, validated policy to `tools/export_policy_to_bot.py` and deploy.

## Phase 3 — composition research

### Infrastructure ✓
`tools/compositions.py` sweeps all C(15,4)=1365 4-class multisets (duplicates allowed,
matching `ScenarioGenerator.DUPLICATE_CLASS_PROB`) against every mob archetype in the
catalog. Ranks by Wilson 95% CI lower bound. Reports generalist/specialist breakdown.
Parallelized via `--workers` (one Bun subprocess per worker process).

Verified end-to-end on 2 compositions × 12 archetypes × 2 episodes — mechanically correct.

### Remaining Phase 3 items
- [ ] Run a full sweep: `python -m tools.compositions --compositions all --workers 4
  --episodes 30 --policy models/policy.json`. Results are only meaningful with a policy
  that demonstrably outperforms the heuristic — don't trust rankings from a policy that
  is no better than random.
- [x] Double-DPS / double-support / no-healer / no-frontline *archetype* coverage (2026-09-10).
  `ScenarioGenerator` now classifies the 12 classes into `dps` (9 classes), `healer` (iyashi),
  and `tank` (shugo, tokei) based on spell data. `ARCHETYPE_PROB=0.15` means 15% of
  scenarios draw a forced archetype team via `_archetype_team()`, covering patterns
  under-represented by pure random sampling: `all_dps`, `no_healer`, `no_frontline`,
  `healer_heavy`, `tank_heavy`. With the current 12-class catalog, `no_healer` (~49%)
  and `all_dps` (~46%) dominate the archetype draw, reflecting the real class distribution
  (1 healer, 2 tanks, 9 DPS). `healer_heavy` becomes possible if more healer classes are
  added to the content pack.

## Phase 4 — solver

### Infrastructure ✓
- [x] **Bridge snapshot/restore** (`bridge/server.ts`, `rl/bridge.py`) — ops `snapshot`,
  `restore`, `drop_snapshot` ajoutés. `bridge.snapshot()` sérialise l'état courant du moteur
  et retourne un `snap_id`; `bridge.restore(snap_id)` recharge ce point exact sans reset.
  Les snapshots sont purgés automatiquement sur chaque `reset` (pas de fuite mémoire entre
  épisodes). `rl/lookahead.py` mis à jour pour utiliser snapshot/restore au lieu d'un reset
  complet — le lookahead simule maintenant tous ses candidats correctement.

- [x] **Value network** (`rl/value.py`) — MLP PyTorch (256→128→64→1, sigmoid) entraîné
  par supervision sur des épisodes joués (`label=1` si victoire). `collect_value_dataset()`
  joue N épisodes et retourne `(obs, labels)`. `train_value_net()` : BCE, train/val split,
  sauvegarde du meilleur checkpoint. CLI : `python -m rl.value --collect --episodes 5000`.
  Seed 555_555, distinct des seeds train/eval/calibration.

- [x] **Beam Search** (`rl/beam_search.py`) — guidé par la politique (scored_decide score
  les branches) + évalué par le value network aux feuilles. Paramètres : `depth` (horizon
  en décisions joueur), `beam_width` (nœuds conservés), `branch_factor` (candidats/nœud).
  Retourne `BeamResult(best_action_idx, best_line, win_prob, alternatives)`. Fallback sur
  heuristique HP-ratio si aucun value_net fourni. Libère proprement tous les snapshots.

- [x] **Solver complet** (`tools/solve_fight.py`) — remplace le stub. Trois modes :
  `greedy` (scored_decide pur, ~0ms), `lookahead` (top-K + 1-pas, ~50ms), `beam` (Beam
  Search complet, ~0.5-2s). Explication textuelle générée depuis les events réels du
  simulateur (pas hallucinée). CLI : `python -m tools.solve_fight --setup fight.json`.
  Sortie console lisible ou `--json` pour intégration.

- [x] **Calibration** (`tools/calibrate_value.py`) — ECE (Expected Calibration Error),
  Brier score, accuracy, reliability diagram ASCII. Collecte un dataset de calibration
  séparé (seed 888_888) ou accepte un `.npz` existant. Sauvegarde JSON optionnelle.
  CLI : `python -m tools.calibrate_value --model models/value_net.pt --episodes 1000`.

### Remaining Phase 4 items
- [ ] **Entraîner le value network** : `python -m rl.value --collect --episodes 5000
  --policy models/policy.json` puis vérifier la calibration avec `tools/calibrate_value.py`.
  La qualité du réseau est le principal levier d'amélioration du Beam Search.
- [ ] **MCTS** : Monte Carlo Tree Search avec le value network comme prior — plus flexible
  que le Beam Search (exploration vs exploitation adaptative). À implémenter une fois le
  value network validé.
- [ ] **Win probability calibration** (température scaling) : si ECE > 0.05 après
  entraînement, ajuster par un paramètre de température T tel que `sigmoid(logit/T)` →
  sortie calibrée. Simple post-processing sans ré-entraînement.

## Phase 5 — interface
- [ ] Upload/enter a fight state
- [ ] Visual board
- [ ] Best move + full recommended line
- [ ] Alternatives with explanation
- [ ] Composition optimizer

---

## Audit findings — 2026-09-10

Full correctness audit of the RL system and simulator. Issues found and fixed in the same
session; details below for future reference.

### Fixed — Critical

**`element_weight` was silently always 0** (`bridge/server.ts`, `rl/scored_decide.py`).
Resistance values in `archetypes.json` use fixed-point encoding with baseline `32768 = 2^15`
(e.g. `fire_res=32788` → +20% resistance, `water_res=32758` → -10% / vulnerability). The
bridge was emitting the raw integer (~32787) and Python divided by 100, giving ~327, which
clamped immediately to 0. Fixed: bridge now subtracts 32768 before sending, so Python
receives a plain signed integer (`+20`, `-10`, etc.) and the formula `1 - res/100` works
correctly. `element_weight` is now a live, functional parameter in the policy search.

**Spell scoring always used level 1 stats** (`rl/spell_catalog.py`, `rl/scored_decide.py`,
`bridge/server.ts`). The engine executes spells at a character's actual invested level
(computed by `_spell_levels` in `scenarios.py` and sent in `setup.players[i].spell_levels`).
`scored_decide.py` was scoring them at level 1 regardless. A maxed early-unlock spell can
have a radically different AP cost and damage at its real level vs. level 1 (e.g. 5 AP → 3
AP, damage ×2). Fixed: `bridge/server.ts` now includes `spell_levels` in the fighter
summary for players. `spell_catalog.castable_spells()` accepts an optional `spell_levels`
dict and indexes the correct level entry. `scored_decide.py` passes the active fighter's
`spell_levels` through.

### Fixed — Medium

**Mob-turn steps fired a -2 reward penalty** (`rl/env.py`). When the active fighter is a
mob, `candidates()` returns `[]` and `env.step(0)` falls into the out-of-range branch
(`0 >= 0` on an empty list), incurring `-2` reward. This silently penalized the agent for
something that isn't its fault, reducing the effective reward signal and consuming episode
budget on non-decisions. Fixed: the out-of-range branch now returns `reward=0.0` instead
of `-2`. True engine rejections of legal actions (a bridge bug) still return `-2` to
surface the problem.

**No class identity in the observation** (`rl/env.py`). The agent could not distinguish
between a healer ally and a melee ally, or between an earth-resistant mob and a water-resistant
mob — all fighters at the same level looked identical. Fixed: a 12th feature is now added per
fighter encoding class as a normalized index (players: 0-based over 12 classes; mobs: -1,
below the player range). This is the minimum meaningful addition; a full one-hot over 12
classes (96 additional floats) would be richer but OBS_SIZE=256 has headroom for it if needed.
Note: this invalidates old PPO checkpoints (all confirmed dead-end anyway).

### Known limitations (not bugs, design choices)

- **Stat allocation is a simplification** (`rl/scenarios.py`): the real per-class
  capital-point cost ladders aren't replicated. This produces valid but not perfectly
  realistic character builds.
- **`_spell_levels` is greedy by unlock order**, not by meta-relevance. Real players
  don't always max the earliest spell. Acceptable approximation for scenario diversity.
- **"Other" role spells (CC, traps) are never chosen** by `scored_decide.py`. The engine
  enumerates them as legal actions; the scorer ignores them. This matches the TS bot's
  own design. A future improvement could add a `utility_weight` policy dimension.
- **Weapon strike scoring is not scaled by `base_weight`**, creating an asymmetry vs.
  spell scoring that makes `strike_bias` hard to tune intuitively. Intentional port from
  the TS original; not changed.
- **`rl/heuristic.py` now selects by AP efficiency** among multiple actions targeting
  the same lowest-HP enemy (using `castable_spells.score` = damage/AP at the actual
  invested level), instead of enumeration order.
- **`CollapseGuardCallback`'s logger key** (`"train/entropy_loss"`) is correct for current
  SB3 but fragile to version changes.
