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
*same* notebook (variables don't survive a Colab disconnect — see step 8).

## 6. Train

Start small to confirm everything works before committing real compute:

```bash
!python -m rl.train --steps 5000
```

This should take well under a minute and print PPO's rollout stats (`ep_rew_mean`,
`ep_len_mean`) a few times. Once that looks sane, scale up:

```bash
!python -m rl.train --steps 200000 --workers 2 --out models/ppo_ares --log runs/monitor
```

`--workers N` runs N simulator processes in parallel (each its own Bun subprocess) —
real throughput gain, though not linear in N. Colab's free CPU runtime typically has 2
vCPUs, so start at `--workers 2`; check `nproc` in a `!` cell if you want to know exactly
how many you have, and don't go far past that number (more workers than cores just adds
contention, not speed). `--out` is where the model checkpoint (`.zip`) is saved. `--log`
is a directory of per-episode stats CSVs (win/loss, damage dealt/taken, episode
length... one file per worker) that the dashboard below reads — keep it if you want to
see training progress.

## 7. View the training dashboard

```bash
!python -m tools.dashboard --log runs/monitor --out runs/dashboard.html
```

Then, in a Python cell, open it right inside the notebook:

```python
from IPython.display import IFrame
IFrame("runs/dashboard.html", width=900, height=700)
```

Or download it to view in a normal browser tab: click the folder icon in Colab's left
sidebar, navigate to `runs/dashboard.html`, and use its ⋮ menu → **Download**. Re-run the
`tools.dashboard` command any time during or after training to refresh it — it's cheap
(pure Python, no plotting library, regenerates in well under a second).

## 8. Persist checkpoints and logs across sessions

Colab's free tier disconnects — a 12-hour hard cap, and idle timeouts well before that.
Anything under `/content/` (the default working directory) disappears on disconnect.
Mount Google Drive and write there instead:

```python
from google.colab import drive
drive.mount('/content/drive')
```

```bash
!python -m rl.train --steps 200000 --workers 2 \
  --out /content/drive/MyDrive/aresrpg-ai/ppo_ares \
  --log /content/drive/MyDrive/aresrpg-ai/monitor
```

**Next session** (after a disconnect — repeat steps 1-5 first, since that state is gone
too), continue instead of restarting from scratch:

```bash
!python -m rl.train --steps 200000 --workers 2 \
  --resume auto \
  --out /content/drive/MyDrive/aresrpg-ai/ppo_ares \
  --log /content/drive/MyDrive/aresrpg-ai/monitor
```

`--resume auto` finds the highest-step checkpoint under
`/content/drive/MyDrive/aresrpg-ai/ppo_ares_checkpoints/` (written automatically every
`--checkpoint-freq` steps, default 20000) and continues from it — no need to track the
exact filename across sessions; if none exists yet it just starts fresh. (You can still
pass an explicit `--resume /path/to/checkpoint.zip` instead.) `--out` and `--log` point
at the same paths across sessions so both keep accumulating. Each `--steps` adds that many
*more* timesteps on top of what's already trained. Repeat across sessions — that's how
you accumulate real training time for free. Regenerate the dashboard from the Drive log
path any time to see the full history across all sessions, not just the current one.

## Rough expectations

At the throughput measured for this project (~90 env steps/sec on one CPU process,
~200/sec with `--workers 4` on one machine — expect less on Colab's 2 vCPUs), 200k
steps is well under an hour, but PPO on an action space this rich realistically needs
low millions of steps before it looks competent — that's several sessions strung
together via `--resume`. Watch the dashboard's win-rate
chart trend upward over time; if it stays flat near 0% for a long stretch, something
about the reward/observation setup likely needs attention before burning more compute.
