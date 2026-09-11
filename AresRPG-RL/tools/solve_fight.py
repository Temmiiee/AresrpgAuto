"""Solver exact : étant donné un état de combat concret, retourne la meilleure action,
la ligne recommandée complète, la probabilité de victoire estimée, des alternatives,
et une explication tactique générée depuis les événements réels du simulateur.

Remplace le stub Phase 4 original.

Usage :
    # Depuis un setup JSON (ex. généré par ScenarioGenerator)
    python -m tools.solve_fight --setup fight.json --seed 42

    # Avec Beam Search complet + value network
    python -m tools.solve_fight --setup fight.json --value models/value_net.pt --depth 4

    # Juste la meilleure action immédiate (scored_decide, rapide)
    python -m tools.solve_fight --setup fight.json --mode greedy

Architecture :
    Trois modes de résolution, du plus rapide au plus précis :
      greedy    : scored_decide seul (1 inférence, ~0ms)
      lookahead : top-K + simulation 1 pas (K steps bridge, ~50ms)
      beam      : Beam Search + value network (voir rl/beam_search.py, ~0.5-2s)

    L'explication est générée à partir des events réels retournés par le bridge
    (damage_number, fighter_died, etc.) — jamais hallucinée.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.beam_search import BeamResult, beam_search
from rl.beam_search import _obs_from_state
from rl.bridge import AresBridge
from rl.lookahead import choose_action_index as lookahead_choose
from rl.policy import DEFAULT_POLICY
from rl.policy_store import load_trained_policy
from rl.scored_decide import choose_action_index as scored_choose
from rl.value import ValueNet, load_value_net


# ---------------------------------------------------------------------------
# Moteur d'explication textuelle
# ---------------------------------------------------------------------------

def _action_label(action: dict, state: dict) -> str:
    """Décrit une action en langage naturel depuis sa structure dict."""
    atype = action.get("type", "?")
    if atype == "end_turn":
        return "end turn"
    if atype == "move_to":
        path = action.get("path", [])
        n = len(path)
        cell = path[-1] if path else "?"
        return f"move to cell {cell} ({n} tile{'s' if n != 1 else ''})"
    if atype == "cast_spell":
        spell = action.get("spell", "?")
        cell  = action.get("target_cell", "?")
        return f"cast {spell} on cell {cell}"
    if atype == "weapon_strike":
        cell = action.get("target_cell", "?")
        return f"weapon strike on cell {cell}"
    return atype


def _fighter_label(fighter_id: int, state: dict) -> str:
    """Retourne un label lisible pour un fighter par son id (index)."""
    fighters = state.get("fighters", [])
    if 0 <= fighter_id < len(fighters):
        f = fighters[fighter_id]
        name  = f.get("name", f"fighter#{fighter_id}")
        team  = "ally" if f.get("team") == 0 else "enemy"
        hp    = f.get("hp", "?")
        maxhp = f.get("max_hp", "?")
        return f"{name} ({team}, {hp}/{maxhp} HP)"
    return f"fighter#{fighter_id}"


def _explain_events(events: list[dict], state_before: dict) -> list[str]:
    """Traduit une liste d'events bridge en phrases d'explication.

    Seuls les events significatifs pour l'utilisateur sont traduits :
    damage_number, fighter_died, spell_missed.
    """
    from rl.env import _int

    lines: list[str] = []
    for ev in events:
        etype   = ev.get("type", "")
        payload = ev.get("payload", {})
        if etype == "damage_number":
            src    = _int(payload.get("source", -1))
            tgt    = _int(payload.get("target", -1))
            amount = _int(payload.get("amount",  0))
            src_l  = _fighter_label(src, state_before)
            tgt_l  = _fighter_label(tgt, state_before)
            lines.append(f"  {src_l} dealt {amount} damage to {tgt_l}")
        elif etype == "fighter_died":
            fid = _int(payload.get("fighter", -1))
            lines.append(f"  {_fighter_label(fid, state_before)} died")
        elif etype == "spell_missed":
            fid  = _int(payload.get("fighter", -1))
            name = payload.get("spell", "?")
            lines.append(f"  {_fighter_label(fid, state_before)} missed {name}")
    return lines


def _explain_line(
    bridge: AresBridge,
    initial_state: dict,
    initial_actions: list,
    line: list[dict],
    initial_snap_id: int,
) -> list[str]:
    """Rejoue la ligne d'actions dans le bridge pour collecter les events réels,
    et produit une explication étape par étape.

    Restaure le bridge à initial_snap_id après la simulation.
    """
    explanation: list[str] = []
    bridge.restore(initial_snap_id)
    current_state = initial_state

    for step_i, action in enumerate(line):
        label = _action_label(action, current_state)
        explanation.append(f"Step {step_i + 1}: {label}")
        r = bridge.request({"op": "step", "action": action})
        events = r.get("events", [])
        ev_lines = _explain_events(events, current_state)
        explanation.extend(ev_lines)
        current_state = r.get("state") or current_state
        if current_state.get("ended"):
            winner = current_state.get("winner")
            explanation.append(
                f"  → Combat ended: {'victory' if winner == 0 else 'defeat'}"
            )
            break

    bridge.restore(initial_snap_id)
    return explanation


# ---------------------------------------------------------------------------
# Wrappers d'env minimal pour les modes greedy/lookahead
# (évite d'instancier AresFightEnv complet avec ScenarioGenerator)
# ---------------------------------------------------------------------------

class _BridgeEnv:
    """Wrapper minimal exposant .bridge/.state/.actions pour scored_decide et lookahead."""

    def __init__(self, bridge: AresBridge, state: dict, actions: list):
        self.bridge  = bridge
        self.state   = state
        self.actions = actions


# ---------------------------------------------------------------------------
# Solver principal
# ---------------------------------------------------------------------------

def solve_fight(
    setup:          dict,
    seed:           int,
    policy=None,
    value_net:      "ValueNet | None" = None,
    mode:           str = "beam",
    depth:          int = 3,
    beam_width:     int = 5,
    branch_factor:  int = 3,
    n_alternatives: int = 3,
    with_explanation: bool = True,
) -> dict:
    """Résout un combat depuis un setup dict (tel que retourné par ScenarioGenerator).

    Retourne un dict :
    {
      "best_action":    dict          — action à jouer immédiatement
      "best_action_idx": int
      "best_line":      list[dict]    — ligne recommandée complète
      "win_prob":       float         — P(victoire) ∈ [0, 1]
      "alternatives":   list[dict]    — top-N autres lignes
      "explanation":    list[str]     — explication étape par étape (si with_explanation)
      "mode":           str
      "state":          dict          — état initial du combat
    }
    """
    if policy is None:
        policy = DEFAULT_POLICY

    bridge = AresBridge()
    try:
        # Initialiser le combat.
        r = bridge.request({"op": "reset", "setup": setup, "seed": seed})
        if not r["ok"]:
            raise RuntimeError(f"reset failed: {r}")

        state   = r["state"]
        actions = r["actions"]
        env     = _BridgeEnv(bridge, state, actions)

        if not actions or state.get("ended"):
            return {
                "best_action": None, "best_action_idx": 0,
                "best_line": [], "win_prob": 0.5,
                "alternatives": [], "explanation": [],
                "mode": mode, "state": state,
            }

        # Snapshot de l'état initial pour l'explication.
        initial_snap = bridge.snapshot()

        # --- Résolution selon le mode ---
        if mode == "greedy":
            idx  = scored_choose(env, policy)
            result = BeamResult(
                best_action_idx=idx,
                best_line=[actions[idx]] if idx < len(actions) else [],
                win_prob=0.5,
                alternatives=[],
            )

        elif mode == "lookahead":
            # Expose _episode_setup/_episode_seed pour que lookahead puisse restaurer.
            env._episode_setup = setup
            env._episode_seed  = seed
            idx = lookahead_choose(env, policy)
            result = BeamResult(
                best_action_idx=idx,
                best_line=[actions[idx]] if idx < len(actions) else [],
                win_prob=0.5,
                alternatives=[],
            )
            # Restaurer l'état après que lookahead l'ait modifié.
            bridge.restore(initial_snap)
            env.state   = state
            env.actions = actions

        else:  # beam (default)
            result = beam_search(
                env,
                policy=policy,
                value_net=value_net,
                depth=depth,
                beam_width=beam_width,
                branch_factor=branch_factor,
                n_alternatives=n_alternatives,
            )

        best_idx    = result.best_action_idx
        best_action = actions[best_idx] if best_idx < len(actions) else None
        best_line   = result.best_line
        win_prob    = result.win_prob

        # --- Explication ---
        explanation: list[str] = []
        if with_explanation and best_line:
            explanation = _explain_line(
                bridge, state, actions, best_line, initial_snap
            )

        bridge.drop_snapshot(initial_snap)

        return {
            "best_action":     best_action,
            "best_action_idx": best_idx,
            "best_line":       best_line,
            "win_prob":        win_prob,
            "alternatives":    result.alternatives,
            "explanation":     explanation,
            "mode":            mode,
            "state":           state,
        }

    finally:
        bridge.close()


# ---------------------------------------------------------------------------
# Rapport lisible
# ---------------------------------------------------------------------------

def print_report(result: dict) -> None:
    state    = result["state"]
    win_prob = result["win_prob"]
    mode     = result["mode"]

    print(f"\n{'='*60}")
    print(f"AresRPG Fight Solver  [mode={mode}]")
    print(f"{'='*60}")

    # État résumé
    fighters = state.get("fighters", [])
    allies   = [f for f in fighters if f["team"] == 0]
    enemies  = [f for f in fighters if f["team"] != 0]
    print(f"\nFighters — round {state.get('round', 0)}")
    for f in allies:
        hp_bar = "█" * int(10 * f["hp"] / max(1, f["max_hp"]))
        print(f"  [ally]  {f.get('name','?'):12s} lv{f['level']:2d}  "
              f"{hp_bar:<10s} {f['hp']:4d}/{f['max_hp']}")
    for f in enemies:
        hp_bar = "█" * int(10 * f["hp"] / max(1, f["max_hp"]))
        print(f"  [enemy] {f.get('name','?'):12s} lv{f['level']:2d}  "
              f"{hp_bar:<10s} {f['hp']:4d}/{f['max_hp']}")

    # Recommandation
    print(f"\nWin probability : {100*win_prob:.1f}%")
    best = result.get("best_action")
    if best:
        label = _action_label(best, state)
        print(f"Best action     : {label}")

    # Ligne complète
    line = result.get("best_line", [])
    if len(line) > 1:
        print(f"\nRecommended line ({len(line)} steps):")
        for i, a in enumerate(line):
            print(f"  {i+1}. {_action_label(a, state)}")

    # Alternatives
    alts = result.get("alternatives", [])
    if alts:
        print(f"\nAlternatives:")
        for alt in alts:
            label = _action_label(alt["action"], state)
            print(f"  {label}  →  {100*alt['win_prob']:.1f}%")

    # Explication
    exp = result.get("explanation", [])
    if exp:
        print(f"\nExplanation:")
        for line_txt in exp:
            print(line_txt)

    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(
        description="Résout un combat AresRPG et explique la meilleure ligne.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemples :
  # Générer un setup puis le résoudre
  python -c "
from rl.scenarios import ScenarioGenerator; import json
s = ScenarioGenerator(seed=1); print(json.dumps(s.setup()))
" > fight.json
  python -m tools.solve_fight --setup fight.json

  # Avec value network
  python -m tools.solve_fight --setup fight.json --value models/value_net.pt --depth 4

  # Mode rapide sans simulation
  python -m tools.solve_fight --setup fight.json --mode greedy
""",
    )
    p.add_argument("--setup",  required=True,
                   help="fichier JSON du setup de combat (ScenarioGenerator.setup())")
    p.add_argument("--seed",   type=int, default=1,
                   help="seed moteur pour reproduire le combat exact")
    p.add_argument("--policy", default="models/policy.json")
    p.add_argument("--value",  default=None,
                   help="chemin vers value_net.pt (optionnel, améliore Beam Search)")
    p.add_argument("--mode",   choices=["greedy", "lookahead", "beam"], default="beam")
    p.add_argument("--depth",  type=int, default=3,
                   help="profondeur Beam Search en décisions joueur")
    p.add_argument("--beam-width",    type=int, default=5)
    p.add_argument("--branch-factor", type=int, default=3)
    p.add_argument("--alternatives",  type=int, default=3)
    p.add_argument("--no-explanation", action="store_true")
    p.add_argument("--json", action="store_true",
                   help="sortie brute en JSON plutôt que rapport lisible")
    a = p.parse_args()

    setup = json.loads(Path(a.setup).read_text())

    policy_path = Path(a.policy)
    policy = load_trained_policy(policy_path) if policy_path.exists() else DEFAULT_POLICY
    if not policy_path.exists():
        print(f"[warn] policy {a.policy} not found, using DEFAULT_POLICY", file=sys.stderr)

    value_net = None
    if a.value:
        value_path = Path(a.value)
        if value_path.exists():
            value_net = load_value_net(value_path)
            print(f"[info] value network loaded from {a.value}", file=sys.stderr)
        else:
            print(f"[warn] value net {a.value} not found, using heuristic fallback",
                  file=sys.stderr)

    result = solve_fight(
        setup=setup, seed=a.seed,
        policy=policy, value_net=value_net,
        mode=a.mode, depth=a.depth,
        beam_width=a.beam_width, branch_factor=a.branch_factor,
        n_alternatives=a.alternatives,
        with_explanation=not a.no_explanation,
    )

    if a.json:
        # Sérialiser proprement (les dicts action contiennent des valeurs potentiellement
        # non-sérialisables — on les convertit en str).
        def _safe(obj: Any) -> Any:
            if isinstance(obj, dict):
                return {k: _safe(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_safe(v) for v in obj]
            try:
                json.dumps(obj)
                return obj
            except (TypeError, ValueError):
                return str(obj)
        print(json.dumps(_safe(result), indent=2))
    else:
        print_report(result)


if __name__ == "__main__":
    main()
