# Training on Google Colab (step by step)

Google Colab is a free, hosted Jupyter notebook — a page of runnable code "cells" in
your browser, backed by a real Linux machine you don't have to set up yourself. No local
install, works from a Chromebook or a phone. This walks through it assuming you've never
used it.

## 1. Open a notebook

Go to [colab.research.google.com](https://colab.research.google.com), sign in with a
Google account, and choose **New notebook**. You get one empty code cell. A cell runs
with **Shift+Enter** (or the ▶ button on its left edge) — output appears directly below
it. `!` at the start of a line runs a shell command instead of Python; that's used
throughout below.

You don't need a GPU runtime for this project — the fight simulator is CPU/IPC-bound
(one Bun subprocess talking JSON over a pipe), so a GPU sits idle. The default runtime
(**Runtime → Change runtime type → CPU**) is fine and avoids GPU queue waits.

## 2. Clone the repository

Paste into a cell and run it:

```bash
%cd AresRPG-RL
```

(`%cd`, with a percent sign, is a notebook "magic" command — it changes directory for
every cell after it, unlike `!cd` which only affects that one line.)

## 3. Run the bootstrap

```bash
!bash notebooks/colab_setup.sh
```

This installs the Python dependencies (`requirements.txt`), installs Bun, and clones the
AresRPG engine repo itself to `/content/aresrpg` (a separate checkout — that's where the
real fight simulator lives; this project only calls into it, never reimplements it).
Takes a couple of minutes. Re-running it later in the same session is harmless.

## 4. Point at the AresRPG checkout

```python
import os
os.environ["ARES_RPG_ROOT"] = "/content/aresrpg"
```

Every following cell in this notebook session now has that environment variable set.
Python cells and `!shell` cells in Colab share the same environment, so this is enough —
you don't need to repeat it per cell.

## 5. Smoke test

```bash
!python tools/smoke_test.py
```

Expect `{'ok': True}`. If this fails, re-run step 3 and double check step 4 ran in the
*same* notebook (variables don't survive a Colab disconnect — see step 7).

## 6. Train (evolutionary trainer)

The canonical trainer is `rl.evolve` — a **(mu+lambda) evolution strategy** over the
6-weight decision policy (`base_weight`, `priority_decay`, `finish_weight`, `heal_weight`,
`strike_bias`, `element_weight`). Everything is CPU-only, so the free runtime is exactly
the right size for this.

Start small to confirm the whole chain works before committing real compute:

```bash
!python -m rl.evolve --generations 4 --population 6 --scenarios 4
```

That prints per-generation best/hold-out lines and finishes in a few minutes. Then scale
up — a realistic run on a free 2-vCPU runtime is a couple of hours:

```bash
!python -m rl.evolve --generations 50 --population 10 --scenarios 8 \
  --checkpoint /content/drive/MyDrive/aresrpg-ai/evolve.json
```

Useful flags (full list: `python -m rl.evolve -h`):

- `--scenarios N` training scenarios evaluated each generation (default 40).
- `--holdout-scenarios N` scenarios drawn from a *different* seed and never touched during
  the run (default 50) — improvement is measured on these, not the training set, so it's a
  real generalization check rather than training-set memorization.
- `--holdout-runs N` sims per hold-out scenario (default 10).
- `--runs-per-eval N` sims per training scenario each generation (default 2).
- `--min-holdout-improvement X` `models/policy.json` is only written if the best evolved
  policy beats the default by at least X percentage points on the held-out set
  (default 1.0).
- `--seed 20260901` fixed by default so a run is reproducible (`--holdout-seed 999_999`
  is separate and must never equal `--seed`).
- `--checkpoint FILE` / `--resume FILE` for crash-safe runs — a checkpoint is written
  after every generation and `--resume` fast-forwards past everything already done.

For several independent runs (cheap insurance against single-run luck):

```bash
!python -m tools.multi_evolve --runs 4 --generations 50 --population 10 --scenarios 8
```

## 7. Persist results across sessions

Colab's free tier disconnects — a 12-hour hard cap, and idle timeouts well before that.
Anything under `/content/` (the default working directory) disappears on disconnect.
Mount Google Drive and write there instead:

```python
from google.colab import drive
drive.mount('/content/drive')
```

**Next session** (after a disconnect — repeat steps 1-5 first, since that state is gone
too), continue instead of restarting from scratch:

```bash
!python -m rl.evolve --resume /content/drive/MyDrive/aresrpg-ai/evolve.json \
  --generations 50 --population 10 --scenarios 8
```

`--resume` fast-forwards through every generation already in the checkpoint, so re-running
with the same budget doesn't duplicate work.

The validated policy itself is written to `models/policy.json` — also under `/content`, so
it's ephemeral. Keep it:

```python
import shutil
shutil.copy("models/policy.json", "/content/drive/MyDrive/aresrpg-ai/policy.json")
```

## 8. Ship the policy to the bot

```bash
!python -m tools.export_policy_to_bot --bot-root <path to the AresRPGBot checkout>
```

This translates `models/policy.json` into the bot's format and writes
`packages/bot/learned_policy.local.json` in the AresRPGBot repo. That file is small (a few
hundred bytes: the 6 weights + metadata) and is **committed to git** — earlier the repo
ignored it, which is exactly how a trained policy got lost when switching machines. Do the
training anywhere, then `git add`/commit/`push` the resulting file so both machines can
pull it; the bot picks it up on its next fight.

## Rough expectations

The simulator runs at roughly 90 env steps/sec on one CPU process (measured at full
difficulty on a 2023 desktop CPU), so the limit is wall-clock, not memory or GPU. The
two validated runs in `docs/ROADMAP.md` used modest budgets and ended with the evolved
policy beating the default by **+43.50** on the held-out set (training-set +20.46). The
signal to watch for at the end of a run is whether `models/policy.json` got written — i.e.
whether the held-out gate cleared — not the raw training-set numbers.