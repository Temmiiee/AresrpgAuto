import argparse, importlib.util, re
from pathlib import Path
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import CallbackList, CheckpointCallback
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv
from .env import AresFightEnv
from .curriculum import CurriculumCallback
from .safety import CollapseGuardCallback
from . import bc

INFO_KEYWORDS = ("win", "damage_dealt", "damage_taken", "kills", "deaths", "rounds")
CHECKPOINT_RE = re.compile(r"_(\d+)_steps\.zip$")

def _make_env(rank, seed, log_dir, override_existing, replay_ratio, replay_pool_size):
    # Each worker gets its own AresFightEnv -> AresBridge -> Bun subprocess, and (with
    # --workers > 1) its own OS process via SubprocVecEnv: the simulator is one Bun
    # process per env talking JSON over a pipe, so true parallelism needs separate
    # processes, not just separate objects in one Python process. The hard-fight pool
    # (see AresFightEnv) is per-worker too -- each process only replays fights it has
    # personally seen go badly, no cross-process sharing needed for the pool to be useful.
    def _init():
        env = AresFightEnv(seed=seed + rank, replay_ratio=replay_ratio, replay_pool_size=replay_pool_size)
        log_path = str(Path(log_dir) / f"{rank}.monitor.csv") if log_dir else None
        return Monitor(env, filename=log_path, override_existing=override_existing, info_keywords=INFO_KEYWORDS)
    return _init

