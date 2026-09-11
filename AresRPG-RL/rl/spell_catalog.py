"""Ported from AresRPGBot's packages/bot/src/spell_catalog.ts -- scores each known spell by
its authored effect divided by its AP cost (not raw magnitude), reading data/spells.json's
first invested level (the self-learned default), same as the TS version.
"""
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
_ALL_SPELLS = json.loads((DATA_DIR / "spells.json").read_text())

# aresrpg_math::spell_effect kind discriminants (DECISIONS.md's sealed list):
# 0 damage, 1 percent_life_damage, 3 punishment_damage, 4 add, 6 steal, 12(stat) hp
# target_filter: 0 none, 1 not_team(enemy only), 2 not_self, 3 not_enemy(ally/self), 4 only_caster
HP_STAT = 12

def _is_direct_damage(e):
    return e["kind"] in (0, 1, 3) or (e["kind"] == 6 and e.get("stat") == HP_STAT and e.get("turns") == 0)

def _damage_amount(level):
    return sum((e["value"] + e["value_max"]) / 2 for e in level["effects"] if _is_direct_damage(e))

def _is_support(e):
    return e["kind"] == 4 and e.get("target_filter") in (3, 4)

def _is_heal(e):
    return _is_support(e) and e.get("stat") == HP_STAT

def _support_amount(level):
    return sum((e["value"] + e["value_max"]) / 2 for e in level["effects"] if _is_support(e))

_CACHE = {}

def castable_spells(classe, level, spell_levels: dict | None = None):
    """Every spell this class knows at this level -- role splits damage (aimed at the enemy),
    support (a buff/heal aimed at an ally or self), and other (traps/utility, unused here,
    same as the TS bot).

    `spell_levels` maps spell name → invested level (1-based), matching the dict sent to the
    engine in setup["players"][i]["source"]["spell_levels"]. When provided, each spell is
    scored at its actual invested level instead of always level 1. This matters because a
    spell's AP cost and damage can change substantially across levels -- e.g. a high-unlock
    spell a level-60 character has maxed costs fewer AP and deals more damage than at level 1.
    When absent (e.g. scoring for an unknown character), falls back to levels[0].
    """
    # Cache key includes invested levels if provided (tuple of items for hashability).
    key = (classe, level, tuple(sorted(spell_levels.items())) if spell_levels else None)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    out = []
    for name, spell in _ALL_SPELLS.items():
        if spell["classe"] != classe or spell["unlock_level"] > level:
            continue
        # Use the actual invested level if known, otherwise level 1.
        invested = (spell_levels.get(name, 1) if spell_levels else 1)
        invested = max(1, min(invested, len(spell["levels"])))
        lvl_data = spell["levels"][invested - 1]

        dmg = _damage_amount(lvl_data)
        support = _support_amount(lvl_data)
        role = "damage" if dmg > 0 else "support" if support > 0 else "other"
        magnitude = dmg if role == "damage" else support if role == "support" else 0
        ap_cost = max(1, lvl_data["ap_cost"])
        # Élément dominant du sort (pour element_weight dans scored_decide.py).
        element = _dominant_element(lvl_data) if role == "damage" else None
        out.append({
            "name": name,
            "ap_cost": ap_cost,
            "role": role,
            "is_heal": any(_is_heal(e) for e in lvl_data["effects"]),
            "score": magnitude / ap_cost,  # effect per AP -- favors efficient spells
            "element": element,
        })
    _CACHE[key] = out
    return out


def _dominant_element(level: dict) -> str | None:
    """Élément portant le plus de dommage dans ce niveau de sort, ou None."""
    totals: dict[str, float] = {}
    for e in level["effects"]:
        if _is_direct_damage(e) and e.get("element"):
            elem = e["element"]
            totals[elem] = totals.get(elem, 0.0) + (e["value"] + e["value_max"]) / 2
    return max(totals, key=totals.__getitem__) if totals else None
