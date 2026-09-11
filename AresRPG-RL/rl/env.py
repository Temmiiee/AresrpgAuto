from collections import deque
import json
from pathlib import Path
import numpy as np
import gymnasium as gym
from gymnasium import spaces
from .bridge import AresBridge
from .scenarios import ScenarioGenerator

def _int(v):
    """Event payload numbers arrive as bigint-suffixed strings (e.g. '4n'), unlike the
    already-Number()-converted fighter/state fields in summary()."""
    return int(v[:-1]) if isinstance(v, str) and v.endswith("n") else int(v)

# Ordered list of all class ids -- used to encode class identity in _obs.
# Order is alphabetical to stay stable across content regenerations.
_DATA_DIR = Path(__file__).resolve().parents[1] / "data"
_ARCHETYPES = json.loads((_DATA_DIR / "archetypes.json").read_text())
_CLASS_IDS = sorted(c["id"] for c in _ARCHETYPES["classes"])
_CLASS_IDX = {cls: i for i, cls in enumerate(_CLASS_IDS)}
N_CLASSES = len(_CLASS_IDS)

# Module-level constant so rl/value.py and rl/beam_search.py can import it directly
# without instantiating AresFightEnv.
OBS_SIZE = 256

class AresFightEnv(gym.Env):
    # sb3-contrib's MaskableCategorical has documented float32 numerical-stability issues
    # with large masked action spaces (reported failures around ~1400 actions -- see
    # Stable-Baselines-Team/stable-baselines3-contrib#247, #221). 4096 sat well inside
    # that fragile zone for no real benefit: sampled 5741 real decision points at full
    # difficulty (2026-09-01) and the observed max legal-action count was 564, 99th
    # percentile 288 -- every RL run through that point had hit the exact-float32-zero
    # entropy collapse (see rl/train.py, rl/safety.py) regardless of every hyperparameter/
    # architecture change tried, which fits this class of bug far better than anything
    # about this project's own reward/observation/network setup. 1024 keeps a healthy
    # margin above the observed max while moving well clear of the reported threshold.
    MAX_ACTIONS=1024
    OBS_SIZE=256
    MAX_FIGHTERS=8       # scenarios.py always builds 4 players + up to 4 mobs
    MAX_AP=12
    MAX_MP=6
    MAX_EPISODE_STEPS=1000
    # docs/DESIGN_NOTES.md: "Keep a hard-fight replay pool (losses, near-losses...) and
    # replay it more often than average." A win where the team barely survived counts as
    # "near-loss" too, not just outright losses.
    NEAR_LOSS_HP_FRACTION=0.25
    def __init__(self,seed=12345,replay_ratio=0.0,replay_pool_size=50):
        super().__init__(); self.bridge=AresBridge(); self.gen=ScenarioGenerator(seed)
        self.observation_space=spaces.Box(-1,1,(self.OBS_SIZE,),dtype=np.float32)
        self.action_space=spaces.Discrete(self.MAX_ACTIONS)
        self.replay_ratio=replay_ratio
        self.hard_pool=deque(maxlen=replay_pool_size)
    # 11 floats per fighter (team, is_acting, level, x, y, hp_frac, ap, mp, dead, effects,
    # cooldowns) + 1 float for class identity = 12 floats × 8 fighters = 96 floats,
    # plus 1 for round = 97 total, well within OBS_SIZE=256.
    def _obs(self,s):
        x=np.zeros(self.OBS_SIZE,dtype=np.float32); k=0
        board=s["board"]; turn=s["turn"]
        for f in s["fighters"][:self.MAX_FIGHTERS]:
            # class index: 0-based over the 12 known classes, normalized to [0,1] then
            # shifted to [-1,1]. Mobs have classe=None → encoded as -1 (below the
            # player range), giving a real signal to distinguish player-vs-mob identity.
            cls_idx = _CLASS_IDX.get(f.get("classe"), -1)
            cls_enc = (cls_idx / max(1, N_CLASSES - 1)) if cls_idx >= 0 else -1.0
            for v in (f["team"], float(f["id"]==turn), f["level"]/100,
                      (f["cell"]%board["grid_w"])/board["grid_w"],
                      (f["cell"]//board["grid_w"])/board["grid_h"],
                      f["hp"]/max(1,f["max_hp"]),f["ap"]/self.MAX_AP,f["mp"]/self.MAX_MP,
                      float(f["dead"]),f["effects"]/10,f["cooldowns"]/10,
                      cls_enc):
                if k<self.OBS_SIZE: x[k]=np.clip(float(v)*2-1,-1,1); k+=1
        if k<self.OBS_SIZE: x[k]=np.clip(s["round"]/100*2-1,-1,1); k+=1
        return x
    def _mask(self):
        m=np.zeros(self.MAX_ACTIONS,dtype=bool); m[:min(len(self.actions),self.MAX_ACTIONS)]=True; return m
    def reset(self,seed=None,options=None):
        super().reset(seed=seed)
        # `options` (Gymnasium's standard per-episode-override channel) forces a specific
        # composition/enemy archetype -- tools/compositions.py reuses one env (and its one
        # Bun subprocess) across thousands of cells instead of spawning one per cell. Never
        # served from the hard-fight pool: that pool holds fights from whatever composition
        # was randomly assigned at the time, not the one this caller just asked for.
        if options:
            setup=self.gen.setup(class_ids=options.get("class_ids"),mob_template=options.get("mob_template"))
            engine_seed=int(self.np_random.integers(1,2**31))
        elif self.replay_ratio>0 and self.hard_pool and self.np_random.random()<self.replay_ratio:
            setup,engine_seed=self.hard_pool[self.np_random.integers(len(self.hard_pool))]
        else:
            setup,engine_seed=self.gen.setup(),int(self.np_random.integers(1,2**31))
        self._used_options=bool(options)
        r=self.bridge.request({"op":"reset","setup":setup,"seed":engine_seed})
        if not r["ok"]: raise RuntimeError(r)
        self.state=r["state"]; self.actions=r["actions"]
        self._steps=0; self._dmg_dealt=0.; self._dmg_taken=0.; self._kills=0; self._deaths=0
        self._episode_setup,self._episode_seed=setup,engine_seed
        return self._obs(self.state),{}
    def step(self,a):
        # _steps must advance on every call, invalid actions included -- an early return
        # here used to skip it, so a decider that keeps proposing an out-of-range index
        # (env.actions is occasionally empty, e.g. mid mob-turn resolution -- see
        # rl/evolve.py's SimHandle for the same case) could spin forever: self.state never
        # changes without a real bridge call, so neither `done` nor the old steps-gated
        # `truncated` could ever become true. Confirmed happening (2026-09-02):
        # tools/compositions.py hung indefinitely (bun subprocess idle, python pegged at
        # 100% CPU in a tight loop) the first time a decider other than MaskablePPO's own
        # masked sampling drove this env.
        self._steps+=1
        truncated=self._steps>=self.MAX_EPISODE_STEPS
        if a>=len(self.actions):
            # actions est vide lors des tours de mob (bridge renvoie [] quand ce n'est pas
            # un joueur qui agit) : ne pas pénaliser avec -2, juste renvoyer l'état actuel
            # sans modifier la récompense. Le budget _steps avance quand même pour garantir
            # la terminaison -- mais on évite de pénaliser l'agent pour ce qui n'est pas
            # son action.
            return self._obs(self.state),0.0,False,truncated,{"invalid":True}
        chosen=self.actions[a]
        r=self.bridge.request({"op":"step","action":chosen})
        if not r["ok"]:
            self.state=r["state"]; self.actions=r["actions"]
            # Une rejection moteur sur une action légale est un bug de bridge -- log mais pas -2,
            # pour ne pas apprendre à éviter ces actions (le bridge les garantit légales).
            return self._obs(self.state),-2,False,truncated,{"invalid":True,"engine_error":r.get("error")}
        self.state=r["state"]; self.actions=r["actions"]
        reward=0.
        for e in r.get("events",[]):
            p=e.get("payload",{})
            if e["type"]=="damage_number":
                target,source,amount=_int(p.get("target",-1)),_int(p.get("source",-1)),_int(p.get("amount",0))
                ally_hit=target<4
                if ally_hit: self._dmg_taken+=amount
                else: self._dmg_dealt+=amount
                reward += -amount/150 if ally_hit else amount/100
            elif e["type"]=="fighter_died":
                fighter=_int(p.get("fighter",-1))
                if fighter>=4: self._kills+=1; reward+=2
                else: self._deaths+=1; reward-=3
        won=bool(self.state["ended"]) and self.state["winner"]==0
        done=bool(self.state["ended"])
        truncated=(not done) and self._steps>=self.MAX_EPISODE_STEPS
        if done: reward += 100 if won else -100
        info={"action":chosen}
        if done or truncated:
            info.update(win=int(won),damage_dealt=self._dmg_dealt,damage_taken=self._dmg_taken,
                        kills=self._kills,deaths=self._deaths,rounds=self.state["round"])
            self._remember_if_hard(won)
        return self._obs(self.state),reward,done,truncated,info
    def _remember_if_hard(self,won):
        if self.replay_ratio<=0 or self._used_options: return
        hard=not won
        if not hard:
            allies=[f for f in self.state["fighters"] if f["team"]==0 and not f["dead"]]
            hard=bool(allies) and sum(f["hp"]/max(1,f["max_hp"]) for f in allies)/len(allies)<self.NEAR_LOSS_HP_FRACTION
        if hard: self.hard_pool.append((self._episode_setup,self._episode_seed))
    def action_masks(self): return self._mask()
    def set_difficulty(self,d): self.gen.set_difficulty(d)
    def close(self): self.bridge.close()
