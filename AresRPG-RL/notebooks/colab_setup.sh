#!/usr/bin/env bash
set -euo pipefail

echo "== Python =="
python --version
python -m pip install -U pip
python -m pip install -r requirements.txt

echo "== Bun =="
sudo apt-get update -y
sudo apt-get install -y unzip
curl -fsSL https://bun.com/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version

echo "== AresRPG =="
if [ ! -d "/content/aresrpg" ]; then
  git clone --branch edge https://github.com/aresrpg/aresrpg.git /content/aresrpg
else
  git -C /content/aresrpg fetch --all
fi
# No `bun install` needed here: bridge/server.ts imports @aresrpg/fight straight from
# this checkout's source (it has zero runtime dependencies of its own), so the bridge
# works without installing the rest of the (large, npm-dependent) AresRPG monorepo.

echo
echo "Setup complete."
echo "Set: export ARES_RPG_ROOT=/content/aresrpg"
