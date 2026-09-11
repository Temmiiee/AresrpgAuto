"""Beam Search guidé par politique + value network.

Combine la politique évolutive (rl/scored_decide.py) pour le guidage et le value network
(rl/value.py) pour l'évaluation des nœuds feuilles. Utilise les ops snapshot/restore du
bridge (rl/bridge.py) pour explorer des branches sans reset complet.

Architecture de recherche :
  - Guidage : la politique score chaque action candidate, on ne garde que les
    beam_width * branch_factor meilleures pour limiter la largeur de l'arbre.
  - Évaluation : chaque nœud feuille est évalué par value_net(obs) = P(victoire).
    Si aucun value_net n'est fourni, fallback sur _state_value() de lookahead.py
    (heuristique HP-ratio — moins précise, mais utilisable sans modèle entraîné).
  - Terminaison : un nœud terminal (état ended=True) obtient +1.0 ou 0.0 directement,
    pas besoin du réseau.
  - Profondeur : horizon en nombre de *décisions de l'équipe joueur*, pas en steps bruts
    (les steps de mob ne comptent pas). À profondeur 3, on explore jusqu'à 3 actions de
    joueur en avant.

Résultat :
  BeamResult(
    best_action_idx : int         — index dans env.actions à jouer maintenant
    best_line       : list[dict]  — séquence d'actions recommandée (dicts action)
    win_prob        : float       — P(victoire) estimée depuis l'état courant
    alternatives    : list[...]   — top-N autres lignes avec leur win_prob
  )

Usage :
  from rl.beam_search import beam_search, BeamResult
  result = beam_search(env, policy, value_net, depth=3, beam_width=5)
  env.step(result.best_action_idx)

Notes de performance :
  Chaque nœud de l'arbre = 1 step bridge + 1 inférence réseau.
  À depth=3, beam_width=5, branch_factor=3 : jusqu'à 5*3 + 15*3 + 45 = 90 steps bridge.
  Sur un bridge à ~130 steps/sec, ~0.7s par décision. Acceptable pour un solver offline ;
  trop lent pour guider l'évolution step-by-step (utiliser scored_decide à la place).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from .env import _int, OBS_SIZE
from .lookahead import _score_action, _state_value, _score_action
from .policy import DEFAULT_POLICY
from .scored_decide import choose_action_index as scored_choose
from .spell_catalog import castable_spells

if TYPE_CHECKING:
    from .bridge import AresBridge
    from .policy import Policy
    from .value import ValueNet


# ---------------------------------------------------------------------------
# Structures de données
# ---------------------------------------------------------------------------

@dataclass
class BeamNode:
    """Un nœud dans l'arbre Beam Search."""
    state:       dict             # état bridge courant
    actions:     list             # actions légales dans cet état
    obs:         np.ndarray       # vecteur d'observation correspondant
    snap_id:     int | None       # snapshot bridge pour restaurer ce nœud
    value:       float            # P(victoire) estimée (terminal: 1.0/0.0, feuille: net/heuristic)
    line:        list[dict]       # séquence d'actions menant ici depuis la racine
    depth:       int              # nombre de décisions joueur jusqu'ici


