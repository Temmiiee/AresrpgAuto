"""Enregistre des combats complets en frames JSON pour les visualiser ensuite.

Équivalent Python de AresRPGBot's record_replay.ts / cli_record_replay.ts.
Chaque frame capture le board + l'état de chaque fighter (cell, hp, dead) après chaque
step. Le JSON de sortie est compatible avec le viewer HTML de AresRPGBot
(https://claude.ai/code/artifact/76ebe6c6-025f-4d18-a987-39459d388e61).

Usage :
    python -m tools.record_replay --count 5 --seed 42 --out runs/replays
    python -m tools.record_replay --policy models/policy.json --count 10
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.bridge import AresBridge
from rl.policy import DEFAULT_POLICY
from rl.policy_store import load_trained_policy
from rl.scenarios import ScenarioGenerator
from rl.scored_decide import choose_action_index

MAX_STEPS = 500  # garde-fou : un combat honnête ne dure jamais aussi longtemps


def _frame(state: dict, action_taken: dict | None = None) -> dict:
    """Une frame de replay : board + état de chaque fighter + action qui vient d'avoir lieu."""
    return {
        "round": state["round"],
        "turn": state["turn"],
        "ended": state["ended"],
        "winner": state.get("winner"),
        "board": state["board"],
        "fighters": [
            {
                "id": f["id"],
                "team": f["team"],
                "name": f["name"],
                "classe": f.get("classe"),
                "level": f["level"],
                "cell": f["cell"],
                "hp": f["hp"],
                "max_hp": f["max_hp"],
                "ap": f["ap"],
                "mp": f["mp"],
                "dead": f["dead"],
            }
            for f in state["fighters"]
        ],
        "action": action_taken,
    }


class _SimHandle:
    """Interface minimale compatible avec choose_action_index (mêmes attributs que AresFightEnv)."""
    def __init__(self, bridge: AresBridge):
        self.bridge = bridge
        self.state: dict = {}
        self.actions: list = []

    def reset(self, setup: dict, seed: int) -> None:
        r = self.bridge.request({"op": "reset", "setup": setup, "seed": seed})
        if not r["ok"]:
            raise RuntimeError(f"reset failed: {r}")
        self.state = r["state"]
        self.actions = r["actions"]

    def step(self, idx: int) -> list:
        """Effectue l'action à l'index idx, renvoie les events."""
        if idx >= len(self.actions):
            return []
        action = self.actions[idx]
        r = self.bridge.request({"op": "step", "action": action})
        self.state = r["state"]
        self.actions = r["actions"]
        return r.get("events", []), action


def record_fight(handle: _SimHandle, setup: dict, seed: int, policy) -> dict:
    """Enregistre un combat complet en frames. Retourne le dict replay JSON."""
    handle.reset(setup, seed)
    frames = [_frame(handle.state, action_taken=None)]  # snapshot initial avant le tour 1

    steps = 0
    while not handle.state["ended"] and steps < MAX_STEPS:
        idx = choose_action_index(handle, policy)
        if idx >= len(handle.actions):
            # Aucune action valide (ex : mid mob-turn) — avancer quand même
            if handle.actions:
                idx = 0
            else:
                break
        action = handle.actions[idx]
        events, _ = handle.step(idx)
        frames.append(_frame(handle.state, action_taken=action))
        steps += 1

    fighters_end = handle.state.get("fighters", [])
    allies = [f for f in fighters_end if f["team"] == 0]
    won = handle.state.get("winner") == 0

    return {
        "seed": seed,
        "won": won,
        "rounds": handle.state.get("round", 0),
        "steps": steps,
        "setup_summary": {
            "players": [p["source"]["classe"] for p in setup["players"]],
            "mob_count": len(setup["mobs"]),
        },
        "frames": frames,
    }


def main() -> None:
    p = argparse.ArgumentParser(
        description="Enregistre des combats en frames JSON pour le viewer HTML.",
    )
    p.add_argument("--count", type=int, default=5, help="nombre de combats à enregistrer")
    p.add_argument("--seed", type=int, default=20260901, help="seed du générateur de scénarios")
    p.add_argument("--difficulty", type=float, default=1.0)
    p.add_argument("--policy", default="models/policy.json",
                   help="policy évolutive ; DEFAULT_POLICY utilisée si le fichier n'existe pas")
    p.add_argument("--out", default="runs/replays",
                   help="répertoire de sortie ; chaque combat → replay_<N>.json")
    a = p.parse_args()

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    policy_path = Path(a.policy)
    policy = load_trained_policy(policy_path) if policy_path.exists() else DEFAULT_POLICY
    if policy_path.exists():
        print(f"Using trained policy from {a.policy}")
    else:
        print(f"Policy file {a.policy} not found — using DEFAULT_POLICY")

    gen = ScenarioGenerator(seed=a.seed, difficulty=a.difficulty)
    bridge = AresBridge()
    handle = _SimHandle(bridge)

    wins = 0
    try:
        for i in range(a.count):
            setup = gen.setup()
            fight_seed = a.seed + i
            replay = record_fight(handle, setup, fight_seed, policy)
            wins += int(replay["won"])

            out_path = out_dir / f"replay_{i:04d}.json"
            out_path.write_text(json.dumps(replay, indent=2))

            classes = "+".join(replay["setup_summary"]["players"])
            print(f"  [{i+1}/{a.count}] {'WIN' if replay['won'] else 'loss'}  "
                  f"rounds={replay['rounds']}  steps={replay['steps']}  "
                  f"team={classes}  -> {out_path.name}")
    finally:
        bridge.close()

    print(f"\nRecorded {a.count} fights: {wins} wins ({100*wins/a.count:.0f}%)")
    print(f"Replays written to {out_dir}/")
    print("Load any replay_*.json into the AresRPGBot HTML viewer to visualize.")


if __name__ == "__main__":
    main()
