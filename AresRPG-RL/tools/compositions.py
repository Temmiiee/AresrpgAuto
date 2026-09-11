"""Phase 3 composition research (see docs/ROADMAP.md): which 4-class team compositions
win most, measured against every enemy archetype in the real mob catalog, with
statistically meaningful rankings and a generalist/specialist breakdown.

This measures a *trained* decision-maker's performance per composition -- it doesn't train
one. Defaults to rl/scored_decide.py's weighted policy (rl/policy.py) since every
MaskablePPO checkpoint produced by rl/train.py so far is a documented dead end (entropy
collapse, no better than random -- see docs/ROADMAP.md); --model still accepts a PPO
checkpoint if that path ever produces something worth measuring again.

Compositions are multisets of 4 classes drawn from the 12 available (duplicates allowed,
matching ScenarioGenerator.DUPLICATE_CLASS_PROB's intent) -- C(15,4)=1365 total, not
C(12,4)=495 distinct-only.

python -m tools.compositions --policy models/policy.json --compositions 30 --episodes 15
python -m tools.compositions --model models/ppo_ares.zip --compositions 30 --episodes 15
"""
import argparse, itertools, json, random, statistics, sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run directly with `python tools/compositions.py`
from rl.env import AresFightEnv
from rl.policy import DEFAULT_POLICY
from rl.policy_store import load_trained_policy
from rl.scored_decide import choose_action_index as scored_choose
from tools.evaluate import wilson_interval

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
# Distinct from rl.train's default (12345) and tools.evaluate's (999_999) so composition
# research never accidentally reuses either's exact scenario stream.
COMPOSITIONS_SEED = 777_777


def run_cell(env, decide, class_ids, mob_template, episodes):
    wins = 0
    hp_frac_total = 0.0
    for _ in range(episodes):
        obs, info = env.reset(options={"class_ids": class_ids, "mob_template": mob_template})
        done = trunc = False
        while not (done or trunc):
            obs, reward, done, trunc, info = env.step(decide(env, obs))
        ended = env.state
        allies = [f for f in ended["fighters"] if f["team"] == 0]
        hp = sum(f["hp"] for f in allies if not f["dead"])
        max_hp = sum(f["max_hp"] for f in allies if not f["dead"])
        wins += int(ended.get("winner") == 0)
        hp_frac_total += hp / max_hp if max_hp else 0.0
    return {"episodes": episodes, "wins": wins, "win_rate": wins / episodes if episodes else 0.0,
            "avg_hp_frac": hp_frac_total / episodes if episodes else 0.0}


def _make_decider(model_path, policy_path):
    # A `decide(env, obs) -> action_index` closure, built once per worker process. PPO
    # needs `obs` (its net's input); the scored policy reads straight from env.state/
    # env.actions instead and ignores obs entirely -- same env either way, so run_cell
    # doesn't need to know which it got.
    if model_path:
        from sb3_contrib import MaskablePPO  # heavy import, lazy: only paid on the (dead-end) PPO path
        model = MaskablePPO.load(model_path)
        return lambda env, obs: int(model.predict(obs, action_masks=env.action_masks(), deterministic=True)[0])
    policy = load_trained_policy(policy_path) if policy_path and Path(policy_path).exists() else DEFAULT_POLICY
    return lambda env, obs: scored_choose(env, policy)


def _run_chunk(model_path, policy_path, combos, mob_templates, episodes, seed, difficulty, chunk_id):
    # Runs in its own OS process (one Bun subprocess + one loaded decider per process) --
    # same reason rl/train.py's workers are separate processes, not threads: the
    # simulator is a subprocess talking JSON over a pipe, there's no in-process
    # parallelism to exploit. Must be a module-level function (not a closure) so
    # ProcessPoolExecutor can pickle it for Windows' spawn start method.
    env = AresFightEnv(seed=seed)
    env.set_difficulty(difficulty)
    decide = _make_decider(model_path, policy_path)
    matrix = {}
    try:
        for i, combo in enumerate(combos, 1):
            key = "+".join(combo)
            matrix[key] = {t["mob_type"]: run_cell(env, decide, list(combo), t, episodes) for t in mob_templates}
            print(f"[worker {chunk_id}] [{i}/{len(combos)}] {key}", file=sys.stderr)
    finally:
        env.close()
    return matrix


