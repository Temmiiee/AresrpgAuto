"""A Policy is a small weight vector over tactical features, not a neural network -- ported
from AresRPGBot's packages/bot/src/policy.ts. cli_train.ts's own comment explains why this
works where this project's PPO didn't: "nobody wrote down the tradeoff numbers, the
simulator's win-rate did." See rl/evolve.py for the search that tunes it.

element_weight était absent jusqu'ici parce que bridge/server.ts n'exposait pas les
résistances élémentaires des mobs (les valeurs earth_res/fire_res/water_res/air_res) dans
le summary. C'est maintenant corrigé dans bridge/server.ts (2026-09-10) — les quatre
champs sont désormais émis pour chaque fighter (0 pour les joueurs, valeurs réelles pour
les mobs). rl/scored_decide.py utilise element_weight pour ajuster le score d'une action
offensive en fonction de la résistance du mob ciblé à l'élément de ce sort.
"""
from dataclasses import dataclass, replace

@dataclass(frozen=True)
class Policy:
    base_weight: float = 1.0      # multiplie le score damage-or-support-per-AP du sort/frappe
    priority_decay: float = 0.5   # décroissance kill-priority par rang HP : weight = 1/(rank+1)^decay
    finish_weight: float = 0.0    # récompense attaquer une cible proche de mourir (1 - hp_fraction)
    heal_weight: float = 0.0      # récompense soigner un allié blessé, pondéré par le déficit
    strike_bias: float = 0.0      # bonus/malus fixe sur la frappe d'arme (toujours disponible)
    element_weight: float = 0.0   # bonus offensif basé sur la résistance élémentaire de la cible
                                   # (port depuis AresRPGBot's element_weight, maintenant utilisable
                                   # grâce à l'extension de bridge/server.ts -- 2026-09-10)

DEFAULT_POLICY = Policy()
POLICY_KEYS = tuple(DEFAULT_POLICY.__dataclass_fields__.keys())

def clamp_policy(p: Policy) -> Policy:
    return Policy(
        base_weight=max(0.0, p.base_weight),
        priority_decay=max(0.0, min(3.0, p.priority_decay)),
        finish_weight=max(0.0, p.finish_weight),
        heal_weight=max(0.0, p.heal_weight),
        strike_bias=p.strike_bias,
        element_weight=max(0.0, p.element_weight),
    )
