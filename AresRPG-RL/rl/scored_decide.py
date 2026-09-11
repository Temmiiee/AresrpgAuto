"""Ported from AresRPGBot's packages/bot/src/sim_decide.ts -- scores every legal action through
a Policy (rl/policy.py) instead of a fixed heuristic (rl/heuristic.py, which this supersedes
for tuning purposes but doesn't replace as a baseline).

Structural difference from the TS original: sim_decide.ts builds one WHOLE turn per call (move
+ as many casts/strikes as AP allows), using fight_geometry.ts's find_cast_cell/path_to to work
out whether a move is even needed to reach a target. AresFightEnv exposes one legal action per
env.step() instead (bridge/server.ts's candidates() already enumerates every reachable move/cast/
strike for the current decision point), so this picks the single best-scored action of THAT set
each call rather than planning a multi-action turn up front -- called once per step, same as
rl/heuristic.py, and MaskablePPO's action_masks() guarantees every legal AP-spend already
enumerated is available to choose from immediately.
"""
from .env import _int
from .movement import move_toward_nearest
from .spell_catalog import castable_spells
from .policy import DEFAULT_POLICY

HEAL_THRESHOLD = 0.8

# Mapping élément → champ de résistance dans le summary fighter (ajouté à bridge/server.ts
# le 2026-09-10). Valeurs 0-100 (pourcentage de dommage absorbé).
ELEMENT_RES_KEY = {
    "earth": "earth_res",
    "fire":  "fire_res",
    "water": "water_res",
    "air":   "air_res",
}

def _priority_weight(rank, decay):
    return 1 / (rank + 1) ** decay


def _element_bonus(spell: dict, target: dict, element_weight: float) -> float:
    """Bonus offensif lié à la faiblesse élémentaire de la cible.
    Porté depuis AresRPGBot's sim_decide.ts.

    `target[res_key]` est maintenant un entier signé en points de résistance (bridge/server.ts
    normalise les valeurs fixed-point ~32768 en soustrayant la baseline 2^15). Valeurs
    typiques : 0 = neutre, +20 = forte résistance, -10 = vulnérabilité.

    La formule : `element_weight * (1 - res/100)` où res est le pourcentage en entier.
    - res=0 (neutre) → bonus_factor = 1.0
    - res=+20 (résistant) → bonus_factor = 0.8
    - res=-10 (vulnérable) → bonus_factor = 1.1
    Plafonnement à 2× pour éviter les extrêmes si un mob a une vulnérabilité massive.
    """
    if element_weight == 0.0 or not spell.get("element"):
        return 0.0
    res_key = ELEMENT_RES_KEY.get(spell["element"])
    if res_key is None:
        return 0.0
    res = target.get(res_key, 0)  # déjà normalisé (entier signé), pas besoin de - 32768
    bonus_factor = max(0.0, min(2.0, 1.0 - res / 100.0))
    return element_weight * bonus_factor

def choose_action_index(env, policy=DEFAULT_POLICY):
    actions = env.actions
    state = env.state
    fighters_by_cell = {f["cell"]: f for f in state["fighters"] if not f["dead"]}
    turn_fighter = next((f for f in state["fighters"] if f["id"] == state["turn"]), None)
    if turn_fighter is None or turn_fighter["kind"] != "player":
        return 0

    my_team = turn_fighter["team"]
    living_enemies = [f for f in state["fighters"] if f["team"] != my_team and not f["dead"]]
    enemies_by_priority = sorted(living_enemies, key=lambda f: f["hp"])
    rank_of = {f["id"]: i for i, f in enumerate(enemies_by_priority)}

    spells_by_name = {s["name"]: s for s in castable_spells(
        turn_fighter["classe"],
        turn_fighter["level"],
        spell_levels=turn_fighter.get("spell_levels") or None,
    )}

    def finish_bonus(target):
        return policy.finish_weight * (1 - target["hp"] / max(1, target["max_hp"]))

    best_idx, best_score = None, float("-inf")
    for i, a in enumerate(actions):
        cell = a.get("target_cell")
        target = fighters_by_cell.get(_int(cell)) if cell is not None else None
        score = None
        if a["type"] == "weapon_strike" and target is not None and target["team"] != my_team:
            rank = rank_of.get(target["id"], len(enemies_by_priority))
            score = policy.strike_bias + _priority_weight(rank, policy.priority_decay) + finish_bonus(target)
        elif a["type"] == "cast_spell":
            spell = spells_by_name.get(a["spell"])
            if spell is not None:
                if spell["role"] == "damage" and target is not None and target["team"] != my_team:
                    rank = rank_of.get(target["id"], len(enemies_by_priority))
                    score = (policy.base_weight * spell["score"] * _priority_weight(rank, policy.priority_decay)
                             + finish_bonus(target)
                             + _element_bonus(spell, target, policy.element_weight))
                elif spell["role"] == "support":
                    if spell["is_heal"]:
                        # Bug, confirmed 2026-09-03 (flagged by the project owner): this used
                        # to score every heal candidate with base_weight*spell_score
                        # unconditionally, plus a heal_weight*deficit bonus computed from
                        # whichever ally was MOST wounded overall -- so a heal cast on a
                        # full-health target still scored a real positive number, and could
                        # even receive a bonus meant for a completely different, actually-
                        # wounded ally. Deficit must come from THIS action's own target, and
                        # a target that isn't actually wounded enough isn't a candidate at all
                        # (score stays None) -- matching sim_decide.ts's heal_target_cell gate.
                        # Score scales WITH deficit entirely (2026-09-03), not just the
                        # heal_weight term -- ported back from the same fix in sim_decide.ts.
                        # A target just under HEAL_THRESHOLD used to still get the FULL
                        # base_weight*spell_score, barely less than a near-dead ally would.
                        # Multiplying the whole score by deficit makes urgency scale the same
                        # way finish_bonus already scales damage-target priority.
                        if target is not None and target["team"] == my_team:
                            target_frac = target["hp"] / max(1, target["max_hp"])
                            if target_frac < HEAL_THRESHOLD:
                                deficit = 1 - target_frac
                                score = (policy.base_weight * spell["score"] + policy.heal_weight) * deficit
                    else:
                        score = policy.base_weight * spell["score"]
        if score is not None and score > best_score:
            best_score, best_idx = score, i
    if best_idx is not None:
        return best_idx

    # Nothing attackable/supportable reachable this decision -- move toward the nearest living
    # enemy, else end_turn (index 0, always present -- see bridge/server.ts's candidates()).
    move_idx = move_toward_nearest(actions, state, living_enemies)
    return move_idx if move_idx is not None else 0
