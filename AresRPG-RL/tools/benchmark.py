"""Rough benchmark : épisodes/sec et win-rate avec la politique heuristique.

python -m tools.benchmark --episodes 100
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.env import AresFightEnv
from rl.heuristic import choose_action_index as heuristic_choose


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=100)
    p.add_argument("--seed", type=int, default=12345)
    p.add_argument("--difficulty", type=float, default=1.0)
    a = p.parse_args()

    env = AresFightEnv(seed=a.seed)
    env.set_difficulty(a.difficulty)
    wins = 0
    t0 = time.time()
    try:
        for i in range(a.episodes):
            env.reset()
            done = trunc = False
            while not (done or trunc):
                idx = heuristic_choose(env)
                _, _, done, trunc, _ = env.step(idx)
            wins += int(env.state.get("winner") == 0)
            if (i + 1) % 10 == 0:
                elapsed = time.time() - t0
                eps = (i + 1) / elapsed
                print(f"  {i+1}/{a.episodes}  win_rate={100*wins/(i+1):.1f}%  {eps:.1f} eps/s",
                      flush=True)
    finally:
        env.close()

    elapsed = time.time() - t0
    print(f"\nResult: {wins}/{a.episodes} wins ({100*wins/a.episodes:.1f}%)  "
          f"{a.episodes/elapsed:.1f} eps/s  {elapsed:.1f}s total")


if __name__ == "__main__":
    main()
