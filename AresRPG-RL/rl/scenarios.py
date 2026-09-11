import json, random
from pathlib import Path
from collections import defaultdict

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
BASE_HP = 50       # CONTRACT_CONSTANTS.base_hp in @aresrpg/fight
HP_PER_LEVEL = 5   # CONTRACT_CONSTANTS.hp_per_level

# ---------------------------------------------------------------------------
# Classification des classes par rôle, dérivée des données de sorts.
# Utilisée par l'archetype coverage (ARCHETYPE_PROB) pour garantir que le
# générateur explore des compositions thématiques variées au-delà du pur hasard.
# ---------------------------------------------------------------------------

def _classify_classes(spells: dict) -> dict[str, list[str]]:
    """Retourne un dict {role → [class_ids]} dérivé des données de sorts.

    Règles (calibrées sur les 12 classes connues, iyashi=healer pur, tokei/shugo=support) :
      healer    : ≥ 5 sorts de heal — seul iyashi qualifie (8 heals)
      tank      : 0 sort de heal, ≥ 5 sorts de pur support — shugo, tokei
      dps       : le reste (incluant les semi-healers asobi/ikari/etc. qui sont
                  principalement offensifs avec quelques heals situationnels)

    Cette classification reflète la réalité du gameplay AresRPG : la seule vraie classe
    "healer" est iyashi, les tanks purs sont shugo/tokei, tout le reste est avant tout DPS.
    """
    HP_STAT = 12

    def is_heal(e):
        return e["kind"] == 4 and e.get("target_filter") in (3, 4) and e.get("stat") == HP_STAT

    def is_damage(e):
        return e["kind"] in (0, 1, 3) or (
            e["kind"] == 6 and e.get("stat") == HP_STAT and e.get("turns", 1) == 0
        )

    def is_support(e):
        return e["kind"] == 4 and e.get("target_filter") in (3, 4)

    counts: dict[str, dict[str, int]] = defaultdict(lambda: {"heal": 0, "support": 0, "dmg": 0})
    for sp in spells.values():
        cls = sp["classe"]
        first = sp["levels"][0]
        if any(is_heal(e) for e in first["effects"]):
            counts[cls]["heal"] += 1
        elif any(is_damage(e) for e in first["effects"]):
            counts[cls]["dmg"] += 1
        elif any(is_support(e) for e in first["effects"]):
            counts[cls]["support"] += 1

    roles: dict[str, list[str]] = {"healer": [], "tank": [], "dps": []}
    for cls, c in counts.items():
        if c["heal"] >= 5:
            roles["healer"].append(cls)
        elif c["heal"] == 0 and c["support"] >= 5:
            roles["tank"].append(cls)
        else:
            roles["dps"].append(cls)
    return roles

# Characteristic points: the real per-class cost ladders live in AresRPG's
# characteristic_costs.move (e.g. an "ikari" spends 3-5 capital per strength point
# depending on how much it already has); replicating that plus its per-level capital
# grant is out of scope here. This is a simpler stand-in that still makes level and
# class visibly matter instead of every character sharing flat stats: `points_per_level`
# capital points a level, mostly poured into the class's primary_stat (see
# tools/build_content.py — derived from DECISIONS.md's element->stat primaries), some
# into wisdom (dodge), the rest spread across the remaining offensive stats.
STAT_BASE = 10
POINTS_PER_LEVEL = 5
PRIMARY_SHARE = 0.5
WISDOM_SHARE = 0.2

def _stat_block(primary_stat, level):
    points = POINTS_PER_LEVEL * max(0, level - 1)
    stats = {"strength": STAT_BASE, "intelligence": STAT_BASE, "chance": STAT_BASE,
              "agility": STAT_BASE, "wisdom": STAT_BASE}
    stats[primary_stat] += round(points * PRIMARY_SHARE)
    stats["wisdom"] += round(points * WISDOM_SHARE)
    others = [s for s in ("strength", "intelligence", "chance", "agility") if s != primary_stat]
    share = points * (1 - PRIMARY_SHARE - WISDOM_SHARE) / len(others)
    for s in others:
        stats[s] += round(share)
    return stats

