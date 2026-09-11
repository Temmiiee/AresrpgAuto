"""Lookahead layer : évalue les K meilleures actions candidates en simulant chacune un pas
en avant via le bridge, puis retient celle dont l'état résultant a la meilleure valeur
heuristique.

Porté depuis AresRPGBot's packages/bot/src/lookahead.ts, restructuré pour l'interface
step-by-step de ce projet (un action par env.step au lieu d'un tour entier par appel).

Pourquoi c'est utile :
  scored_decide.py choisit l'action au plus haut score immédiat, sans voir ce qui se
  passe après. Deux problèmes classiques :
  (a) Un sort puissant qui tue un ennemi faible peut être moins utile qu'un sort modéré
      qui tue l'ennemi le plus dangereux (focus-fire par HP restant, pas par efficacité
      brute).
  (b) Un move_to peut ouvrir/fermer des angles d'attaque que le scorer statique ignore.
  Le lookahead résout (a) directement — après avoir appliqué une action offensive, l'état
  résultant reflète la mort éventuelle de la cible, les HP restants des alliés, etc.

Interface :
  choose_action_index(env, policy, top_k=5) → int
  Drop-in replacement pour scored_decide.choose_action_index. Utilise le même
  env.bridge pour simuler (pas de Bun subprocess supplémentaire).

Limites :
  - Horizon = 1 pas (une action). Un vrai MCTS irait plus loin (Phase 4).
  - La valeur heuristique est intentionnellement simple (ratio HP) pour ne pas introduire
    de biais difficiles à calibrer avant que la politique de base soit elle-même validée.
  - Le bridge ne supporte pas de snapshot/restore d'état : on doit reset après chaque
    simulation candidate, ce qui coûte une requête bridge supplémentaire par action
    explorée. top_k=5 ajoute ~5 requêtes/step ; acceptable pour l'évolution (pas du
    RL temps-réel).

Usage dans evolve.py :
  from rl.lookahead import choose_action_index as lookahead_choose
  handle.step(lookahead_choose(handle, policy, top_k=5))
"""
from __future__ import annotations
from .scored_decide import (
    choose_action_index as _scored_choose,
    _priority_weight,
    _element_bonus,
    HEAL_THRESHOLD,
    ELEMENT_RES_KEY,
)
from .spell_catalog import castable_spells
from .policy import DEFAULT_POLICY
from .env import _int

# Nombre de candidats à simuler par défaut.
# 5 couvre bien l'espace intéressant sans multiplier le coût bridge de façon excessive.
DEFAULT_TOP_K = 5


# ---------------------------------------------------------------------------
# Valeur heuristique d'un état de combat (après simulation d'une action)
# ---------------------------------------------------------------------------

def _state_value(state: dict, my_team: int) -> float:
    """Valeur heuristique d'un état terminal ou intermédiaire, du point de vue de `my_team`.

    Retourne un float dans [-1, +∞) :
      +1000  : victoire immédiate (all enemies dead / winner == my_team)
      -1000  : défaite immédiate
      sinon  : (hp_fraction_allies) - (hp_fraction_enemies)
               ∈ [-1, +1], positif si l'équipe est en bonne santé relative.

    La valeur HP relative est suffisamment informative pour trier K candidats sans
    introduire un biais apprenant qui devrait lui-même être calibré.
    """
    if state.get("ended"):
        winner = state.get("winner")
        if winner == my_team:
            return 1000.0
        if winner is not None:
            return -1000.0
        return 0.0  # match nul / timeout

    allies  = [f for f in state["fighters"] if f["team"] == my_team     and not f["dead"]]
    enemies = [f for f in state["fighters"] if f["team"] != my_team     and not f["dead"]]

    if not enemies:
        return 1000.0  # tous les ennemis sont morts — victoire
    if not allies:
        return -1000.0  # tous les alliés sont morts — défaite

    ally_hp  = sum(f["hp"] / max(1, f["max_hp"]) for f in allies)  / len(allies)
    enemy_hp = sum(f["hp"] / max(1, f["max_hp"]) for f in enemies) / len(enemies)
    return ally_hp - enemy_hp


# ---------------------------------------------------------------------------
# Scoring statique (repris de scored_decide, sans effet de bord)
# ---------------------------------------------------------------------------

