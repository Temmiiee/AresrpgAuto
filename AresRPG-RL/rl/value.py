"""Value network : petit MLP PyTorch qui estime P(victoire) ∈ [0,1] depuis le vecteur
d'observation de AresFightEnv._obs().

Rôle dans Phase 4 :
  Le Beam Search (rl/beam_search.py) a besoin d'évaluer chaque nœud feuille sans aller
  jusqu'à la fin du combat. Le value network fournit cette estimation de façon calibrée
  (sortie sigmoid = probabilité réelle, pas un score arbitraire). Couplé à la politique
  évolutive pour le guidage, il donne un signal d'évaluation bien meilleur que la simple
  heuristique HP-ratio de rl/lookahead.py.

Architecture :
  MLP 3 couches (256 → 128 → 64 → 1), entrée = OBS_SIZE=256 floats, sortie = sigmoid.
  Entraîné par régression logistique supervisée sur des épisodes joués à la fin
  (label = 1 si l'équipe a gagné, 0 sinon). Pas de gradient RL — supervision pure.

Usage :
  # Collecter des données
  dataset = collect_value_dataset(n_episodes=5000, seed=42)

  # Entraîner
  net = train_value_net(dataset, epochs=20, out="models/value_net.pt")

  # Inférer
  net = load_value_net("models/value_net.pt")
  prob = predict_win_prob(net, obs_array)   # float ∈ [0,1]

  # CLI
  python -m rl.value --collect --episodes 5000 --out models/value_net.pt
  python -m rl.value --resume models/value_net.pt --epochs 10
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

# Chemin racine pour les imports directs
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.env import AresFightEnv, OBS_SIZE  # noqa: E402 — OBS_SIZE = 256
from rl.policy import DEFAULT_POLICY
from rl.scored_decide import choose_action_index


# ---------------------------------------------------------------------------
# Architecture
# ---------------------------------------------------------------------------

class ValueNet(nn.Module):
    """MLP léger : 256 → 128 → 64 → 1 (sigmoid).

    Intentionnellement petit : l'observation est déjà un résumé compact de l'état
    (97 floats utilisés sur 256), et on préfère éviter l'overfitting avec un petit
    dataset de départ. La capacité peut être augmentée si le dataset dépasse ~50k épisodes.
    """

    def __init__(self, obs_size: int = OBS_SIZE):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(obs_size, 128),
            nn.ReLU(),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


# ---------------------------------------------------------------------------
# Sauvegarde / chargement
# ---------------------------------------------------------------------------

def save_value_net(net: ValueNet, path: str | Path, **meta) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": net.state_dict(), "obs_size": net.net[0].in_features, **meta}, path)


def load_value_net(path: str | Path) -> ValueNet:
    ckpt = torch.load(Path(path), map_location="cpu", weights_only=True)
    net = ValueNet(obs_size=ckpt.get("obs_size", OBS_SIZE))
    net.load_state_dict(ckpt["state_dict"])
    net.eval()
    return net


# ---------------------------------------------------------------------------
# Collecte de données
# ---------------------------------------------------------------------------

def collect_value_dataset(
    n_episodes: int = 5000,
    seed: int = 42,
    difficulty: float = 1.0,
    policy=None,
    verbose: bool = True,
) -> dict:
    """Joue `n_episodes` combats et retourne un dataset supervisé.

    Retourne :
      {
        "obs":    np.ndarray [N, OBS_SIZE]  float32  — observations à chaque step
        "labels": np.ndarray [N]            float32  — 1.0 si l'équipe a fini vainqueur
        "episodes": int
        "wins": int
      }

    Chaque step du combat devient un exemple d'entraînement avec son label final.
    Les observations proches de la fin (combat décidé) sont plus informatives, mais
    inclure tous les steps donne plus de données — le réseau apprend à estimer la
    probabilité de victoire depuis des états intermédiaires variés.

    Important : seed != rl.evolve --seed (20260901) ni --holdout-seed (999_999)
    pour garder les ensembles train/val/eval distincts.
    """
    if policy is None:
        policy = DEFAULT_POLICY

    env = AresFightEnv(seed=seed)
    env.set_difficulty(difficulty)
    obs_list: list[np.ndarray] = []
    label_list: list[float] = []
    wins = 0

    try:
        for ep in range(n_episodes):
            obs, _ = env.reset()
            done = trunc = False
            episode_obs: list[np.ndarray] = []

            while not (done or trunc):
                episode_obs.append(obs.copy())
                idx = choose_action_index(env, policy)
                obs, _, done, trunc, info = env.step(idx)

            won = bool(env.state.get("winner") == 0)
            wins += int(won)
            label = 1.0 if won else 0.0
            obs_list.extend(episode_obs)
            label_list.extend([label] * len(episode_obs))

            if verbose and (ep + 1) % 250 == 0:
                wr = wins / (ep + 1)
                print(f"[collect] {ep+1}/{n_episodes}  win_rate={wr:.2f}  "
                      f"transitions={len(obs_list)}", flush=True)
    finally:
        env.close()

    return {
        "obs":      np.array(obs_list,   dtype=np.float32),
        "labels":   np.array(label_list, dtype=np.float32),
        "episodes": n_episodes,
        "wins":     wins,
    }


# ---------------------------------------------------------------------------
# Entraînement
# ---------------------------------------------------------------------------

def train_value_net(
    dataset: dict,
    epochs: int = 20,
    batch_size: int = 512,
    lr: float = 1e-3,
    val_split: float = 0.1,
    obs_size: int = OBS_SIZE,
    device: str = "auto",
    out: str | Path | None = None,
    verbose: bool = True,
) -> ValueNet:
    """Entraîne un ValueNet par régression logistique (BCE) sur `dataset`.

    Séparation train/val automatique (val_split=0.1 par défaut). Retourne le modèle
    avec la meilleure val_loss (early-stop implicite par checkpoint best).
    """
    dev = torch.device(
        "cuda" if torch.cuda.is_available() else "cpu"
        if device == "auto" else device
    )
    obs    = torch.tensor(dataset["obs"],    dtype=torch.float32)
    labels = torch.tensor(dataset["labels"], dtype=torch.float32)

    # Train/val split
    n = len(obs)
    n_val = max(1, int(n * val_split))
    perm = torch.randperm(n)
    val_idx, train_idx = perm[:n_val], perm[n_val:]

    train_ds = TensorDataset(obs[train_idx], labels[train_idx])
    val_ds   = TensorDataset(obs[val_idx],   labels[val_idx])
    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_dl   = DataLoader(val_ds,   batch_size=batch_size)

    net = ValueNet(obs_size=obs_size).to(dev)
    optimizer = optim.Adam(net.parameters(), lr=lr)
    criterion = nn.BCELoss()

    best_val_loss = float("inf")
    best_state    = None

    for epoch in range(epochs):
        # --- train ---
        net.train()
        train_loss = 0.0
        for xb, yb in train_dl:
            xb, yb = xb.to(dev), yb.to(dev)
            optimizer.zero_grad()
            pred = net(xb)
            loss = criterion(pred, yb)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * len(xb)
        train_loss /= len(train_ds)

        # --- val ---
        net.eval()
        val_loss = 0.0
        with torch.no_grad():
            for xb, yb in val_dl:
                xb, yb = xb.to(dev), yb.to(dev)
                val_loss += criterion(net(xb), yb).item() * len(xb)
        val_loss /= len(val_ds)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.cpu().clone() for k, v in net.state_dict().items()}

        if verbose:
            print(f"[value] epoch {epoch+1}/{epochs}  "
                  f"train_loss={train_loss:.4f}  val_loss={val_loss:.4f}"
                  + (" *" if val_loss == best_val_loss else ""), flush=True)

    # Restaurer le meilleur checkpoint
    if best_state is not None:
        net.load_state_dict(best_state)
    net.eval()

    if out is not None:
        save_value_net(net, out,
                       episodes=dataset["episodes"],
                       wins=dataset["wins"],
                       val_loss=best_val_loss)
        if verbose:
            print(f"[value] saved to {out}  best_val_loss={best_val_loss:.4f}")

    return net.cpu()


# ---------------------------------------------------------------------------
# Inférence
# ---------------------------------------------------------------------------

def predict_win_prob(net: ValueNet, obs: np.ndarray) -> float:
    """Estime P(victoire) depuis un vecteur d'observation (shape [OBS_SIZE]).
    Retourne un float ∈ [0, 1]."""
    net.eval()
    with torch.no_grad():
        t = torch.tensor(obs, dtype=torch.float32).unsqueeze(0)
        return float(net(t).item())


def predict_win_prob_batch(net: ValueNet, obs: np.ndarray) -> np.ndarray:
    """Estime P(victoire) pour un batch d'observations (shape [N, OBS_SIZE]).
    Retourne un np.ndarray de floats ∈ [0, 1]."""
    net.eval()
    with torch.no_grad():
        t = torch.tensor(obs, dtype=torch.float32)
        return net(t).numpy()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(
        description="Collecte et entraîne le value network (P(victoire) depuis l'état)."
    )
    p.add_argument("--collect", action="store_true",
                   help="collecter un dataset d'épisodes avant d'entraîner")
    p.add_argument("--episodes", type=int, default=5000,
                   help="nombre d'épisodes à collecter (--collect)")
    p.add_argument("--seed", type=int, default=555_555,
                   help="seed scénario — distinct de rl.evolve --seed (20260901) et --holdout-seed (999_999)")
    p.add_argument("--difficulty", type=float, default=1.0)
    p.add_argument("--policy", default="models/policy.json",
                   help="politique évolutive pour jouer les épisodes de collecte")
    p.add_argument("--dataset", default="runs/value_dataset.npz",
                   help="chemin du dataset .npz (sauvé après --collect, chargé sinon)")
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--batch-size", type=int, default=512)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--resume", default=None,
                   help="checkpoint .pt existant à continuer d'entraîner")
    p.add_argument("--out", default="models/value_net.pt")
    a = p.parse_args()

    from rl.policy_store import load_trained_policy
    policy_path = Path(a.policy)
    policy = load_trained_policy(policy_path) if policy_path.exists() else DEFAULT_POLICY
    if policy_path.exists():
        print(f"Using policy from {a.policy}")
    else:
        print(f"Policy file {a.policy} not found — using DEFAULT_POLICY")

    dataset_path = Path(a.dataset)

    if a.collect:
        print(f"Collecting {a.episodes} episodes (seed={a.seed}, difficulty={a.difficulty})...")
        dataset = collect_value_dataset(
            n_episodes=a.episodes, seed=a.seed,
            difficulty=a.difficulty, policy=policy,
        )
        dataset_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(dataset_path,
                            obs=dataset["obs"], labels=dataset["labels"])
        win_rate = dataset["wins"] / dataset["episodes"]
        print(f"Dataset: {len(dataset['obs'])} transitions, "
              f"win_rate={win_rate:.2f} → {dataset_path}")
    else:
        if not dataset_path.exists():
            raise SystemExit(
                f"{dataset_path} not found. Run with --collect first, or pass --dataset."
            )
        raw = np.load(dataset_path)
        dataset = {"obs": raw["obs"], "labels": raw["labels"],
                   "episodes": int(raw["obs"].shape[0]), "wins": 0}
        print(f"Loaded dataset: {len(dataset['obs'])} transitions from {dataset_path}")

    if a.resume and Path(a.resume).exists():
        print(f"Resuming from {a.resume}")
        net = load_value_net(a.resume)
        # Continuer l'entraînement sur le dataset chargé
        dataset_tensor = {
            "obs":      dataset["obs"],
            "labels":   dataset["labels"],
            "episodes": dataset["episodes"],
            "wins":     dataset.get("wins", 0),
        }
        train_value_net(dataset_tensor, epochs=a.epochs,
                        batch_size=a.batch_size, lr=a.lr, out=a.out)
    else:
        train_value_net(dataset, epochs=a.epochs,
                        batch_size=a.batch_size, lr=a.lr, out=a.out)


if __name__ == "__main__":
    main()
