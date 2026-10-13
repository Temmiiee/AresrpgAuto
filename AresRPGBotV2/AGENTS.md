# AGENTS.md — context for working on AresRPGBotV2

This file is the orientation an AI agent (or a new human) needs before touching the code. Read it
first. It records the hard invariants, the runtime shape, and the traps that have already cost time.

## What this is

A self-contained, headless automation bot for **AresRPG** on **Sui mainnet**. It logs in with
zkLogin, opens an authenticated live-state WebSocket to the game server, folds the server's push
stream into one local projection, and drives the player's characters through gather / fight / roam
/ craft loops while reporting to Discord.

It does **not** depend on a sibling checkout at runtime: the four packages in the SDK's write-path
closure (`sdk`, `fight`, `protocol`, `immutable`) plus `pins.json` and `seed/content/*.json` are
**vendored** into this repo.

## The one invariant that matters most

> **The realtime server seats exactly ONE WebSocket per signer address.**

All characters share one zkLogin signer address, so **the whole party must ride a single socket.**
The server then tracks the entire capped roster on that connection
(`MAX_TRACKED_CHARACTERS = 6`) and every packet is stamped with an explicit `character_id`.

Consequences and the historical bug:

- Opening one socket **per character** (the original design) makes each new login evict the
  previous seat (`REPLACED` same pod / `ALREADY_CONNECTED` across pods). The evicted link is
  terminal, so only the last character ever played and the rest silently idled.
- `farm4.ps1` therefore launches **one** process, not four.
- `packages/bot/src/net/session.ts` creates **one** `create_session(...)` and every per-character
  `ActionContext` shares it (`send: (packet) => session.send(packet)`).
- `game_state` is a single shared projection folded from that one socket.

If you ever add a second `create_session` for the same address, you have reintroduced the bug.

## Layout

```
AresRPGBotV2/
  packages/
    bot/           the bot itself (all app code lives here)
      src/
        main.ts             entry point + CLI dispatch (run/doctor/status/login)
        config.ts           THE single seam that reads process.env -> frozen BotConfig
        net/
          server_link.ts    handshake, status kinds, backoff/reconnect (long-lived daemon link)
          session.ts        the play loop: one socket, roster discovery, per-character runtimes
        actions/            effectful edges (compose + submit transactions)
          context.ts        ActionContext bundle + the cross-character GroupClaims registry
          travel.ts         chain-proof-gated, speed-law-compliant presence streaming (Mover)
          roam.ts           pick where to stand (plan_roam / assess_window)
          gather.ts         harvest one node
          craft.ts          plan_recipe / craft_once / drive_craft
          combat.ts         hydrate/drive/engage/settle fights (the fight driver)
          party.ts          the group-fight rendezvous shared by every character (PartyState)
          fight_preview.ts  local deterministic fight twin: screen_groups / viable_ranking
          turn_plan.ts      plan_turn / next_action / sim_commands
          fight_registry.ts live fight runtime registry, fed by the fight_state stream
          play_stats.ts     per-character tallies + digest formatting
        state/
          store.ts          pure reducer: server packets -> GameState (the one projection)
          selectors.ts      derived reads: freshness, live groups, active_fight_of, ...
        chain/              SDK durable storage + the activity ledger
        auth/               zkLogin (Enoki) signer, session cache, the shared BotSdk factory
        content/            seed catalog, fight source maps, zone math
        shared/             logger, Discord webhook, network config
        cli/                doctor / status / login entry points
      test/                 bun test specs
    sdk/ fight/ protocol/ immutable/   vendored from ../aresrpg (do not hand-edit; re-sync)
  scripts/sync_vendor.mjs   copies the vendored tree from ../aresrpg ( --check reports drift )
  pins.json                 deployment pins (package ids, original seed package, ...)
  seed/content/*.json        items, recipes, mobs, worlds, spells, fight boards, ...
  farm4.ps1                 launches the single party-driving process
```

## Commands

```powershell
# typecheck the bot (run tsc directly; the root `bun run typecheck` script misbehaves in PowerShell)
cd packages/bot
bun tsc --noEmit -p tsconfig.json

# tests
cd packages/bot
bun test

# run the bot (from the repo root)
bun run bot

# drive a party of 4 (BOT_PARTY_SIZE, 1..4)
./farm4.ps1

# verify the vendored tree matches ../aresrpg
bun scripts/sync_vendor.mjs --check
```

