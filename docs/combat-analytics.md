# Combat analytics

Set `BOT_COMBAT_ANALYTICS=true` in `packages/bot/.env` and restart the bot. It writes one JSONL
file per fight to `packages/bot/logs/fights/`. Each file records start/end packets, fight origin
when known, authoritative fight checkpoints (fighter HP/AP/MP, cells, effects and cooldowns plus
checkpoint-to-checkpoint changes), planned decisions with legal alternatives, rejected submissions,
and the action list accepted by `commit_turn`. At fight end the bot prints and, when a
Discord webhook is configured, sends a compact result summary. A file is capped at 8 MiB; once capped,
further events for that fight are omitted and a warning is logged. Analytics are disabled by
default and never affect combat decisions.

From `packages/bot`, run:

```sh
bun run analyze-fights
```

Or pass a different log directory after the command. The analyzer prints per-fight and combined
totals for wins, rounds, turns, HP removed/lost, healing, player AP/MP spent, passed turns, action
counts and commonly cast spells. Malformed JSONL lines are skipped so a partially written final
line does not hide the rest of a report.

The analyzer also compares outcomes by enemy and party-class composition, reports common planner
reasons and rejected transaction codes, and flags high pass rates for inspection. These are
descriptive signals; the bot does not change tactical weights automatically from a small sample.

The checkpoints are authoritative snapshots, while submitted actions describe what the bot asked
the engine to execute. HP and resource deltas are therefore measured between snapshots; random
rolls, enemy turns, and effects can contribute to the observed changes. Use the report to find
patterns, then inspect the corresponding JSONL before changing tactical weights.
