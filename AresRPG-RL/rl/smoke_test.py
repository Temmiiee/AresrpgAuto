"""Smoke test rapide : démarrer le bridge, ping, reset + un step.

Lancer depuis la racine du repo avec ARES_RPG_ROOT positionné :
    python -m rl.smoke_test
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.bridge import AresBridge
from rl.scenarios import ScenarioGenerator


def main():
    print("Starting AresBridge...")
    bridge = AresBridge()
    try:
        print("Ping  ->", bridge.request({"op": "ping"}))

        gen = ScenarioGenerator(seed=1)
        setup = gen.setup()
        resp = bridge.request({"op": "reset", "setup": setup, "seed": 1})
        print("Reset -> ok =", resp["ok"], "| fighters =", len(resp["state"]["fighters"]))

        actions = resp["actions"]
        if actions:
            step_resp = bridge.request({"op": "step", "action": actions[0]})
            print("Step  -> ok =", step_resp["ok"])
        else:
            print("Step  -> no actions available (fight already ended?)")
    finally:
        bridge.close()


if __name__ == "__main__":
    main()
