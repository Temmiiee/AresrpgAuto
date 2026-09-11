# Architecture

```text
                AresRPG repository
                       |
                       v
              @aresrpg/fight engine
                       |
                 Bun bridge
                       |
              NDJSON stdin/stdout
                       |
                       v
                Python environment
                       |
          +------------+-------------+
          |                          |
          v                          v
  Scenario generator          RL policy/value
          |                          |
          +------------+-------------+
                       |
                       v
                 Exact simulator
                       |
                       v
               Search / evaluation
                       |
          +------------+-------------+
          |                          |
          v                          v
  Composition ranking         Combat solver
```

## Runtime separation

The simulator process is a long-lived Bun process. Python sends one JSON request per line and receives one JSON response per line.

This avoids starting Bun for every action.

`@aresrpg/fight` is a private, unpublished workspace package inside the AresRPG monorepo —
it isn't on npm and has zero runtime dependencies of its own. `bridge/server.ts` therefore
imports it directly from `$ARES_RPG_ROOT/packages/fight/src/index.ts` instead of through
node_modules, so no `bun install` of the (large) AresRPG monorepo is required to run the
bridge — only `ARES_RPG_ROOT` pointing at a checkout.

## Content pipeline

`data/archetypes.json` (classes, mob templates) and `data/spells.json` (full spell catalog)
are generated from the AresRPG content pack via `python tools/build_content.py --root
<checkout>` — see `docs/ROADMAP.md` for the exact source commit. `rl/scenarios.py` reads
these to build each `FightSetup`, filtering the spell catalog down to the 4 classes present
in that fight. Never hand-author class ids, mob stats, or spell data here; regenerate from
the real content pack instead.

## Colab target

Google Colab is a convenient first remote training environment.

Bun has an official Linux installer and ships as a standalone executable. The official installation is:

```bash
apt-get update -y
apt-get install -y unzip
curl -fsSL https://bun.com/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

The exact Colab runtime can change, so `notebooks/colab_setup.sh` verifies the installation instead of assuming a fixed environment.

## Scaling

The first prototype uses one simulator process.

The scalable version should use multiple independent simulator workers:

```text
worker 0 -> combat
worker 1 -> combat
worker 2 -> combat
...
worker N -> combat
```

A vectorized environment can collect experience from all workers.

For this project, simulator throughput can be more important than GPU size because each combat is a relatively small state machine.