@dataclass
class BeamResult:
    """Résultat d'un Beam Search depuis un état donné."""
    best_action_idx: int           # index dans env.actions à jouer immédiatement
    best_line:       list[dict]    # ligne recommandée complète (actions dicts)
    win_prob:        float         # P(victoire) estimée depuis l'état courant
    alternatives:   list[dict]    = field(default_factory=list)
    # alternatives : [{"action": dict, "line": [...], "win_prob": float}, ...]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _obs_from_state(state: dict) -> np.ndarray:
    """Reconstruit le vecteur d'observation depuis un état bridge.
    Même logique que AresFightEnv._obs(), dupliquée ici pour éviter l'import circulaire
    avec env.py (qui importe bridge.py). Doit rester strictement synchronisé.
    """
    import json
    from pathlib import Path
    from .env import _CLASS_IDX, N_CLASSES

    x = np.zeros(OBS_SIZE, dtype=np.float32)
    k = 0
    board = state["board"]
    turn  = state["turn"]
    MAX_FIGHTERS = 8
    MAX_AP = 12
    MAX_MP = 6

    for f in state["fighters"][:MAX_FIGHTERS]:
        cls_idx = _CLASS_IDX.get(f.get("classe"), -1)
        cls_enc = (cls_idx / max(1, N_CLASSES - 1)) if cls_idx >= 0 else -1.0
        for v in (f["team"], float(f["id"] == turn), f["level"] / 100,
                  (f["cell"] % board["grid_w"]) / board["grid_w"],
                  (f["cell"] // board["grid_w"]) / board["grid_h"],
                  f["hp"] / max(1, f["max_hp"]), f["ap"] / MAX_AP, f["mp"] / MAX_MP,
                  float(f["dead"]), f["effects"] / 10, f["cooldowns"] / 10,
                  cls_enc):
            if k < OBS_SIZE:
                x[k] = float(np.clip(float(v) * 2 - 1, -1, 1))
                k += 1
    if k < OBS_SIZE:
        x[k] = float(np.clip(state["round"] / 100 * 2 - 1, -1, 1))
    return x


def _evaluate_node(node: BeamNode, value_net: "ValueNet | None", my_team: int) -> float:
    """Évalue la valeur d'un nœud (P victoire depuis cet état)."""
    state = node.state
    # Terminaux : résultat exact, pas besoin du réseau.
    if state.get("ended"):
        winner = state.get("winner")
        if winner == my_team:
            return 1.0
        if winner is not None:
            return 0.0
        return 0.5  # draw / timeout

    enemies = [f for f in state["fighters"] if f["team"] != my_team and not f["dead"]]
    allies  = [f for f in state["fighters"] if f["team"] == my_team  and not f["dead"]]
    if not enemies: return 1.0
    if not allies:  return 0.0

    if value_net is not None:
        import torch
        value_net.eval()
        with torch.no_grad():
            t = torch.tensor(node.obs, dtype=torch.float32).unsqueeze(0)
            return float(value_net(t).item())

    # Fallback heuristique : mapper [-1, +1] → [0, 1]
    hp_score = _state_value(state, my_team)  # ∈ [-1, +1]
    return (hp_score + 1.0) / 2.0


def _top_k_actions(actions: list, state: dict, policy: "Policy",
                   k: int) -> list[tuple[float, int]]:
    """Retourne les k meilleures actions scorées par la politique (score, idx)."""
    turn_fighter = next((f for f in state["fighters"] if f["id"] == state["turn"]), None)
    if turn_fighter is None or turn_fighter["kind"] != "player":
        return []

    my_team = turn_fighter["team"]
    living_enemies = [f for f in state["fighters"] if f["team"] != my_team and not f["dead"]]
    enemies_sorted = sorted(living_enemies, key=lambda f: f["hp"])
    rank_of = {f["id"]: i for i, f in enumerate(enemies_sorted)}
    fighters_by_cell = {f["cell"]: f for f in state["fighters"] if not f["dead"]}
    spells = {s["name"]: s for s in castable_spells(
        turn_fighter["classe"], turn_fighter["level"],
        spell_levels=turn_fighter.get("spell_levels") or None,
    )}

    scored: list[tuple[float, int]] = []
    for i, action in enumerate(actions):
        s = _score_action(action, state, policy, turn_fighter,
                          fighters_by_cell, rank_of, len(enemies_sorted), spells)
        if s is not None:
            scored.append((s, i))

    # Inclure end_turn (index 0) si rien d'autre n'est scorable, pour éviter les deadlocks.
    if not scored:
        scored = [(0.0, 0)]

    scored.sort(key=lambda t: -t[0])
    return scored[:k]


# ---------------------------------------------------------------------------
# Beam Search principal
# ---------------------------------------------------------------------------

def beam_search(
    env,
    policy:      "Policy | None"    = None,
    value_net:   "ValueNet | None"  = None,
    depth:       int                = 3,
    beam_width:  int                = 5,
    branch_factor: int              = 3,
    n_alternatives: int             = 3,
) -> BeamResult:
    """Beam Search guidé par politique + value network depuis l'état courant de env.

    Paramètres :
      depth          : horizon en nombre de décisions joueur (pas en steps bruts)
      beam_width     : nombre de nœuds conservés par niveau
      branch_factor  : nombre d'actions candidates par nœud (tirées de la politique)
      n_alternatives : nombre d'alternatives retournées dans BeamResult

    Contraintes :
      - env doit exposer .bridge (AresBridge), .state, .actions, .obs (ou _obs()).
        AresFightEnv et les wrappers compatibles sont OK.
      - Le bridge doit supporter snapshot/restore (bridge/server.ts v2026-09-10+).
      - L'état bridge n'est PAS modifié en sortie : tous les snapshots explorés sont
        libérés avant de retourner.
    """
    if policy is None:
        policy = DEFAULT_POLICY

    bridge   = env.bridge
    state    = env.state
    actions  = env.actions
    my_team  = 0  # l'équipe joueur est toujours team=0

    # Aucune action ou combat terminé.
    if not actions or state.get("ended"):
        return BeamResult(best_action_idx=0, best_line=[], win_prob=0.5)

    turn_fighter = next((f for f in state["fighters"] if f["id"] == state["turn"]), None)
    if turn_fighter is None or turn_fighter["kind"] != "player":
        return BeamResult(best_action_idx=0, best_line=[], win_prob=0.5)

    # Snapshot de la racine — on y reviendra pour libérer l'état bridge à la fin.
    root_snap = bridge.snapshot()
    root_obs  = _obs_from_state(state)

    # Initialiser le beam avec les branch_factor meilleures actions depuis la racine.
    root_candidates = _top_k_actions(actions, state, policy, branch_factor)
    beam: list[BeamNode] = []
    all_snap_ids: list[int] = [root_snap]

    for _score, idx in root_candidates:
        action = actions[idx]
        r = bridge.request({"op": "step", "action": action})
        next_state   = r.get("state") or state
        next_actions = r.get("actions", [])
        next_obs     = _obs_from_state(next_state)
        snap = bridge.snapshot()
        all_snap_ids.append(snap)

        node = BeamNode(
            state=next_state, actions=next_actions, obs=next_obs,
            snap_id=snap, value=0.0, line=[action], depth=1,
        )
        beam.append(node)
        # Revenir à la racine pour explorer le prochain candidat.
        bridge.restore(root_snap)

    # Expansion niveau par niveau.
    for level in range(1, depth):
        next_beam: list[BeamNode] = []
        for node in beam:
            # Restaurer le bridge à ce nœud.
            bridge.restore(node.snap_id)

            if node.state.get("ended") or not node.actions:
                # Nœud terminal ou sans actions — garder tel quel.
                next_beam.append(node)
                continue

            # Ne développer que si c'est un tour joueur.
            turn_f = next((f for f in node.state["fighters"] if f["id"] == node.state["turn"]), None)
            if turn_f is None or turn_f["kind"] != "player":
                # Tour de mob — avancer d'un step sans brancher.
                r = bridge.request({"op": "step", "action": node.actions[0]})
                updated = BeamNode(
                    state=r.get("state") or node.state,
                    actions=r.get("actions", []),
                    obs=_obs_from_state(r.get("state") or node.state),
                    snap_id=bridge.snapshot(),
                    value=node.value,
                    line=node.line,
                    depth=node.depth,
                )
                all_snap_ids.append(updated.snap_id)
                next_beam.append(updated)
                continue

            # Tour joueur : brancher sur les branch_factor meilleures actions.
            node_snap = bridge.snapshot()
            all_snap_ids.append(node_snap)
            candidates = _top_k_actions(node.actions, node.state, policy, branch_factor)

            for _s, idx in candidates:
                action = node.actions[idx]
                r = bridge.request({"op": "step", "action": action})
                child_state   = r.get("state") or node.state
                child_actions = r.get("actions", [])
                child_obs     = _obs_from_state(child_state)
                child_snap    = bridge.snapshot()
                all_snap_ids.append(child_snap)

                child = BeamNode(
                    state=child_state, actions=child_actions, obs=child_obs,
                    snap_id=child_snap, value=0.0,
                    line=node.line + [action], depth=node.depth + 1,
                )
                next_beam.append(child)
                bridge.restore(node_snap)

        # Évaluer tous les nœuds du niveau et garder les beam_width meilleurs.
        for node in next_beam:
            node.value = _evaluate_node(node, value_net, my_team)
        next_beam.sort(key=lambda n: -n.value)
        beam = next_beam[:beam_width]

    # Évaluation finale des feuilles du beam.
    for node in beam:
        node.value = _evaluate_node(node, value_net, my_team)
    beam.sort(key=lambda n: -n.value)

    # Libérer tous les snapshots accumulés.
    for snap_id in all_snap_ids:
        bridge.drop_snapshot(snap_id)

    # Restaurer l'état original (root).
    bridge.restore(root_snap)
    env.state   = state
    env.actions = actions

    if not beam:
        return BeamResult(best_action_idx=0, best_line=[], win_prob=0.5)

    best = beam[0]
    # L'action immédiate est le premier élément de la ligne du meilleur nœud.
    first_action = best.line[0] if best.line else actions[0]
    # Retrouver son index dans env.actions.
    best_action_idx = next(
        (i for i, a in enumerate(actions) if a == first_action), 0
    )

    # Construire les alternatives (lignes avec une première action différente de best).
    seen_first = {id(first_action)}
    alternatives: list[dict] = []
    for node in beam[1:]:
        if not node.line:
            continue
        fa = node.line[0]
        if id(fa) in seen_first:
            continue
        seen_first.add(id(fa))
        alt_idx = next((i for i, a in enumerate(actions) if a == fa), None)
        if alt_idx is not None:
            alternatives.append({
                "action":    fa,
                "action_idx": alt_idx,
                "line":      node.line,
                "win_prob":  node.value,
            })
        if len(alternatives) >= n_alternatives:
            break

    return BeamResult(
        best_action_idx=best_action_idx,
        best_line=best.line,
        win_prob=best.value,
        alternatives=alternatives,
    )
