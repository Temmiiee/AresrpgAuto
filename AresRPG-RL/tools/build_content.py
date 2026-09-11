"""Pull real classes/spells/mobs from an AresRPG checkout into data/.

data/archetypes.json and data/spells.json previously held fabricated
placeholder content (fake class ids, a fake mob, an invented HP formula).
This script replaces them with content read straight from the AresRPG
seed catalog, per CONTRIBUTING.md rule 1 (never reimplement combat rules)
and rule 2 (pin the AresRPG commit used).

Usage:
    python tools/build_content.py --root /path/to/aresrpg
"""
import argparse
import json
import os
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

RES_KEYS = ("earth", "fire", "water", "air")

# DECISIONS.md (AresRPG repo, 2026-08-11): "Primaries map strength->earth,
# intelligence->fire, chance->water, agility->air (4 elements, no neutral)".
ELEMENT_STAT = {"earth": "strength", "fire": "intelligence", "water": "chance", "air": "agility"}


def commit_of(root: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def primary_stat_of(class_spells: list[dict]) -> str:
    # kind 0 is plain elemental damage (EFFECT_KINDS.damage in move_contract.gen.ts);
    # only that kind's element feeds fight_math.ts's primary_stat() damage-amplification
    # lookup, so it's the cleanest signal — other kinds (shields, steals, buffs) also
    # carry an element field but scale differently or not at all.
    counts = Counter()
    for spell in class_spells:
        for level in spell["levels"]:
            for effect in level["effects"] + level["crit_effects"]:
                if effect.get("kind") != 0:
                    continue
                stat = ELEMENT_STAT.get(effect.get("element"))
                if stat:
                    counts[stat] += 1
    return counts.most_common(1)[0][0] if counts else "wisdom"


def load_classes(spells: list[dict]) -> list[dict]:
    by_class: dict[str, list[dict]] = defaultdict(list)
    for spell in spells:
        by_class[spell["classe"]].append(spell)
    # primary_stat is a scenario-generation input (which raw stat this class leans on
    # when we build a character), not a rule the fight engine enforces or reimplements.
    return [{"id": classe, "primary_stat": primary_stat_of(class_spells)} for classe, class_spells in sorted(by_class.items())]


def build_spells(spells: list[dict]) -> dict:
    # SpellSource shape (classe, unlock_level, levels[]) matches the seed
    # entries field-for-field; only the outer list->dict-by-name changes.
    return {s["name"]: {"classe": s["classe"], "unlock_level": s["unlock_level"], "levels": s["levels"]} for s in spells}


def mob_template(mob: dict) -> dict:
    res = mob["resistances"]
    return {
        "mob_type": mob["mob_type"],
        "name": mob["name"],
        "level_min": mob["level_min"],
        "level_max": mob["level_max"],
        "hp": mob["hp"],
        "ap": mob["ap"],
        "mp": mob["mp"],
        "agility": mob["agility"],
        "wisdom": mob["wisdom"],
        "earth_res": res[RES_KEYS[0]],
        "fire_res": res[RES_KEYS[1]],
        "water_res": res[RES_KEYS[2]],
        "air_res": res[RES_KEYS[3]],
        "xp": mob["xp"],
        "loot": mob.get("loot", []),
        # Each real spell entry carries its own level-up progression
        # (mob.spells[i].levels[]); the fight engine's MobTemplateSource
        # wants one baseline SpellLevel per spell and scales it itself
        # across [level_min, level_max] (see mob_band_scaled in create.ts).
        # We anchor on the lowest tier (levels[0]) to match that anchor.
        "spells": [{"name": sp["name"], "level": sp["levels"][0]} for sp in mob.get("spells", []) if sp.get("levels")],
    }


def pick_mobs(mobs: list[dict], max_level: int, count: int) -> list[dict]:
    candidates = [m for m in mobs if m["level_min"] <= max_level]
    candidates.sort(key=lambda m: m["level_min"])
    step = max(1, len(candidates) // count)
    picked = candidates[::step][:count]
    return [mob_template(m) for m in picked]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.environ.get("ARES_RPG_ROOT"), help="AresRPG checkout root")
    parser.add_argument("--max-level", type=int, default=70, help="drop mobs whose level_min exceeds this")
    parser.add_argument("--mob-count", type=int, default=12, help="how many curated mob templates to keep")
    args = parser.parse_args()
    if not args.root:
        raise SystemExit("Set --root or ARES_RPG_ROOT to an AresRPG checkout")
    root = Path(args.root)

    spells_raw = json.loads((root / "seed" / "content" / "spells.json").read_text(encoding="utf-8"))
    mobs_raw = json.loads((root / "seed" / "content" / "mobs.json").read_text(encoding="utf-8"))

    archetypes = {
        "source_commit": commit_of(root),
        "classes": load_classes(spells_raw),
        "mob_templates": pick_mobs(mobs_raw, args.max_level, args.mob_count),
    }
    spells = build_spells(spells_raw)

    (DATA_DIR / "archetypes.json").write_text(json.dumps(archetypes, indent=2) + "\n", encoding="utf-8")
    (DATA_DIR / "spells.json").write_text(json.dumps(spells, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(archetypes['classes'])} classes, {len(archetypes['mob_templates'])} mobs, {len(spells)} spells")
    print(f"source commit: {archetypes['source_commit']}")


if __name__ == "__main__":
    main()
