"""Behavior-cloning warm-start: pretrain a fresh MaskablePPO policy to imitate
rl/heuristic.py before RL fine-tuning takes over (rl/train.py's --bc-episodes).

Why: a from-scratch RL policy here consistently collapsed to a fixed, low-quality
behavior within the first tens of thousands of steps and then never moved again
(entropy_loss/approx_kl/clip_fraction pinned at exact 0.0 -- see docs/ROADMAP.md), never
once beating a trivial heuristic's win rate across 800+ episodes and 1M+ steps.
Pretraining on heuristic demonstrations gives the policy a reasonable starting point
instead of needing to discover "attack the weak target" via random exploration, which
random-collapse-before-discovery evidently never managed to do on its own.
"""
import sys, time
import numpy as np
import torch as th
from .env import AresFightEnv
from .heuristic import choose_action_index


def collect_demonstrations(seed, difficulty, episodes, max_steps=250, log_every=25, verbose=True):
    # max_steps well under AresFightEnv's MAX_EPISODE_STEPS=1000: a demo episode this
    # heuristic can't resolve in a few hundred steps is a stalemate, not a useful
    # demonstration, and letting a handful of those run to 1000 steps each is what made
    # an earlier --bc-episodes run take nearly an hour just to collect data (silently --
    # it only printed once, at the very end, so there was no way to tell "slow" from
    # "stuck" until this per-episode progress log was added, 2026-09-01).
    env = AresFightEnv(seed=seed)
    env.set_difficulty(difficulty)
    obs_list, mask_list, action_list = [], [], []
    wins = 0
    t0 = time.time()
    try:
        for ep in range(episodes):
            obs, info = env.reset()
            done = trunc = False
            steps = 0
            while not (done or trunc) and steps < max_steps:
                mask = env.action_masks()
                idx = choose_action_index(env)
                obs_list.append(obs)
                mask_list.append(mask)
                action_list.append(idx)
                obs, reward, done, trunc, info = env.step(idx)
                steps += 1
            wins += int(env.state.get("winner") == 0)
            if verbose and (ep + 1) % log_every == 0:
                elapsed = time.time() - t0
                eta = elapsed / (ep + 1) * (episodes - ep - 1)
                print(f"[bc] {ep+1}/{episodes} episodes, {len(obs_list)} transitions so far, "
                      f"win rate {100*wins/(ep+1):.1f}%, elapsed {elapsed:.0f}s, eta {eta:.0f}s",
                      file=sys.stderr, flush=True)
    finally:
        env.close()
    if verbose:
        print(f"[bc] collected {len(obs_list)} transitions from {episodes} heuristic episodes "
              f"(heuristic win rate {100*wins/episodes:.1f}%)", flush=True)
    return (np.array(obs_list, dtype=np.float32), np.array(mask_list, dtype=bool),
            np.array(action_list, dtype=np.int64))


def pretrain(model, obs, masks, actions, epochs=5, batch_size=256, verbose=True):
    # Trains the exact same policy network model.learn() will continue with (not a
    # separate model) via evaluate_actions()'s masked log-prob -- the standard supervised
    # target here is just negative log-likelihood of the demonstrated action.
    device = model.policy.device
    n = len(obs)
    rng = np.random.default_rng(0)
    for epoch in range(epochs):
        perm = rng.permutation(n)
        total_loss, total_correct = 0.0, 0
        for start in range(0, n, batch_size):
            idx = perm[start:start + batch_size]
            obs_t = th.as_tensor(obs[idx], device=device)
            mask_t = th.as_tensor(masks[idx], device=device)
            act_t = th.as_tensor(actions[idx], device=device)
            _, log_prob, _ = model.policy.evaluate_actions(obs_t, act_t, action_masks=mask_t)
            loss = -log_prob.mean()
            model.policy.optimizer.zero_grad()
            loss.backward()
            model.policy.optimizer.step()
            total_loss += loss.item() * len(idx)
        if verbose:
            print(f"[bc] epoch {epoch+1}/{epochs} nll_loss={total_loss/n:.4f}", flush=True)