def _latest_checkpoint(checkpoint_dir, name_prefix):
    checkpoint_dir = Path(checkpoint_dir)
    if not checkpoint_dir.is_dir():
        return None
    best_step, best_path = -1, None
    for f in checkpoint_dir.glob(f"{name_prefix}_*_steps.zip"):
        m = CHECKPOINT_RE.search(f.name)
        if m and int(m.group(1)) > best_step:
            best_step, best_path = int(m.group(1)), f
    return best_path

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--steps", type=int, default=100000)
    p.add_argument("--out", default="models/ppo_ares")
    p.add_argument("--resume", default=None,
                   help="path to an existing .zip checkpoint to continue training from, or 'auto' to "
                        "resume the most recent periodic checkpoint under --out's checkpoint directory")
    p.add_argument("--checkpoint-freq", type=int, default=20000,
                   help="save a versioned checkpoint every N env steps under <out>_checkpoints/ (0 disables)")
    p.add_argument("--log", default="runs/monitor",
                   help="directory of per-worker episode-stats CSVs, read by tools/dashboard.py")
    p.add_argument("--workers", type=int, default=1,
                   help="parallel simulator processes (each spawns its own Bun subprocess)")
    p.add_argument("--seed", type=int, default=12345, help="base scenario-generator seed; worker i uses seed+i")
    p.add_argument("--curriculum", action="store_true",
                   help="start easy and raise difficulty as win rate improves (see docs/DESIGN_NOTES.md)")
    p.add_argument("--curriculum-start", type=float, default=0.2, help="initial difficulty, 0.0-1.0")
    p.add_argument("--curriculum-step", type=float, default=0.2, help="difficulty increase per advancement")
    p.add_argument("--curriculum-target", type=float, default=0.5, help="win rate that triggers an advancement")
    p.add_argument("--curriculum-window", type=int, default=100, help="episodes averaged for the win-rate check")
    p.add_argument("--replay-ratio", type=float, default=0.2,
                   help="probability a reset replays a stored hard fight (loss or narrow win) instead of "
                        "generating a new scenario -- see docs/DESIGN_NOTES.md's hard-fight replay pool; 0 disables")
    p.add_argument("--replay-pool-size", type=int, default=50,
                   help="hard fights kept per worker for replay (oldest evicted first)")
    p.add_argument("--bc-episodes", type=int, default=0,
                   help="warm-start a fresh policy by behavior-cloning rl/heuristic.py for this many "
                        "episodes before RL starts (0 disables; see rl/bc.py and docs/ROADMAP.md -- a "
                        "from-scratch policy never once beat this heuristic's win rate across 800+ episodes)")
    p.add_argument("--bc-epochs", type=int, default=5, help="supervised epochs over the collected BC demonstrations")
    p.add_argument("--collapse-patience", type=int, default=15,
                   help="stop early if entropy_loss pins at exact 0.0 for this many consecutive updates -- "
                        "see rl/safety.py; 0 disables the guard")
    a = p.parse_args()

    out_path = Path(a.out)
    checkpoint_dir = out_path.parent / f"{out_path.name}_checkpoints"

    resume_path = a.resume
    if resume_path == "auto":
        resume_path = _latest_checkpoint(checkpoint_dir, out_path.name)
        print(f"[checkpoint] auto-resume found {resume_path}" if resume_path else
              "[checkpoint] auto-resume found no existing checkpoint, starting fresh")

    if a.log:
        Path(a.log).mkdir(parents=True, exist_ok=True)
    env_fns = [_make_env(i, a.seed, a.log, override_existing=not resume_path,
                         replay_ratio=a.replay_ratio, replay_pool_size=a.replay_pool_size)
               for i in range(a.workers)]
    env = DummyVecEnv(env_fns) if a.workers == 1 else SubprocVecEnv(env_fns)

    # tensorboard is not in requirements.txt (see ROADMAP.md: optional logging) — degrade
    # to no logging instead of crashing when it isn't installed.
    tb_log = "runs/" if importlib.util.find_spec("tensorboard") else None
    if resume_path:
        model = MaskablePPO.load(resume_path, env=env, tensorboard_log=tb_log, device="auto")
    else:
        # Every run of this project through 2026-09-01 hit the same failure: entropy_loss/
        # approx_kl/clip_fraction all pin at exact 0.0 within tens to hundreds of thousands
        # of steps and never recover (value_loss keeps moving normally the whole time --
        # only the policy head dies), while performing at random-policy quality even before
        # collapsing. Six configurations were tried and ALL failed the same way: n_epochs=10
        # (SB3 default) with no target_kl; n_epochs=4+target_kl=.03 at ent_coef .01/.02/.05;
        # a --bc-episodes behavior-cloning warm-start; learning_rate 1e-4 with
        # max_grad_norm=0.3; and a widened [256,256] net_arch. That rules out bad init,
        # exploration pressure, update step size, and network capacity -- this was never a
        # hyperparameter-tuning problem.
        #
        # Root cause: sb3-contrib's MaskableCategorical has documented float32 numerical-
        # stability issues with large masked action spaces (reported failures around ~1400
        # actions -- Stable-Baselines-Team/stable-baselines3-contrib#247, #221).
        # AresFightEnv.MAX_ACTIONS was 4096, comfortably inside that fragile zone, for no
        # real benefit: the observed max legal-action count across 5741 real decision
        # points at full difficulty was 564. Fixed at the source (rl/env.py) by shrinking
        # MAX_ACTIONS to 1024 -- comfortable headroom above the observed max, well clear of
        # the reported threshold. Reverted every other knob back to plain defaults here so
        # this fix can be judged in isolation instead of tangled up with five stacked
        # changes. CollapseGuardCallback (--collapse-patience) still guards against a
        # repeat regardless. Any checkpoint whose log already shows entropy_loss/
        # clip_fraction/approx_kl pinned at exact 0.0 is permanently degenerate -- don't
        # resume from it.
        model = MaskablePPO("MlpPolicy", env, verbose=1, learning_rate=3e-4, n_steps=1024,
                            batch_size=256, n_epochs=4, gamma=.995, gae_lambda=.95,
                            ent_coef=.02, target_kl=.03,
                            tensorboard_log=tb_log, device="auto")
        if a.bc_episodes > 0:
            demo_obs, demo_masks, demo_actions = bc.collect_demonstrations(
                seed=a.seed, difficulty=a.curriculum_start if a.curriculum else 1.0, episodes=a.bc_episodes)
            bc.pretrain(model, demo_obs, demo_masks, demo_actions, epochs=a.bc_epochs)
    callbacks = []
    if a.curriculum:
        callbacks.append(CurriculumCallback(start=a.curriculum_start, step=a.curriculum_step,
                                            target=a.curriculum_target, window=a.curriculum_window,
                                            verbose=1))
    if a.collapse_patience > 0:
        callbacks.append(CollapseGuardCallback(patience=a.collapse_patience, verbose=1))
    if a.checkpoint_freq > 0:
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        # save_freq is in units of callback calls, i.e. one per vectorized step (n_envs
        # env-steps each) -- divide by n_envs so the on-disk cadence matches --checkpoint-freq
        # real env steps, per SB3's own CheckpointCallback docs.
        callbacks.append(CheckpointCallback(save_freq=max(a.checkpoint_freq // a.workers, 1),
                                            save_path=str(checkpoint_dir), name_prefix=out_path.name))
    callback = CallbackList(callbacks) if callbacks else None

    model.learn(total_timesteps=a.steps, reset_num_timesteps=resume_path is None, callback=callback)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    model.save(a.out)
    env.close()

# SubprocVecEnv uses multiprocessing, which on Windows (spawn start method) re-imports
# this module in every worker process — without this guard, each worker would parse
# argv and spin up its own sub-workers recursively.
if __name__ == "__main__":
    main()