## Runtime data flow

```
server (WebSocket)
   │  packet/characters        roster on connect (whole account)
   │  packet/tracked_zones     this connection's zone spiral (per character)
   │  packet/zones, zone_spawns seed-derived populations
   │  packet/inventory         the ONE flat inventory (includes listed + worn items)
   │  packet/listings          the account's own ACTIVE market listings (id → LISTED_IN)
   │  packet/fight_state       authoritative fight checkpoint after every turn
   │  packet/server_info       chain clock + indexing lag (5s cadence)
   │  packet/game_state        global freeze flag
   ▼
reduce(state, {kind:'packet', packet})   →  GameState   (state/store.ts, pure)
   ▼
per-character run loops (one socket, N runtimes) consult selectors + freshness
   ▼
actions compose Sui transactions through the shared BotSdk and submit them
```

## Per-character decision pass (`session.ts` → `run_pass`)

For each character, in order:

1. **settle/close** — reconcile any fight the chain reports ended (`settle_pending`, `close_pending`).
   `settle_pending` batches **fight-wide**: one transaction settles every seat of a fight the
   character is part of, so a four-seat group fight closes in one shot instead of racing a
   per-seat final settlement.
2. **drive fight** — if the character is seated (`active_fight_of`), play the current turn
   (`drive_fight`, using `turn_plan` + the `@aresrpg/fight` twin). The submit is serialized per
   fight (`fight_runtimes.with_lock`) so allied seats never place/ready/turn on the same object at
   once.
2b. **engage grace** — right after an engage, wait (`ENGAGE_GRACE_MS = 45s`) for the roster to
   reflect the new fight before re-screening. This window is why double-engages (and the
   `dynamic_field::add` abort) no longer happen.
3. **freshness gate** — refuse to spend unless the link is authenticated, gameplay is not frozen,
   indexing lag is acceptable, and the chain clock is live.
3b. **group fight (BEFORE chores)** — when `BOT_GROUP` is on and the party has partners, run the
   shared rendezvous (`actions/party.ts`). A **follower** does this first, so it can never wander off
   to a chore and strand the rendezvous; between fights it **rallies** to the leader's checkpoint
   (`rally_to_leader`) instead of roaming to its own band, so the next rendezvous is a short hop. The
   **leader** instead runs its chore once (below) and then stages, so omori's crafting still levels
   while the party chains fights. The leader screens the group **for the whole party**; the leader
   then engages and joins all partners in the same beat. While the party is grouping only the leader
   opens fights.
3c. **chores** — run the assigned chore once (`run_chore`). A party member's gather is capped
   (`PARTY_GATHER_RADIUS = 1024`) so it stays within a zone or two of the leader.
4. **roam** — optionally drift toward worthwhile prey (`roam_once`).
5. **engage** — screen live mob groups with the local twin and open the best sure-win group (solo
   path; suppressed while the party is grouping).
6. **chores fallback** — gather one node and craft one batch when no fight is on offer.

`flush_summary` logs a per-character digest every `SUMMARY_EVERY_FIGHTS = 10` settled fights. There
is no periodic Discord ping; the only Discord message is the zkLogin sign-in link.

## Group fights (`actions/party.ts`)

The chain opens a PvM fight when the leader engages and only admits allies while the fight is in
placement (round 0). Placement starts at engage and force-starts `PLACEMENT_FORCE_MS` (60 s) later,
so the whole party must be seated inside that window. The coordinator (one shared `PartyState`
object) enforces the two consequences:

