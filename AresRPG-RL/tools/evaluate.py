"""Evaluate a trained checkpoint on a frozen, held-out scenario set.

python -m tools.evaluate --model models/ppo_ares.zip --episodes 200

Training win rate is not a benchmark (see docs/DESIGN_NOTES.md): a model can look good
by memorizing quirks of the scenarios it trained on. --seed here defaults to a value far
from rl.train's default (12345) and any small --seed a user would naturally pick for
training, specifically so the two don't collide by accident. Never evaluate with the
same seed you trained with.
"""
import argparse, math, sys
from collections import defaultdict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run directly with `python tools/evaluate.py`
from sb3_contrib import MaskablePPO
from rl.env import AresFightEnv

EVAL_SEED = 999_999


def wilson_interval(wins, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = wins / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def difficulty_bucket(state):
    team_total = sum(f["level"] for f in state["fighters"] if f["team"] == 0)
    mob_total = sum(f["level"] for f in state["fighters"] if f["team"] == 1)
    ratio = mob_total / max(1, team_total)
    if ratio < 1.0:
        return "easy (enemy<team)"
    if ratio < 1.15:
        return "medium (enemy~team)"
    return "hard (enemy>team)"


def run_episode(env, model):
    obs, info = env.reset()
    bucket = difficulty_bucket(env.state)
    done = trunc = False
    steps = invalid = 0
    while not (done or trunc):
        action, _ = model.predict(obs, action_masks=env.action_masks(), deterministic=True)
        obs, reward, done, trunc, info = env.step(int(action))
        steps += 1
        if info.get("invalid"):
            invalid += 1
    ended = env.state
    allies = [f for f in ended["fighters"] if f["team"] == 0]
    hp = sum(f["hp"] for f in allies if not f["dead"])
    max_hp = sum(f["max_hp"] for f in allies if not f["dead"])
    return {
        "bucket": bucket,
        "win": int(ended.get("winner") == 0),
        "rounds": ended["round"],
        "deaths": sum(1 for f in allies if f["dead"]),
        "hp_frac": hp / max_hp if max_hp else 0.0,
        "invalid_rate": invalid / steps if steps else 0.0,
    }


def report(rows, label):
    n = len(rows)
    if n == 0:
        return
    wins = sum(r["win"] for r in rows)
    lo, hi = wilson_interval(wins, n)
    print(
        f"{label:<22} episodes={n:<5} win_rate={100 * wins / n:5.1f}% "
        f"(95% CI {100 * lo:5.1f}-{100 * hi:5.1f}%)  "
        f"avg_rounds={sum(r['rounds'] for r in rows) / n:5.1f}  "
        f"avg_deaths={sum(r['deaths'] for r in rows) / n:4.2f}  "
        f"avg_hp_remaining={100 * sum(r['hp_frac'] for r in rows) / n:5.1f}%  "
        f"invalid_rate={sum(r['invalid_rate'] for r in rows) / n:.3f}"
    )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="path to a MaskablePPO .zip checkpoint")
    p.add_argument("--episodes", type=int, default=200)
    p.add_argument("--seed", type=int, default=EVAL_SEED,
                    help="held-out scenario-generator seed; must not match any seed used for training")
    a = p.parse_args()

    env = AresFightEnv(seed=a.seed)
    model = MaskablePPO.load(a.model)
    try:
        rows = [run_episode(env, model) for _ in range(a.episodes)]
    finally:
        env.close()

    by_bucket = defaultdict(list)
    for row in rows:
        by_bucket[row["bucket"]].append(row)

    report(rows, "OVERALL")
    for bucket in sorted(by_bucket):
        report(by_bucket[bucket], bucket)


if __name__ == "__main__":
    main()
