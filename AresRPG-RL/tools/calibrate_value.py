"""Calibration du value network : mesure à quel point les probabilités estimées
correspondent à des fréquences de victoire réelles.

Un modèle bien calibré prédit 70% de victoire exactement dans 70% des cas où
il prédit 70%. Mal calibré → les probabilités sont trompeuses même si l'accuracy
globale est bonne.

Métriques :
  Brier score    : MSE entre prédictions et labels — ↓ mieux (0 = parfait)
  ECE            : Expected Calibration Error — ↓ mieux (0 = parfaitement calibré)
  Reliability diagram : visualisation des bins de confiance vs fréquence réelle

Usage :
  python -m tools.calibrate_value --model models/value_net.pt --episodes 1000

  # Collecter un dataset de calibration séparé puis évaluer
  python -m tools.calibrate_value --model models/value_net.pt \\
    --dataset runs/calib_dataset.npz --episodes 2000 --seed 888888
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.policy import DEFAULT_POLICY
from rl.value import ValueNet, collect_value_dataset, load_value_net, predict_win_prob_batch


# ---------------------------------------------------------------------------
# Métriques
# ---------------------------------------------------------------------------

def brier_score(probs: np.ndarray, labels: np.ndarray) -> float:
    """Mean squared error entre probabilités prédites et labels binaires.
    Plage : [0, 1]. 0 = parfait, 0.25 = random (base-rate 50%).
    """
    return float(np.mean((probs - labels) ** 2))


def expected_calibration_error(
    probs: np.ndarray, labels: np.ndarray, n_bins: int = 10
) -> tuple[float, list[dict]]:
    """ECE : erreur de calibration attendue.

    Découpe les prédictions en `n_bins` intervalles de confiance égaux et mesure
    |fréquence_réelle - confiance_moyenne| pondéré par la fraction des exemples
    dans chaque bin.

    Retourne (ece_float, bins_list) où chaque bin est :
      {"conf_mean": float, "freq": float, "count": int, "lo": float, "hi": float}
    """
    bins_data: list[dict] = []
    ece = 0.0
    n = len(probs)
    edges = np.linspace(0, 1, n_bins + 1)

    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (probs >= lo) & (probs < hi)
        if lo == edges[-2]:  # dernier bin : inclure 1.0
            mask = (probs >= lo) & (probs <= hi)
        count = int(mask.sum())
        if count == 0:
            bins_data.append({"conf_mean": (lo + hi) / 2, "freq": 0.0,
                               "count": 0, "lo": lo, "hi": hi})
            continue
        conf_mean = float(probs[mask].mean())
        freq      = float(labels[mask].mean())
        ece += (count / n) * abs(conf_mean - freq)
        bins_data.append({"conf_mean": conf_mean, "freq": freq,
                           "count": count, "lo": lo, "hi": hi})

    return ece, bins_data


def accuracy(probs: np.ndarray, labels: np.ndarray, threshold: float = 0.5) -> float:
    """Fraction de prédictions correctes (prob >= threshold ↔ label == 1)."""
    preds = (probs >= threshold).astype(float)
    return float((preds == labels).mean())


# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------

def print_calibration_report(
    probs:     np.ndarray,
    labels:    np.ndarray,
    n_bins:    int = 10,
    model_path: str = "",
) -> None:
    bs  = brier_score(probs, labels)
    acc = accuracy(probs, labels)
    ece, bins = expected_calibration_error(probs, labels, n_bins)
    win_rate = float(labels.mean())

    print(f"\n{'='*60}")
    print(f"Value Network Calibration Report")
    if model_path:
        print(f"Model   : {model_path}")
    print(f"Samples : {len(probs)}")
    print(f"Win rate (actual) : {100*win_rate:.1f}%")
    print(f"{'='*60}")
    print(f"Brier score  : {bs:.4f}  (0=perfect, 0.25=random)")
    print(f"ECE          : {ece:.4f}  (0=perfectly calibrated)")
    print(f"Accuracy     : {100*acc:.1f}%  (threshold=0.5)")
    print()
    print("Reliability diagram (confidence → actual win rate):")
    print(f"  {'Conf range':15s}  {'Count':>6s}  {'Conf mean':>9s}  "
          f"{'Actual freq':>11s}  {'Gap':>7s}  Bar")
    print(f"  {'-'*70}")
    for b in bins:
        if b["count"] == 0:
            continue
        gap     = b["conf_mean"] - b["freq"]
        bar_len = int(b["freq"] * 20)
        bar     = "█" * bar_len + "░" * (20 - bar_len)
        conf_bar_pos = int(b["conf_mean"] * 20)
        gap_sign = "+" if gap > 0 else ""
        print(f"  [{b['lo']:.2f}, {b['hi']:.2f})  "
              f"{b['count']:>6d}  "
              f"{b['conf_mean']:>9.3f}  "
              f"{b['freq']:>11.3f}  "
              f"{gap_sign}{gap:>6.3f}  "
              f"|{bar}|")
    print()

    # Diagnostics
    if ece < 0.05:
        print("✓ Well-calibrated (ECE < 0.05)")
    elif ece < 0.10:
        print("⚠ Moderately miscalibrated (ECE 0.05–0.10) — consider temperature scaling")
    else:
        print("✗ Poorly calibrated (ECE > 0.10) — retrain with more data or add calibration")

    if bs < 0.15:
        print("✓ Good Brier score (< 0.15)")
    elif bs < 0.20:
        print("⚠ Moderate Brier score (0.15–0.20)")
    else:
        print("✗ High Brier score (> 0.20) — model may not be discriminative enough")
    print()


# ---------------------------------------------------------------------------
# Sauvegarde JSON
# ---------------------------------------------------------------------------

def save_calibration_report(
    probs: np.ndarray, labels: np.ndarray, path: str | Path, n_bins: int = 10
) -> None:
    bs  = brier_score(probs, labels)
    acc = accuracy(probs, labels)
    ece, bins = expected_calibration_error(probs, labels, n_bins)
    data = {
        "n_samples": len(probs),
        "win_rate": float(labels.mean()),
        "brier_score": bs,
        "ece": ece,
        "accuracy": acc,
        "bins": bins,
    }
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2))
    print(f"Calibration report saved to {path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(
        description="Évalue la calibration du value network (ECE, Brier score, reliability diagram)."
    )
    p.add_argument("--model", required=True,
                   help="chemin vers value_net.pt")
    p.add_argument("--dataset", default=None,
                   help="dataset .npz existant (évite de recollter) ; collecte sinon")
    p.add_argument("--episodes", type=int, default=1000,
                   help="épisodes à collecter si --dataset non fourni")
    p.add_argument("--seed", type=int, default=888_888,
                   help="seed — distinct de rl.value (555_555), rl.train (12345), rl.evaluate (999_999)")
    p.add_argument("--difficulty", type=float, default=1.0)
    p.add_argument("--policy", default="models/policy.json")
    p.add_argument("--bins", type=int, default=10,
                   help="nombre de bins pour l'ECE et le reliability diagram")
    p.add_argument("--out", default=None,
                   help="sauvegarder le rapport en JSON (optionnel)")
    a = p.parse_args()

    # Charger le modèle.
    net = load_value_net(a.model)
    print(f"Loaded value network from {a.model}")

    # Dataset.
    if a.dataset and Path(a.dataset).exists():
        raw     = np.load(a.dataset)
        obs     = raw["obs"]
        labels  = raw["labels"]
        print(f"Loaded {len(obs)} samples from {a.dataset}")
    else:
        from rl.policy_store import load_trained_policy
        policy_path = Path(a.policy)
        policy = load_trained_policy(policy_path) if policy_path.exists() else DEFAULT_POLICY
        if not policy_path.exists():
            print(f"[warn] policy {a.policy} not found, using DEFAULT_POLICY", file=sys.stderr)

        print(f"Collecting {a.episodes} episodes (seed={a.seed})...")
        dataset = collect_value_dataset(
            n_episodes=a.episodes, seed=a.seed,
            difficulty=a.difficulty, policy=policy,
        )
        obs    = dataset["obs"]
        labels = dataset["labels"]

        if a.dataset:
            Path(a.dataset).parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(a.dataset, obs=obs, labels=labels)
            print(f"Dataset saved to {a.dataset}")

    # Prédictions.
    probs = predict_win_prob_batch(net, obs)

    # Rapport.
    print_calibration_report(probs, labels, n_bins=a.bins, model_path=a.model)

    if a.out:
        save_calibration_report(probs, labels, a.out, n_bins=a.bins)


if __name__ == "__main__":
    main()
