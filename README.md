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

The party/time-control environment variables and the architecture are documented in
`AGENTS.md`.