def rank_compositions(matrix):
    # Statistical ranking (docs/ROADMAP.md): sort by the Wilson 95% lower bound of the
    # pooled win rate across every enemy archetype, not the raw mean -- a composition
    # that got lucky on a small sample shouldn't out-rank one tested just as hard with a
    # worse-but-better-supported result.
    rankings = []
    for composition, per_mob in matrix.items():
        total_wins = sum(c["wins"] for c in per_mob.values())
        total_episodes = sum(c["episodes"] for c in per_mob.values())
        lo, hi = wilson_interval(total_wins, total_episodes)
        win_rates = [c["win_rate"] for c in per_mob.values()]
        rankings.append({
            "composition": composition,
            "mean_win_rate": sum(win_rates) / len(win_rates),
            "ci_lo": lo, "ci_hi": hi,
            # 0 = equally strong (or weak) against every enemy archetype tried (generalist);
            # high = crushes some, loses to others (specialist).
            "specialization": statistics.pstdev(win_rates) if len(win_rates) > 1 else 0.0,
        })
    rankings.sort(key=lambda r: r["ci_lo"], reverse=True)
    return rankings


def print_report(combos, mob_templates, episodes, rankings):
    total_episodes = len(combos) * len(mob_templates) * episodes
    print(f"{len(combos)} compositions x {len(mob_templates)} enemy archetypes x {episodes} "
          f"episodes = {total_episodes} episodes\n")

    print("Top 10 by win-rate lower bound (conservative ranking):")
    for r in rankings[:10]:
        print(f"  {r['composition']:<45} mean={100*r['mean_win_rate']:5.1f}%  "
              f"95% CI=[{100*r['ci_lo']:5.1f},{100*r['ci_hi']:5.1f}]%  spec={r['specialization']:.3f}")

    top_half = rankings[:max(1, len(rankings) // 2)]
    print("\nMost generalist among the top half by win rate (low variance across archetypes):")
    for r in sorted(top_half, key=lambda r: r["specialization"])[:5]:
        print(f"  {r['composition']:<45} mean={100*r['mean_win_rate']:5.1f}%  spec={r['specialization']:.3f}")

    print("\nMost specialist (strong vs some archetypes, weak vs others):")
    for r in sorted(rankings, key=lambda r: -r["specialization"])[:5]:
        print(f"  {r['composition']:<45} mean={100*r['mean_win_rate']:5.1f}%  spec={r['specialization']:.3f}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--policy", default="models/policy.json",
                    help="path to an rl.evolve-trained policy.json (see rl/policy_store.py); "
                         "the default weights are used if the file doesn't exist yet")
    p.add_argument("--model", default=None,
                    help="path to a MaskablePPO .zip checkpoint -- overrides --policy if given; every "
                         "checkpoint rl/train.py has produced so far is a documented dead end (see "
                         "docs/ROADMAP.md), kept only in case that path is revisited")
    p.add_argument("--episodes", type=int, default=15, help="episodes per (composition, enemy archetype) cell")
    p.add_argument("--compositions", default="30",
                    help="'all' for every 4-of-12-class multiset (C(15,4)=1365 with duplicates), "
                         "or an int to sample that many")
    p.add_argument("--seed", type=int, default=COMPOSITIONS_SEED)
    p.add_argument("--difficulty", type=float, default=1.0,
                    help="ScenarioGenerator difficulty (level ratio / enemy count), 0-1; 1.0 is the real target")
    p.add_argument("--out", default="runs/compositions.json")
    p.add_argument("--workers", type=int, default=1,
                    help="parallel processes (each its own Bun subprocess + loaded model) -- match your CPU "
                         "core count; a full --compositions all sweep is the kind of run that needs this")
    a = p.parse_args()

    archetypes = json.loads((DATA_DIR / "archetypes.json").read_text())
    class_ids_all = [c["id"] for c in archetypes["classes"]]
    mob_templates = archetypes["mob_templates"]

    rng = random.Random(a.seed)
    # La roadmap Phase 3 parle de C(15,4)=1365 multisets (duplicats autorisés), pas
    # C(12,4)=495 combinaisons. combinations_with_replacement inclut les duplicats (2x
    # même classe dans la même équipe -- déjà géré par ScenarioGenerator.DUPLICATE_CLASS_PROB).
    all_combos = list(itertools.combinations_with_replacement(class_ids_all, 4))
    combos = all_combos if a.compositions == "all" else rng.sample(all_combos, min(int(a.compositions), len(all_combos)))

    if a.workers <= 1:
        matrix = _run_chunk(a.model, a.policy, combos, mob_templates, a.episodes, a.seed, a.difficulty, 0)
    else:
        chunks = [combos[i::a.workers] for i in range(a.workers)]
        matrix = {}
        with ProcessPoolExecutor(max_workers=a.workers) as pool:
            futures = [pool.submit(_run_chunk, a.model, a.policy, chunk, mob_templates, a.episodes, a.seed,
                                    a.difficulty, i)
                       for i, chunk in enumerate(chunks) if chunk]
            for future in as_completed(futures):
                matrix.update(future.result())

    rankings = rank_compositions(matrix)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps({"matrix": matrix, "rankings": rankings}, indent=2))
    print_report(combos, mob_templates, a.episodes, rankings)
    print(f"\nFull matrix + rankings written to {a.out}")


if __name__ == "__main__":
    main()