def _spell_levels(class_spells, level):
    # DECISIONS.md (AresRPG repo, 2026-08-09): "1 spell point granted per character
    # level from 2; raising n->n+1 costs n points -- Dofus 1.29 exact". Points go to
    # the earliest-unlocked spells first, mirroring how a real character would have
    # had the most time to invest in those.
    points = max(0, level - 1)
    unlocked = sorted((s for s in class_spells if s["unlock_level"] <= level), key=lambda s: s["unlock_level"])
    levels = {}
    for spell in unlocked:
        cur, cap = 1, len(spell["levels"])
        while points >= cur and cur < cap:
            points -= cur
            cur += 1
        levels[spell["name"]] = cur
    return levels

def _bigintify(value):
    """Suffix every integer leaf with 'n' so bridge/server.ts decodes it as BigInt.
    Required for mob templates: create_mob_snapshot() does raw bigint arithmetic
    on them before the normal (number-tolerant) normalize_* pass runs."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return f"{value}n"
    if isinstance(value, list):
        return [_bigintify(v) for v in value]
    if isinstance(value, dict):
        return {k: _bigintify(v) for k, v in value.items()}
    return value

def _mob_scalar_for_level(template, requested_level):
    """Mirrors mob_scalar_for_level() in @aresrpg/fight create.ts."""
    low, high = template["level_min"], template["level_max"]
    level = min(max(requested_level, low), high)
    span = high - low
    if span == 0:
        return 0
    return ((level - low) * 100 + span - 1) // span

class ScenarioGenerator:
    # Curriculum bounds (docs/DESIGN_NOTES.md: "start easy... increase difficulty when
    # the agent reaches a target success rate"). difficulty=1.0 is PROJECT.md's actual
    # target distribution (ratio 0.90-1.25, up to 4 mobs); difficulty=0.0 is a much
    # softer fight (weaker enemies, usually solo) to bootstrap learning before that.
    EASY_RATIO = (0.5, 0.75)
    TARGET_RATIO = (0.90, 1.25)
    TARGET_MAX_MOBS = 4
    # Player HP scales linearly (BASE_HP + HP_PER_LEVEL*level), but mob HP is
    # template/scalar-based and scales far more steeply -- the old code split the
    # "total mob level" budget across `n` mobs with no per-mob cap, so a low n draw
    # (n=1 happens ~1/3 to ~1/2 of the time) could dump the *entire* budget onto one
    # mob. Measured 2026-09-01: at difficulty=1.0, 76% of scenarios had total mob HP
    # exceed total team HP, and 11% had a single mob alone outweigh the whole team's
    # HP pool -- a simple heuristic policy (attack-the-weakest) still won 17-27% of
    # games despite this, but a from-scratch RL policy never won once across 800+
    # episodes, and this is a large part of why. Cap any one mob's level at this
    # multiple of the team's strongest member instead.
    MOB_LEVEL_CAP_RATIO = 1.2
    # docs/DESIGN_NOTES.md's Phase 3 vision: "four distinct classes, duplicate classes,
    # double-DPS, double-support, no-healer, no-frontline... must be as valid a target as"
    # a balanced team. random.sample can never draw the same class twice, so every scenario
    # this generator ever produced (training or research) was silently distinct-classes-only
    # until this existed -- not implemented anywhere in this project before 2026-09-02.
    DUPLICATE_CLASS_PROB = 0.25
    # Probability a scenario uses a forced archetype composition (double-DPS, double-support,
    # no-healer, no-frontline) rather than random sampling. These edge cases are exactly the
    # ones pure random sampling under-represents -- e.g. a no-healer team only appears by
    # chance ~(8/12)^4 ≈ 19% of the time, and double-DPS only when two DPS classes both land
    # in the 4-class draw. 0.15 means ~15% of scenarios are explicitly archetype-forced,
    # covering these blind spots without overwhelming the general distribution.
    ARCHETYPE_PROB = 0.15

    def __init__(self, seed=12345, difficulty=1.0):
        self.r = random.Random(seed)
        self.d = json.loads((DATA_DIR / "archetypes.json").read_text())
        self.spells = json.loads((DATA_DIR / "spells.json").read_text())
        self._roles = _classify_classes(self.spells)
        self.set_difficulty(difficulty)

    def set_difficulty(self, difficulty):
        self.difficulty = min(1.0, max(0.0, difficulty))

    def _archetype_team(self) -> list[dict] | None:
        """Tire une équipe archétypique parmi les patterns sous-représentés par le tirage
        aléatoire pur. Retourne None si aucun pattern réalisable avec les classes disponibles.

        Patterns disponibles (choisis uniformément au hasard parmi ceux faisables) :
          double_dps      : 2+ DPS (10 classes sur 12), pas de healer
          no_healer       : 4 DPS ou tanks, aucun healer
          no_frontline    : équipe sans DPS pur — healer(s) + tank(s) seulement
          healer_heavy    : 2 healers + 2 quelconques (test équipe double-heal)
          tank_heavy      : 2 tanks + 2 DPS (test équipe double-support)
          all_dps         : 4 DPS (max pression offensive, pas de sustain)
        """
        by_id = {c["id"]: c for c in self.d["classes"]}
        healers  = self._roles["healer"]
        tanks    = self._roles["tank"]
        dps      = self._roles["dps"]
        all_ids  = [c["id"] for c in self.d["classes"]]
        non_heal = dps + tanks  # pas de healer

        patterns = []
        if len(dps) >= 2:            patterns.append("double_dps")
        if len(non_heal) >= 4:       patterns.append("no_healer")
        if len(healers) + len(tanks) >= 4: patterns.append("no_frontline")
        if len(healers) >= 2:        patterns.append("healer_heavy")
        if len(tanks) >= 2:          patterns.append("tank_heavy")
        if len(dps) >= 4:            patterns.append("all_dps")

        if not patterns:
            return None

        def pick(pool: list[str], k: int) -> list[str]:
            if len(pool) >= k:
                return list(self.r.sample(pool, k))
            result = list(pool)
            while len(result) < k:
                result.append(self.r.choice(pool))
            return result

        pattern = self.r.choice(patterns)

        if pattern == "double_dps":
            dps2   = pick(dps, 2)
            others = [c for c in all_ids if c not in dps2]
            fill   = pick(others or all_ids, 2)
            chosen_ids = dps2 + fill
        elif pattern == "no_healer":
            chosen_ids = pick(non_heal, 4)
        elif pattern == "no_frontline":
            pool = healers + tanks
            chosen_ids = pick(pool, 4)
        elif pattern == "healer_heavy":
            h2     = pick(healers, 2)
            others = [c for c in all_ids if c not in h2]
            fill   = pick(others or all_ids, 2)
            chosen_ids = h2 + fill
        elif pattern == "tank_heavy":
            t2     = pick(tanks, 2)
            fill   = pick(dps or all_ids, 2)
            chosen_ids = t2 + fill
        elif pattern == "all_dps":
            chosen_ids = pick(dps, 4)
        else:
            return None

        self.r.shuffle(chosen_ids)
        return [by_id[cid] for cid in chosen_ids]

    def _pick_mob_template(self, level):
        templates = self.d["mob_templates"]
        overlapping = [t for t in templates if t["level_min"] <= level <= t["level_max"]]
        pool = overlapping or templates
        return min(pool, key=lambda t: abs(level - min(max(level, t["level_min"]), t["level_max"])))

    def _class_spells(self, classe):
        return [dict(sp, name=name) for name, sp in self.spells.items() if sp["classe"] == classe]

    def setup(self,class_ids=None,mob_template=None):
        """class_ids: force this exact 4 class ids instead of sampling randomly (Phase 3
        composition research needs to fix the team and vary the enemy/seed, not the other
        way around). mob_template: force every mob in the fight to this one template dict
        (from archetypes.json's mob_templates) instead of nearest-level lookup, so a
        composition can be benchmarked against one enemy archetype at a time."""
        d=self.difficulty
        lo=self.EASY_RATIO[0]+(self.TARGET_RATIO[0]-self.EASY_RATIO[0])*d
        hi=self.EASY_RATIO[1]+(self.TARGET_RATIO[1]-self.EASY_RATIO[1])*d
        max_mobs=max(1,round(1+(self.TARGET_MAX_MOBS-1)*d))
        if class_ids is not None:
            by_id={c["id"]:c for c in self.d["classes"]}
            classes=[by_id[cid] for cid in class_ids]
        elif self.r.random() < self.ARCHETYPE_PROB:
            arch = self._archetype_team()
            classes = arch if arch is not None else self.r.sample(self.d["classes"], 4)
        elif self.r.random()<self.DUPLICATE_CLASS_PROB:
            classes=[self.r.choice(self.d["classes"]) for _ in range(4)]  # with replacement -- duplicates allowed
        else:
            classes=self.r.sample(self.d["classes"],4)
        class_ids={c["id"] for c in classes}
        base=self.r.randint(10,60)
        levels=[max(1,base+self.r.randint(-20,20)) for _ in range(4)]
        team_total=sum(levels)
        ratio=self.r.uniform(lo,hi)
        total=max(4,round(team_total*ratio))
        n=self.r.randint(1,max_mobs)
        levels_m=[1]*n
        mob_level_cap=max(1,round(max(levels)*self.MOB_LEVEL_CAP_RATIO))
        for _ in range(total-n):
            eligible=[j for j in range(n) if levels_m[j]<mob_level_cap]
            if not eligible: break  # budget capped out; the fight is simply easier than the nominal ratio implies
            levels_m[self.r.choice(eligible)]+=1
        players=[]
        for i,(c,lvl) in enumerate(zip(classes,levels)):
            stats=_stat_block(c["primary_stat"],lvl)
            spell_levels=_spell_levels(self._class_spells(c["id"]),lvl)
            players.append({
                "character":f"0xc{i+1}","owner":f"0xa{i+1}",
                "team":0,"ready":True,"hp":f"{BASE_HP + HP_PER_LEVEL*lvl}n",
                "source":{"name":f"c{i+1}","classe":c["id"],"level":f"{lvl}n",
                  "strength":f"{stats['strength']}n","intelligence":f"{stats['intelligence']}n",
                  "chance":f"{stats['chance']}n","agility":f"{stats['agility']}n",
                  "wisdom":f"{stats['wisdom']}n","vitality":"0n",
                  "experience":"0n","spell_levels":{k:f"{v}n" for k,v in spell_levels.items()},
                  "folded_stats":{},"weapon":None}
            })
        mobs=[]
        for lvl in levels_m:
            template=mob_template if mob_template is not None else self._pick_mob_template(lvl)
            scalar=_mob_scalar_for_level(template,lvl)
            wire_template=_bigintify({k:v for k,v in template.items() if k!="name"})
            mobs.append({"team":1,"scalar":f"{scalar}n","template":wire_template})
        # Names only, not full definitions -- the bridge process caches the full catalog
        # once at startup (AresBridge sends "load_spells"), since re-sending every
        # unlocked spell's full definition every reset was ~330KB, ~93% of the payload.
        spell_names=[name for name,sp in self.spells.items() if sp["classe"] in class_ids]
        return {"fight_id":"rl","world":"local","board_seed":self.r.randint(1,1000000),
                "players":players,"mobs":mobs,"spell_names":spell_names}