def _score_action(action: dict, state: dict, policy, turn_fighter: dict,
                  fighters_by_cell: dict, rank_of: dict, n_enemies: int,
                  spells_by_name: dict) -> float | None:
    """Score statique d'une action, identique à scored_decide.choose_action_index.
    Retourne None si l'action n'est pas attaquable/supportable par la politique.
    """
    my_team = turn_fighter["team"]
    cell = action.get("target_cell")
    target = fighters_by_cell.get(_int(cell)) if cell is not None else None

    if action["type"] == "weapon_strike":
        if target is None or target["team"] == my_team:
            return None
        rank = rank_of.get(target["id"], n_enemies)
        return (policy.strike_bias
                + _priority_weight(rank, policy.priority_decay)
                + policy.finish_weight * (1 - target["hp"] / max(1, target["max_hp"])))

    if action["type"] == "cast_spell":
        spell = spells_by_name.get(action["spell"])
        if spell is None:
            return None
        if spell["role"] == "damage":
            if target is None or target["team"] == my_team:
                return None
            rank = rank_of.get(target["id"], n_enemies)
            return (policy.base_weight * spell["score"] * _priority_weight(rank, policy.priority_decay)
                    + policy.finish_weight * (1 - target["hp"] / max(1, target["max_hp"]))
                    + _element_bonus(spell, target, policy.element_weight))
        if spell["role"] == "support" and spell["is_heal"]:
            if target is None or target["team"] != my_team:
                return None
            frac = target["hp"] / max(1, target["max_hp"])
            if frac >= HEAL_THRESHOLD:
                return None
            deficit = 1 - frac
            return (policy.base_weight * spell["score"] + policy.heal_weight) * deficit
        if spell["role"] == "support":
            return policy.base_weight * spell["score"]

    return None  # move_to, end_turn — pas scorable statiquement


# ---------------------------------------------------------------------------
# Lookahead principal
# ---------------------------------------------------------------------------

class _SimHandle:
    """Wrapper minimal autour d'un bridge (AresBridge ou rl/evolve.py's SimHandle) qui
    expose reset/step et préserve l'état courant avant/après simulation."""

    def __init__(self, bridge):
        self.bridge = bridge
        self.state: dict = {}
        self.actions: list = []

    def _request(self, payload: dict) -> dict:
        return self.bridge.request(payload)

    def restore(self, setup: dict, seed: int) -> None:
        """Recharge le combat à son état initial (setup + seed) — utilisé pour revenir
        à l'état courant après avoir simulé un candidat."""
        r = self._request({"op": "reset", "setup": setup, "seed": seed})
        if not r["ok"]:
            raise RuntimeError(f"lookahead restore failed: {r}")
        self.state = r["state"]
        self.actions = r["actions"]

    def apply_action(self, action: dict) -> dict:
        """Applique une action et retourne l'état résultant (ne modifie pas self)."""
        r = self._request({"op": "step", "action": action})
        next_state = r.get("state") or self.state
        return next_state


