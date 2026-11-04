# AresrpgAuto

Workspace for the AresRPG automation bot.

`aresrpg/` and every `node_modules/` are local-only and gitignored — a fresh clone omits them.

## Quick start

```sh
bun install
cd packages/bot
cp .env.example .env   # then fill in DISCORD_WEBHOOK_URL (see the file for the rest)
bun run login          # one-time interactive zkLogin Google sign-in
bun run start          # run the session loop
```

To run the party detached (logging to `.state/`), use `/farm4.ps1` or
`packages/bot/run-bot.ps1`.

## Runtime logs and slow-start diagnosis

The bot writes timestamped operational messages to the console. The default `BOT_LOG_LEVEL=info`
reports startup milestones, successful actions, meaningful waits/holds, and warnings. The first line
of a run prints the effective log level and any scope overrides, even if those settings suppress the
normal application logs. This helps explain why SDK transaction lines can still appear: SDK `tx`
output goes directly to the console and is not controlled by the bot logger.

Useful settings in `packages/bot/.env` (copy the complete list from `.env.example`):

```dotenv
BOT_LOG_LEVEL=info
# BOT_LOG_LEVEL=debug adds decision details; trace logs every awaited decision step.
# BOT_LOG_SCOPES=party=debug,trace=trace
```

At startup, look for `zkLogin ready`, `SDK ready`, `connecting to realtime server`, and `roster
ready`. The configuration line also reports whether `BOT_PROFILE_PREVIEW` is enabled; its per-preview
timings can generate many lines and should be disabled for normal operation. If progress stops, the last milestone identifies the stage that is waiting. After the
characters start, a health line is emitted every 15 seconds with connection status, state freshness,
last successful action, each character's loop status, and its active fight. A decision pass that
takes at least 60 seconds emits a slow-pass warning. The strategy scan is deliberately delayed by
up to 90 seconds so it does not compete with initial connection and actions; it can still temporarily
consume CPU during later full-content passes, but it now runs in a worker so it does not block the
realtime session's event loop.

For extra combat-preview timings, set `BOT_PROFILE_PREVIEW=1`; this diagnostic output is separate
from `BOT_LOG_LEVEL` and should normally be left unset. Set `BOT_COMBAT_ANALYTICS=true` only when
you want per-fight JSONL records under `packages/bot/logs/fights/`.

The environment-variable reference and architecture are in `packages/bot/.env.example` and
`AGENTS.md`; combat analytics and version-gate behavior have dedicated notes under `docs/`.

### Discord digest accounting

The periodic Discord digest reports successful activity from the current process window:

- `loot` comes from the sealed `fight::DropsRolled` events in the settlement receipt, not from a
  monster's potential loot table;
- `gathered` counts successful harvest receipts and the 50-resource rewards actually claimed from
  protector bags;
- `crafted` counts successful outputs only (failed craft attempts are not products);
- `job xp` is the live job-XP delta across the selected party.

Consequently, `none` means no successful action of that category was credited during that window.
The durable `.state/activity.log` remains the transaction-level audit trail across restarts.

## Current automation policy

- Omori is the default objective-driven crafter. Memorien farms, Llokan mines, and Archero gathers
  herbs; each gatherer keeps the matching tool instead of paying for frequent tool swaps.
- After every group-fight settlement, every party member gets one bounded chore attempt before the
  leader may stage the next fight. An unavailable local node or blocked recipe does not freeze the
  party, but continuous combat can no longer starve gathering and crafting indefinitely.
- Craft objectives are isolated and scheduled fairly: a dungeon key blocked on a rare drop no
  longer freezes an affordable equipment upgrade or pet food. Each objective may train its own
  required trade, while unrelated filler remains unable to consume reserved materials.
- Equipment targets use the same class/stat score as auto-equip. Held items are allocated once
  across the party; a weak random roll or another character needing the same item keeps the craft
  goal alive.
- Resource-protector victories can drop deterministic resource bags. While the party is idle, the
  leader opens and claims those bags through the shared transaction lane; every supported bag
  yields exactly 50 units of its resource.
- Every unfinished pet is fed at most once per UTC day (`BOT_PET_FEED=true`). Worn pets are
  unequipped, fed and re-equipped atomically. Missing, genuinely obtainable food becomes a craft
  goal, and its rare ingredients are translated into demand for the corresponding resource.
  Recipes whose resource tier exists only in the immutable catalog (currently tiers 7–11, absent
  from every shipped world) are reported once and parked instead of wasting craft/farm cycles.
- Dungeon keys are not spent blindly. The party previews authored rooms at an 80% minimum win rate,
  parks unsafe dungeons, waits for wounded entrants to recover, and commits only nearby members.

The detailed progression and acquisition chain is documented in `docs/progression-plan.md`.
