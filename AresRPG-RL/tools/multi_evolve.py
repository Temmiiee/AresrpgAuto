"""Lance N runs de rl.evolve en parallèle avec des seeds différents et conserve le
meilleur résultat validé sur un ensemble held-out commun.

Chaque run utilise un --seed distinct (seed, seed+1, ..., seed+N-1) et un checkpoint
indépendant. Une fois tous les runs terminés, on compare leur held-out fitness et on
copie le meilleur vers --out (même logique que rl.evolve le fait run par run, mais ici
on choisit le meilleur parmi N tentatives — cheap insurance contre l'overfitting d'un
run unique à ~40 min/run, exactement comme recommandé dans docs/ROADMAP.md).

Usage :
    python -m tools.multi_evolve --runs 4 --generations 8 --population 10 --scenarios 8
"""
import argparse
import json
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _run_one(run_idx: int, base_seed: int, args_passthrough: list[str], checkpoint_dir: Path) -> dict:
    """Exécuté dans un sous-process : lance un rl.evolve complet et retourne ses
    métadonnées de résultat. Chaque run écrit sa policy dans un fichier temporaire
    dédié (ou ne sauvegarde pas si la validation échoue)."""
    seed = base_seed + run_idx
    out_path = checkpoint_dir / f"policy_run{run_idx}.json"
    ckpt_path = checkpoint_dir / f"checkpoint_run{run_idx}.json"

    cmd = [
        sys.executable, "-m", "rl.evolve",
        "--seed", str(seed),
        "--holdout-seed", str(seed + 1_000_000),  # holdout toujours disjoint du seed d'entraînement
        "--out", str(out_path),
        "--checkpoint", str(ckpt_path),
    ] + args_passthrough

    print(f"[run {run_idx}] starting: seed={seed}  out={out_path}", flush=True)
    result = subprocess.run(cmd, capture_output=False, text=True)

    meta = {
        "run_idx": run_idx,
        "seed": seed,
        "out_path": str(out_path),
        "returncode": result.returncode,
        "holdout_improvement": None,
        "holdout_fitness": None,
    }
    if out_path.exists():
        try:
            data = json.loads(out_path.read_text())
            meta["holdout_improvement"] = data.get("holdout_improvement")
            meta["holdout_fitness"] = data.get("holdout_fitness")
        except Exception:
            pass
    return meta


def main() -> None:
    p = argparse.ArgumentParser(
        description="Lance N rl.evolve en parallèle et garde le meilleur résultat validé.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    # Options propres à multi_evolve
    p.add_argument("--runs", type=int, default=3,
                   help="nombre de runs parallèles (chacun avec un --seed différent)")
    p.add_argument("--base-seed", type=int, default=20260901,
                   help="seed du premier run ; les suivants utilisent base_seed+1, base_seed+2, ...")
    p.add_argument("--out", default="models/policy.json",
                   help="destination finale du meilleur policy validé")
    p.add_argument("--work-dir", default="runs/multi_evolve",
                   help="répertoire de travail pour les fichiers temporaires par run")
    p.add_argument("--max-parallel", type=int, default=0,
                   help="runs simultanés max (0 = autant que --runs, limité par les CPUs)")

    # Tout le reste est transmis mot pour mot à rl.evolve
    p.add_argument("--generations", type=int, default=8)
    p.add_argument("--population", type=int, default=10)
    p.add_argument("--scenarios", type=int, default=8)
    p.add_argument("--elites", type=int, default=4)
    p.add_argument("--runs-per-eval", type=int, default=3)
    p.add_argument("--mutation-std", type=float, default=0.35)
    p.add_argument("--difficulty", type=float, default=0.3)
    p.add_argument("--holdout-scenarios", type=int, default=8)
    p.add_argument("--holdout-runs", type=int, default=8)
    p.add_argument("--min-holdout-improvement", type=float, default=1.0)
    a = p.parse_args()

    work_dir = Path(a.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    # Arguments passés tels quels à rl.evolve (tout sauf --runs/--base-seed/--out/--work-dir/--max-parallel)
    passthrough = [
        "--generations", str(a.generations),
        "--population", str(a.population),
        "--scenarios", str(a.scenarios),
        "--elites", str(a.elites),
        "--runs-per-eval", str(a.runs_per_eval),
        "--mutation-std", str(a.mutation_std),
        "--difficulty", str(a.difficulty),
        "--holdout-scenarios", str(a.holdout_scenarios),
        "--holdout-runs", str(a.holdout_runs),
        "--min-holdout-improvement", str(a.min_holdout_improvement),
    ]

    max_workers = a.max_parallel if a.max_parallel > 0 else a.runs
    results = []

    print(f"Launching {a.runs} runs (max {max_workers} parallel)...\n", flush=True)
    with ProcessPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(_run_one, i, a.base_seed, passthrough, work_dir): i
            for i in range(a.runs)
        }
        for future in as_completed(futures):
            meta = future.result()
            results.append(meta)
            status = (f"holdout_improvement={meta['holdout_improvement']:+.2f}  "
                      f"holdout_fitness={meta['holdout_fitness']:.2f}"
                      if meta["holdout_improvement"] is not None
                      else "no validated policy saved")
            print(f"[run {meta['run_idx']}] done  rc={meta['returncode']}  {status}", flush=True)

    print("\n--- Summary ---")
    validated = [r for r in results if r["holdout_improvement"] is not None
                 and r["holdout_improvement"] >= a.min_holdout_improvement]

    if not validated:
        print(f"No run produced a validated policy (min_holdout_improvement={a.min_holdout_improvement:.2f}).")
        print("Lower --min-holdout-improvement or run more/longer runs.")
        return

    best = max(validated, key=lambda r: r["holdout_fitness"])
    print(f"\nBest run: run {best['run_idx']}  seed={best['seed']}  "
          f"holdout_improvement={best['holdout_improvement']:+.2f}  "
          f"holdout_fitness={best['holdout_fitness']:.2f}")

    shutil.copy(best["out_path"], a.out)
    print(f"Copied to {a.out}")

    print("\nAll validated runs (sorted by held-out fitness):")
    for r in sorted(validated, key=lambda x: -x["holdout_fitness"]):
        marker = " <-- best" if r["run_idx"] == best["run_idx"] else ""
        print(f"  run {r['run_idx']}  seed={r['seed']}  "
              f"holdout_improvement={r['holdout_improvement']:+.2f}  "
              f"holdout_fitness={r['holdout_fitness']:.2f}{marker}")


if __name__ == "__main__":
    main()