def choose_action_index(env, policy=DEFAULT_POLICY, top_k: int = DEFAULT_TOP_K) -> int:
    """Choisit l'action à jouer via lookahead à 1 pas.

    Algorithme :
      1. Scorer toutes les actions disponibles avec scored_decide's formule statique.
      2. Garder les top_k meilleures (ou moins s'il y en a moins de scorables).
      3. Pour chaque candidat, simuler l'action dans le bridge et évaluer l'état résultant
         avec _state_value.
      4. Retenir l'action menant au meilleur état; restaurer le bridge à l'état courant.
      5. Si aucun candidat ne score (pas d'ennemi/allié accessible), déléguer à
         scored_decide (qui fera un move_toward ou end_turn).

    `env` doit exposer .actions, .state et .bridge (SimHandle ou AresFightEnv).
    """
    actions = env.actions
    state   = env.state

    # Cas dégénérés : tour de mob (actions vide) ou fin de combat.
    if not actions or state.get("ended"):
        return 0

    turn_fighter = next((f for f in state["fighters"] if f["id"] == state["turn"]), None)
    if turn_fighter is None or turn_fighter["kind"] != "player":
        return 0

    my_team = turn_fighter["team"]
    living_enemies = [f for f in state["fighters"] if f["team"] != my_team and not f["dead"]]
    enemies_by_priority = sorted(living_enemies, key=lambda f: f["hp"])
    rank_of = {f["id"]: i for i, f in enumerate(enemies_by_priority)}
    fighters_by_cell = {f["cell"]: f for f in state["fighters"] if not f["dead"]}

    spells_by_name = {s["name"]: s for s in castable_spells(
        turn_fighter["classe"],
        turn_fighter["level"],
        spell_levels=turn_fighter.get("spell_levels") or None,
    )}

    # --- Étape 1 : score statique de chaque action ---
    scored: list[tuple[float, int]] = []
    for i, action in enumerate(actions):
        s = _score_action(action, state, policy, turn_fighter,
                          fighters_by_cell, rank_of, len(enemies_by_priority), spells_by_name)
        if s is not None:
            scored.append((s, i))

    if not scored:
        # Rien d'attaquable/supportable : déléguer à scored_decide pour le fallback
        # (move_toward ou end_turn).
        return _scored_choose(env, policy)

    # --- Étape 2 : top-K candidats par score statique ---
    scored.sort(key=lambda t: -t[0])
    candidates = scored[:top_k]

    # --- Étape 3 & 4 : simulation + évaluation d'état + restauration ---
    # On a besoin du setup+seed courant pour restaurer le bridge après chaque simulation.
    # SimHandle de evolve.py n'a pas ces attributs — on les récupère depuis env si disponibles
    # (AresFightEnv les stocke dans _episode_setup/_episode_seed), sinon on ne peut pas
    # restaurer et on tombe en fallback sur le score statique pur.
    episode_setup = getattr(env, "_episode_setup", None)
    episode_seed  = getattr(env, "_episode_seed",  None)

    if episode_setup is None or episode_seed is None:
        # Pas de contexte de restauration disponible (SimHandle direct depuis evolve.py) :
        # retourner le meilleur candidat par score statique sans simuler.
        return candidates[0][1]

    bridge = env.bridge
    best_idx   = candidates[0][1]
    best_value = float("-inf")

    # Sauvegarder l'état courant via snapshot (O(1), pas de reset complet).
    # Si le bridge ne supporte pas snapshot (ancienne version), fallback reset.
    try:
        snap_id = bridge.snapshot()
        use_snapshot = True
    except Exception:
        use_snapshot = False

    for _static_score, idx in candidates:
        action = actions[idx]
        # Simuler l'action dans le bridge.
        r = bridge.request({"op": "step", "action": action})
        next_state = r.get("state") or state
        value = _state_value(next_state, my_team)

        if value > best_value:
            best_value = value
            best_idx   = idx

        # Restaurer l'état pré-simulation.
        if use_snapshot:
            restore_r = bridge.restore(snap_id)
            env.state   = restore_r["state"]
            env.actions = restore_r["actions"]
        else:
            # Fallback : reset complet depuis le début de l'épisode.
            restore_r = bridge.request({"op": "reset", "setup": episode_setup, "seed": episode_seed})
            if restore_r["ok"]:
                env.state   = restore_r["state"]
                env.actions = restore_r["actions"]
            break  # sans snapshot, on ne peut simuler qu'un seul candidat proprement

    if use_snapshot:
        bridge.drop_snapshot(snap_id)

    return best_idx


# ---------------------------------------------------------------------------
# Variante "pure" sans bridge : utilise seulement le score statique top-K
# (utilisable depuis SimHandle où il n'y a pas de _episode_setup)
# ---------------------------------------------------------------------------

def choose_action_index_static_topk(env, policy=DEFAULT_POLICY, top_k: int = DEFAULT_TOP_K) -> int:
    """Comme choose_action_index mais sans simulation bridge : retourne simplement le
    meilleur des top-K candidats par score statique. Moins coûteux, mais ignore les effets
    réels de l'action (kills, HP restants). Utile comme baseline intermédiaire entre
    scored_decide (top-1 statique) et lookahead complet (top-K + simulation)."""
    actions = env.actions
    state   = env.state
    if not actions or state.get("ended"):
        return 0
    turn_fighter = next((f for f in state["fighters"] if f["id"] == state["turn"]), None)
    if turn_fighter is None or turn_fighter["kind"] != "player":
        return 0
    my_team = turn_fighter["team"]
    living_enemies = [f for f in state["fighters"] if f["team"] != my_team and not f["dead"]]
    enemies_by_priority = sorted(living_enemies, key=lambda f: f["hp"])
    rank_of = {f["id"]: i for i, f in enumerate(enemies_by_priority)}
    fighters_by_cell = {f["cell"]: f for f in state["fighters"] if not f["dead"]}
    spells_by_name = {s["name"]: s for s in castable_spells(
        turn_fighter["classe"], turn_fighter["level"],
        spell_levels=turn_fighter.get("spell_levels") or None,
    )}
    scored = []
    for i, action in enumerate(actions):
        s = _score_action(action, state, policy, turn_fighter,
                          fighters_by_cell, rank_of, len(enemies_by_priority), spells_by_name)
        if s is not None:
            scored.append((s, i))
    if not scored:
        return _scored_choose(env, policy)
    scored.sort(key=lambda t: -t[0])
    return scored[0][1]
