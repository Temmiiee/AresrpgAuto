from .env import _int
from .movement import move_toward_nearest
from .spell_catalog import castable_spells


def choose_action_index(env):
    """Baseline fixe : attaquer l'ennemi vivant au plus bas HP parmi les cibles accessibles,
    en choisissant l'action la plus efficace en AP (meilleur damage/AP) lorsque plusieurs
    actions ciblent le même ennemi prioritaire. Si aucune attaque n'est accessible, se
    déplacer vers l'ennemi le plus proche, sinon end_turn (index 0).

    Rôle dans le projet :
    (1) Vérifier qu'un scénario est gagnable indépendamment de la qualité du RL.
    (2) Fournir des démonstrations behavior-cloning pour warm-starter MaskablePPO (rl/bc.py).
    (3) Servir de baseline que la politique évolutive doit dépasser.

    Correction 2026-09-10 (audit) : sélectionne maintenant par efficacité AP parmi les
    actions visant la même cible prioritaire, au lieu de prendre la première par ordre
    d'énumération. Cela réduit le bruit dans les démonstrations BC et produit un baseline
    plus cohérent.
    """
    actions = env.actions
    state = env.state
    fighters_by_cell = {f["cell"]: f for f in state["fighters"] if not f["dead"]}

    turn_fighter = next((f for f in state["fighters"] if f["id"] == state["turn"]), None)
    spell_levels = None
    if turn_fighter is not None:
        spell_levels = turn_fighter.get("spell_levels") or None

    def target_fighter(a):
        cell = a.get("target_cell")
        return fighters_by_cell.get(_int(cell)) if cell is not None else None

    def ap_efficiency(a):
        """Dommage-par-AP estimé pour une action offensive (0 si inconnu)."""
        if a["type"] == "weapon_strike":
            return 1.0  # valeur neutre : on préfèrera un sort offensif connu si disponible
        if a["type"] == "cast_spell" and turn_fighter is not None:
            spells = {s["name"]: s for s in castable_spells(
                turn_fighter["classe"],
                turn_fighter["level"],
                spell_levels=spell_levels,
            )}
            sp = spells.get(a["spell"])
            if sp is not None and sp["role"] == "damage":
                return sp["score"]  # damage/AP au niveau réel investi
        return 0.0

    # Construire la liste (idx, target_fighter) de toutes les attaques sur des ennemis.
    attacks_on_enemies = [
        (i, target_fighter(a))
        for i, a in enumerate(actions)
        if a["type"] in ("cast_spell", "weapon_strike")
        and (f := target_fighter(a)) is not None
        and f["team"] != 0
    ]

    if attacks_on_enemies:
        # Cible prioritaire = ennemi vivant au plus bas HP parmi ceux accessibles.
        lowest_hp = min(t["hp"] for _, t in attacks_on_enemies)
        attacks_on_priority = [(i, a) for i, a in attacks_on_enemies if a["hp"] == lowest_hp]
        # Parmi les actions sur cette cible, prendre celle au meilleur damage/AP.
        best_idx = max(attacks_on_priority, key=lambda ia: ap_efficiency(actions[ia[0]]))[0]
        return best_idx

    enemies = [f for f in state["fighters"] if not f["dead"] and f["team"] != 0]
    move_idx = move_toward_nearest(actions, state, enemies)
    return move_idx if move_idx is not None else 0  # end_turn est toujours index 0
