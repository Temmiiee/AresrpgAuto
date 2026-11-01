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
