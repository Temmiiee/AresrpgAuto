# AresrpgAuto

Workspace for the AresRPG automation bot.

## Structure

```
AresRPGBotV2/   the bot monorepo — see AresRPGBotV2/AGENTS.md for the full documentation
aresrpg/        optional reference clone of https://github.com/aresrpg/aresrpg
                (its own repo, not tracked here; only needed by `sync_vendor.mjs --check`)
```

`aresrpg/` and every `node_modules/` are local-only and gitignored — a fresh clone omits them.

## Quick start

```sh
cd AresRPGBotV2
bun install
cd packages/bot
cp .env.example .env   # then fill in DISCORD_WEBHOOK_URL (see the file for the rest)
bun run login          # one-time interactive zkLogin Google sign-in
bun run start          # run the session loop
```

To run the party detached (logging to `.state/`), use `AresRPGBotV2/farm4.ps1` or
`AresRPGBotV2/packages/bot/run-bot.ps1`.

The party/time-control environment variables and the architecture are documented in
`AresRPGBotV2/AGENTS.md`.
