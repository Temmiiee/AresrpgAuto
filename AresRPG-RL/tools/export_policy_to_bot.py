"""Translates a validated rl/evolve.py policy (models/policy.json) into the JSON shape
AresRPGBot's packages/bot/src/policy_store.ts expects (learned_policy.local.json), so the
live bot's fight_session.ts picks it up on its next fight. See docs/ROADMAP.md.

Only exports a policy that passed rl/evolve.py's held-out validation gate -- refuses to
export a models/policy.json missing `holdout_improvement` in its metadata, since that field
is the only signal this policy actually generalizes rather than just fitting its own
training scenarios (see docs/ROADMAP.md's account of the first, unvalidated run: +15.00 on
its own training fitness, +0.00 on held-out data).

python -m tools.export_policy_to_bot --bot-root "C:\\path\\to\\AresRPGBot\\vendor\\aresrpg-src"
"""
import argparse, json, sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run directly with `python tools/export_policy_to_bot.py`


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--policy", default="models/policy.json")
    p.add_argument("--bot-root", required=True,
                    help="path to AresRPGBot's vendored aresrpg-src checkout, e.g. "
                         "C:\\Users\\Mattheo\\Desktop\\Dev\\AresRPGBot\\vendor\\aresrpg-src")
    a = p.parse_args()

    data = json.loads(Path(a.policy).read_text())
    if "holdout_improvement" not in data:
        raise SystemExit(
            f"{a.policy} has no holdout_improvement recorded -- it wasn't saved by rl.evolve's "
            "held-out validation gate (or predates it). Re-run python -m rl.evolve so the saved "
            "policy is one that actually validated, not just a training-set result."
        )

    policy = dict(data["policy"])
    # element_weight est maintenant un champ standard de Policy (rl/policy.py, 2026-09-10),
    # donc il est présent dans toute policy sauvegardée avec la nouvelle version d'rl.evolve.
    # Pour une policy sauvegardée sous l'ancienne version (sans element_weight), on le
    # complète à 0.0 pour respecter le is_valid_policy check du TS bot.
    policy.setdefault("element_weight", 0.0)

    out_path = Path(a.bot_root) / "packages" / "bot" / "learned_policy.local.json"
    stored = {
        "policy": policy,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "generations": data.get("generations", 0),
        "fitness": data.get("holdout_fitness", data.get("fitness", 0.0)),  # the trusted, held-out number
        "matchups": [str(m) for m in data.get("matchups", [])],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(stored, indent=2))
    print(f"Exported {a.policy} -> {out_path}")
    print(f"  held-out fitness: {stored['fitness']:.2f}  generations: {stored['generations']}")
    print("  fight_session.ts will pick this up on the bot's next fight.")


if __name__ == "__main__":
    main()