- **Stage before engaging** — the leader plans a target (`pick_engage_target`, screened with the
  whole party), and does not engage until every other member reports `can_reach` to the group
  (the chain's `admit` replays each joiner's proof from its own checkpoint to the fight's x/z).
- **Join in the same beat** — the leader engages then calls `fight.join_many` for every partner in
  the same pass, before any seat readies. `ready_and_start_fight` only starts once *all* seats are
  ready on chain, so a straggler cannot be left out.
- **All-staged wins the race with the clock** — the leader tests "every follower staged and
  `can_reach`" *before* the rendezvous timeout, so a follower that arrives in the last second is not
  abandoned in the same pass.
- **Follower staging re-anchors the checkpoint** — `travel_to` streams presence but never moves the
  chain checkpoint, and `admit` replays each joiner's proof from that checkpoint; so a follower calls
  `mover.ensure_zone(false)` (`search_zone`) after productive travel to hop the checkpoint forward.
- **Preview budget scales with the party** — `run_once` counts EVERY actor against `MAX_TURNS`, so a
  naive budget gave a 4-player fight ~1/4 the rounds and scored it a loss. The budget is now
  `round(MAX_TURNS * actor_count / (1 + mobs))`, so every party size is judged over the same number
  of ROUNDS (solo is byte-identical).
- **Rally keeps the party a party** — while grouping, a follower with nothing to do drifts toward the
  leader's checkpoint (`rally_to_leader`) rather than roaming to its own band. Without it, a follower
  wanders ~2000 blocks and the next rendezvous costs minutes; with it, back-to-back group fights
  converge in seconds.

A rendezvous that cannot form within `STAGE_TIMEOUT_MS` (300 s) is abandoned and retried; after
`MAX_STAGE_FAILURES` (3) the party plays solo for `GROUP_COOLDOWN_MS` (5 min) before trying again.
`ACTIVE_GRACE_MS` (60 s) covers the roster/indexer lag after an engage.


## Traps that already cost time (do not re-learn these)

- **One socket per address** — see the invariant above. This was the "4 characters don't play" bug.
- **Roster before session** — the server only pushes `packet/characters` to a *connected* socket. A
  roster check must happen **after** a session exists, never before.
- **`active_fight` trails the chain** — custody flips to `fight` on-chain before the indexer
  re-sends the roster. `engage_once` therefore also refuses while `character.custody === 'fight'`,
  and the engage grace covers the indexer window.
- **Shared live-group window, one on-chain bit** — every runtime sees the same folded groups, so two
  characters can target the same group. `create_group_claims()` (in `actions/context.ts`) hands a
  group to exactly one character; the loser picks the next sure-win group.
- **A group fight has a 60 s join window and is one shared object** — the fight force-starts
  `PLACEMENT_FORCE_MS` (60 s) after the leader engages, and the group is consumed on chain at that
  engage. So `actions/party.ts` stages every partner to the group *before* engaging and joins them
  in the same pass; and every mutating submit for one fight is serialized by
  `fight_runtimes.with_lock` (two allied seats placing onto one start cell abort the second tx).
- **Settling is fight-wide** — `settle_pending` settles every seat of a fight in one transaction.
  The old per-character `last` detection (`row.character !== me`) misfires for a shared fight,
  because all four seats belong to the same address. The kiosk is shared, so one character settles
  the whole party.
- **Fight policy is deliberately conservative** — `MIN_WIN_RATE = 0.8` over 5 seeds, `MAX_TURNS = 30`,
  at most 6 screened candidates. Low-win-rate preview logs are normal; a session that logs previews
  but never engages may simply have no sure-win group yet.
- **A unique (non-stackable) craft must pass NO output target** — `craft_batch::assert_output_target`
  aborts `EOutputTarget` (2323) when a non-stackable output (equipment: daggers, armour, tools) is
  handed a held stack as `existing`. So `plan_recipe` sets `existing` **only** for a stackable output
  (`item_is_stackable(category)`), and the unique batch cap keeps `attempts == 1`. This was the
  recurring `craft rootshivs failed … abort code: 2323` (rootshivs is category `daggers`).
- **Vendored code** — `packages/{sdk,fight,protocol,immutable}` are copies. Edit them **only** if you
  also intend to change `../aresrpg`; otherwise `sync_vendor.mjs` will (correctly) flag drift.
- **Terminal link states** — `replaced` and `rejected` end the run (a takeover or a bad signature
  cannot be recovered by retrying); transient drops reconnect in place.
- **One bot process, period** — the one-socket invariant also forbids a second *process*. Two
  `bun run bot` / `farm4.ps1` copies share the same signer, so each evicts the other's socket
  (`REPLACED`) and both then drive the same characters against a stale projection. The tell-tale
  symptoms are bursts of chain aborts — `combat::resolve_spell` `EOutOfRange` (1716),
  `combat::ready` `ENotPlacement` (1706), `craft_batch::input_quantity` `EInputShort` (2322) — plus
  erratic engage/roam. `farm4.ps1` now stops any running bot (matched by its bun command line, since
  `Start-Process -WorkingDirectory` does not put the repo path in the command line) before launching.
- **A kiosk only hands out items that are neither listed nor worn** — `packet/inventory` is the
  account's ONE flat inventory and still carries items the kiosk cannot extract: the account's
  ACTIVE market listings, and items already worn by a character. `kiosk::list` aborts
  `dynamic_field::add` (`EFieldAlreadyExists`, code 0) when the item is already listed, and
  `EItemNotFound` (11) when it has left the kiosk for a character's address. `gather.ensure_tool`
  therefore filters both out via the shared selector `unavailable_item_ids` (from `packet/listings`
  + every character's `equipment`, folded in `state/store.ts`), and craft's ingredient/output
  selection does the same; any new extraction door (equip / craft / feed) must too.
- **`travel_to` counts blocks, not poll loops** — the walk is gated to one block per `step_min_ms`
  (~92 ms, the authored speed law), so a long leg needs many poll iterations. `travel.ts` must
  count *steps taken* against `MAX_LEG_STEPS` (and bound a stuck chain clock with a wall deadline);
  counting iterations aborts a legitimate ~18,000-block leg after ~9,000 blocks, which looks like
  "the bot never arrives" (the roam logs `leg paused: travel_to exceeded 20000 steps`).
- **Reaching the level band is a long walk** — `plan_roam` advances to
  `target_distance(level, world)` (up to `MAX_ROAM_DISTANCE = 20,000` blocks from the world centre),
  so a character that starts near the centre can walk for many minutes before its first fight. The
  on-chain checkpoint only moves at an action door (`search_zone` / `ensure_zone`), so **killing the
  process mid-walk** leaves the server's tracked window ahead of the client's chain pose; a restart
  re-syncs the pose to the checkpoint and re-walks. Let it run; don't restart it repeatedly.
- **Benign `provided version doesn't match … NOT submitted`** — two party members mutated the same
  shared object between build and submit (or the kiosk/cap version moved). It is a caught pass error
  that self-heals on the next pass; it is not a crash and needs no special handling.

## Environment (read only in `config.ts`)

| var | default | meaning |
| --- | --- | --- |
| `SUI_NETWORK` | `mainnet` | `mainnet` or `testnet` |
| `DISCORD_WEBHOOK_URL` | – | notifications are silently skipped when unset |
| `DISCORD_MENTION` | – | prepended so a phone buzzes |
| `BOT_GATHER` / `BOT_FIGHT` / `BOT_ROAM` / `BOT_CRAFT` | all `true` | play toggles |
| `BOT_GROUP` | `true` | fight as ONE party: the leader engages and every partner joins the same fight |
| `BOT_PARTY_SIZE` | `4` | characters driven at once (1..4), all on one socket |
| `BOT_LEADER` | `omori` | character name that opens the party's shared fights |
| `BOT_CHORE_PLAN` | default roster | JSON map of character name → `"craft"` / `"none"` / `"FARMER"` \| `"HERBALIST"` \| `"MINER"`; default is omori=craft, the other three each own one gathering job |
| `BOT_IDLE_SLEEP_MS` | `5000` | idle decision-pass sleep |
| `ARES_CHARACTER_ID` | – | pin one character; otherwise the whole roster is used |
| `ARES_WORLD` | `nauvis` | fallback world |
| `BOT_STATE_DIR` | `.state` | ledger + pending-transaction storage |
| `ARES_SERVER_WS_URL` | `wss://server.aresrpg.world/` | realtime server |
| `ARES_ORIGIN` | `https://aresrpg.world` | Origin header the handshake expects |

## Vendoring

`bun scripts/sync_vendor.mjs` copies `sdk`/`fight`/`protocol`/`immutable` `src` (+ the SDK's
`examples`) and the runtime `seed/content` files from `../aresrpg`, preserving the monorepo layout
so cross-package relative paths (`packages/sdk/src/pins.ts -> ../../../pins.json`,
`packages/sdk/examples/* -> ../../../seed/content/*.json`) keep resolving. `--check` reports drift
without writing. The deployment pins live in `pins.json`; content addresses derive from the
**original** seed package id, never the upgraded one.
