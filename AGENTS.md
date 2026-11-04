# AGENTS.md — context for working on AresRPGAuto

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
AresRPGAuto/
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
          loot_box.ts       open + claim deterministic 50-resource protector bags
          pet.ts            daily feeding + obtainable pet-food craft/gather demand
          combat.ts         hydrate/drive/engage/settle fights (the fight driver)
          equip.ts          auto-equip: score gear + allocate it across the party
          gear.ts           craft goals: best craftable weapon/armour per character level
          party.ts          the group-fight rendezvous shared by every character (PartyState)
          fight_preview.ts  local deterministic fight twin: screen_groups / viable_ranking
          fight_preview_offload.ts bounded worker pool for live combat previews
          turn_plan.ts      plan_turn / next_action / sim_commands
          fight_registry.ts live fight runtime registry, fed by the fight_state stream
          dungeon.ts        dungeon key helpers (screen / park an entrant's key)
          dungeon_run.ts    one group dungeon run: enter each room, join with each entrant's key
          cross_world.ts    cross-world detach target picker
          excursion.ts      event-driven relocation that keeps every gatherer fed
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
# typecheck the bot (repo root; or `cd packages/bot && bun tsc --noEmit -p tsconfig.json`)
bun run typecheck

# tests
cd packages/bot
bun test

# run the bot (from the repo root)
bun run bot

# drive a party of 5 (BOT_PARTY_SIZE, 1..5)
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
3b. **group fight / chore barrier** — when `BOT_GROUP` is on and the party has partners, run the
   shared rendezvous (`actions/party.ts`). A follower always prioritizes an in-flight rendezvous, so
   it cannot wander off and strand the side; between fights it rallies to the leader's checkpoint
   (`rally_to_leader`). Once a fight-wide settlement completes, every member receives one bounded
   chore beat and the leader waits for all of them to start before creating the next target. The
   leader then screens the group **for the whole party**, engages, and joins all partners in the same
   beat. While the party is grouping only the leader opens fights.
3b0. **resource bags** — while the party is idle, the leader opens and claims one deterministic
   resource-bag stack through the shared craft/kiosk lane. This happens before a new rendezvous so
   the two-stage open/claim flow cannot race another shared-inventory action.
3c. **chores** — after a fight-wide settlement, mark every party member for one chore attempt and
   keep the leader from staging the next rendezvous until each member has started that beat. This is
   necessary because only one character loop wins the settlement race; marking only that runtime
   starves the other gathering roles behind continuous group fights. A party member's gather is
   capped (`PARTY_GATHER_RADIUS = 1024`) so it stays within a zone or two of the leader. A failed
   local gather or blocked recipe clears that one-shot beat (combat must not freeze), while the
   forced leader floor (`BOT_CHORE_INTERVAL_MS`, default 5 min) keeps retrying during long idle gaps.
4. **roam** — optionally drift toward worthwhile prey (`roam_once`).
5. **engage** — screen live mob groups with the local twin and open the best sure-win group (solo
   path; suppressed while the party is grouping).
6. **chores fallback** — gather one node and craft one batch when no fight is on offer.

Outside the per-character pass, a coalesced party-wide **auto-equip** run fires when a new equipment
id appears (see `## Auto-equip` below), retrying every 8 s while any character is seated or stale.

`flush_summary` logs a per-character digest every `SUMMARY_EVERY_FIGHTS = 10` settled fights. The
console also prints startup milestones, action outcomes, meaningful waits/holds, and a health line
every 15 seconds once the character loops start. That line includes connection and state freshness,
the last successful ledger action, each character's pass status, and active fight. Passes taking at
least 60 seconds warn. A one-line logger configuration is printed at process startup even when the
normal logger is filtered, because SDK transaction output bypasses the app logger. Discord gets a
startup message, exactly ONE party-wide digest per `BOT_DIGEST_MINUTES` (hourly by default; 0 disables
it), fatal-crash messages, and the zkLogin sign-in link — no per-action chatter. Digest loot is
decoded from settlement `DropsRolled` events; gathered totals count successful harvests and claimed
protector-bag resources; crafted totals count successful outputs. A `none` value is therefore an
honest zero for that process window, not a potential-reward estimate.

## Group fights (`actions/party.ts`)

`BOT_TEAMS` optionally partitions the driven roster into independent coordinated squads. Each JSON
array is one squad and its first character is the leader; each squad has separate rendezvous,
dungeon, excursion and strategy state, while the websocket, live-group claims, equipment pool and
transaction signer remain shared. This lets squads fight different live groups and perform their
per-character chores concurrently without opening a second socket for the same account. Keep the
total named characters within `BOT_PARTY_SIZE`; an absent team member is logged and skipped. With no
`BOT_TEAMS`, the established single-party behavior and `BOT_LEADER` setting are unchanged. Set
`BOT_GROUP=false` to make every selected character fight independently instead of forming the
configured squads.

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
`MAX_STAGE_FAILURES` (5) the party plays solo for `GROUP_COOLDOWN_MS` (60 s) before trying again.
`ACTIVE_GRACE_MS` (60 s) covers the roster/indexer lag after an engage.


## Auto-equip (`actions/equip.ts`)

Every character wears the best gear it can legally wear, drawn from the party's ONE shared kiosk
inventory and swapped in with a single PTB. There is no per-class equipment restriction on chain
(`equipment.move` gates only slot, character level and duplicate relics), so "best for its class and
stats" is a SCORING question:

- **Score** uses the game's own item-budget unit `rune_unit_weights` (1 raw damage ≈ 20 primary
  points, 1 AP = 100, 1 MP = 90, 1 range = 50, 1 crit = 30) applied to `item_stat_offset` (the raw
  centered u16 signed offset, pet blocks scaled by `pet_power`). The four elemental stats are then
  re-weighted by the character's **affinity**: its class kit blended 50/50 with whatever
  STR/INT/CHA/AGI it has actually allocated (pure class affinity when nothing is allocated).
- **Allocation** (`plan_loadout`) is party-wide and leader-first: one pass claims each item for at
  most one character, so the shared kiosk never assigns the same item to two wearers. It never
  equips above the character's level, never duplicates a relic type, and restricts the tool slot to
  the category the character's chore needs.
- **Triggers** — a newly-appearing equipment inventory id (startup, drop, craft, purchase) requests a
  run; a coalesced party-wide runner then retries every `EQUIP_RETRY_MS` (8 s) while any character is
  seated or stale. A character in a fight (`custody === 'fight'` or an `active_fight`) is skipped and
  retried — the kiosk borrow aborts during fight custody.

## Gear crafting (`actions/gear.ts`)

Auto-equip places the best gear the party OWNS; `gear.ts` makes the party own better gear. It scores
every CRAFTABLE wearable in the seed with the same rune-weight + affinity math, keeps those at or
below a character's level that beat what that character could wear today, and returns their output
types as a **priority list** the craft planner (`select_craft_target`) tries BEFORE the xp rotation —
so the party mints what it will WEAR before spending the same materials on xp filler. Gear goals allow
zero-XP crafts (a 2-slot weapon still beats fists at job level 100), the rotation remains the
fallback. Held equipment is allocated once in the same leader-first order as auto-equip: one usable
copy satisfies one character, while a weak random roll that loses to the worn piece or another
character needing the same output keeps the craft goal alive. A goal's inputs are demanded through
`craft_gather_demand`'s `extra_outputs`, which the play loop fills with the goal outputs — pulled even
when the craft pays no XP, because the goal is deliberate, not filler.

Gear acquisition is staged in `plan_gear_craft_steps`: craftable upgrades unlocked by any current team
member come first, followed by only the nearest job-level unlock that improves a slot. Do not put all
far-future recipes into craft priorities; doing so makes the XP rotation train several blocked jobs
before taking a reachable upgrade. `gear_drop_candidates` includes items with recipes when they also
have a mob loot source. `plan_loot_focus` must test every source family and difficulty band with the
fight twin, keep its normal win-rate gate, and rank only viable drops by expected item quantity per
committed turn. A stronger theoretical drop is not a farming order if no screened band can beat it.

## Dungeon runs (`actions/dungeon_run.ts`)

Dungeon keys are deliberate party goals: the leader focuses gather and craft demand on one
unparked key at a time until the shared inventory holds the two keys needed to commit a group run.
An under-level key remains a goal so the craft planner trains its required trade instead of dropping
the dungeon objective. Once a dungeon is parked after failing its room previews, its key is skipped
until the retry window expires and the next key can become the goal. The runner still screens every
room with the fight twin before spending keys; do not lower that safety gate without a verified
combat reason. Group previews use the strongest available party members first. The general craft
rotation excludes `old_hoe` and `basic_pickaxe`.

Only members in the leader's world and within `REJOIN_RADIUS` are committed to a run. Room previews
that fail only because entrants are wounded are retried at most every 30 seconds while HP recovers;
a room that still fails at full HP abandons the run. This prevents both premature key spending and
the old loop that re-simulated four fights every few seconds as regeneration changed the cache key.

## Resource protector bags (`actions/loot_box.ts`)

Protector victories mint `loot_box` consumables whose seed definition has one guaranteed resource
reward of 50 units. The leader opens at most 50 bags from one stack, immediately claims the batch,
and merges it into an existing resource stack when available. Recognition is content-driven: an
ordinary loot box, a weighted/multi-reward box, or a non-resource reward is never opened by this
maintenance action. Ledger entries record the open and claim transactions separately.

## Daily pet maintenance (`actions/pet.ts`)

With `BOT_PET_FEED=true`, the idle party leader feeds each eligible owned pet at most once per UTC
day until the authored power cap. A worn pet is unequipped, fed and re-equipped atomically through
the SDK, and every successful feed is recorded in the ledger and Discord digest. Obtainable food is
added as an isolated craft objective; missing rare ingredients become demand for the shipped-world
resource that rolls them. Foods whose ingredients exist only in future immutable tiers absent from
all shipped worlds are reported once and parked, while already-held legacy food remains usable.

## Strategy brain (`actions/strategy.ts`)

Once every `BOT_STRATEGY_INTERVAL_MS` (30 min) the play loop runs ONE whole-content pass and publishes
it in a shared ref. It reuses the SAME twin the engage uses (`fight_preview.score_mobs`), so it can
never disagree with a live decision about what is winnable:

- **Farm target** — for each zone-difficulty band it prefilters the roster to the families the chain
  still pays XP for (the `highest*5 >= level*2` floor), simulates the best couple with a two-seed twin,
  and picks the band whose likely group pays the most XP per committed turn for the whole party.
  `plan_roam` takes it as an optional `targetBand`, so the roam creeps toward the brain's distance
  instead of the median-family heuristic.
- **Gear route** — `plan_gear_targets` annotates each craftable goal with `craft`/`drop` and the mob
  types whose loot carries it. The wanted mobs become a soft tiebreak in `viable_ranking` (a group that
  can drop an upgrade beats an equal-value group that cannot), and the goal outputs are folded into the
  gather demand.
- **Console only** — the pass logs its verdict; it never sends a Discord message. It is a coarse
  RANKING, not certification: the live engage still hard-screens with all five seeds.

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
  because every party seat belongs to the same address. The kiosk is shared, so one character settles
  the whole party.
- **Fight policy is deliberately conservative** — `MIN_WIN_RATE = 0.8` over 5 seeds, `MAX_TURNS = 30`,
  at most 6 screened candidates. Low-win-rate preview logs are normal; a session that logs previews
  but never engages may simply have no sure-win group yet.
- **A unique (non-stackable) craft must pass NO output target** — `craft_batch::assert_output_target`
  aborts `EOutputTarget` (2323) when a non-stackable output (equipment: daggers, armour, tools) is
  handed a held stack as `existing`. So `plan_recipe` sets `existing` **only** for a stackable output
  (`item_is_stackable(category)`), and the unique batch cap keeps `attempts == 1`. This was the
  recurring `craft rootshivs failed … abort code: 2323` (rootshivs is category `daggers`).
- **One held item type is not one copy per character** — gear planning must allocate actual item ids
  across the party before suppressing craft goals. Suppressing by `item_type` alone strands the
  second wearer and also treats a bad random roll as usable forever.
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
| `SUI_RPC_URL` | public fullnode | RPC endpoint override |
| `ARES_SERVER_WS_URL` | `wss://server.aresrpg.world/` | realtime server |
| `ARES_ORIGIN` | `https://aresrpg.world` | Origin header the handshake expects |
| `DISCORD_WEBHOOK_URL` | – | notifications are silently skipped when unset |
| `DISCORD_MENTION` | – | prepended so a phone buzzes |
| `BOT_DIGEST_MINUTES` | `60` | minutes between party-wide digests (0 disables) |
| `ENOKI_API_KEY` | public frontend key | network-scoped Enoki key override |
| `ENOKI_GOOGLE_CLIENT_ID` | public frontend id | Google OAuth client override |
| `ENOKI_LOGIN_PORT` | `5173` | local port the interactive sign-in page listens on |
| `ENOKI_LOGIN_TIMEOUT_MS` | `1800000` | how long the sign-in page waits (30 min) |
| `BOT_GATHER` / `BOT_FIGHT` / `BOT_ROAM` / `BOT_CRAFT` | all `true` | play toggles |
| `BOT_PET_FEED` | `true` | feed eligible pets daily and pursue obtainable food ingredients |
| `BOT_GROUP` | `true` | fight as ONE party: the leader engages and every partner joins the same fight |
| `BOT_TEAMS` | – | optional JSON array of character-name arrays; first name leads each independent team, e.g. `[["tomoda","mori"],["yogan","memorien","llokan"]]` |
| `BOT_CROSS_WORLD` | `true` | let the cross-world gatherer periodically detach |
| `BOT_PARTY_SIZE` | `5` | characters driven at once (1..5), all on one socket |
| `BOT_LEADER` | `omori` | character name that opens the party's shared fights |
| `BOT_CHORE_PLAN` | specialized roster | JSON map of character name → `"craft"` / `"none"` / `"gather_all"` / `"gather_all_craft"` / `"FARMER"` \| `"HERBALIST"` \| `"MINER"` / `{"kind":"gather_craft","job":"…"}`; default is Omori crafting plus one fixed job per gatherer |
| `BOT_CHORE_INTERVAL_MS` | `300000` | no-fight chore retry floor; post-fight party beats are always scheduled (0 disables only the floor) |
| `BOT_CROSS_WORLD_GATHERER` | `archero` | character that detaches for cross-world gathering |
| `BOT_CROSS_WORLD_WORLD` | – | explicit target world (unset = richest reachable) |
| `BOT_CROSS_WORLD_INTERVAL_MS` | `1800000` | ms between cross-world trips (0 disables the cycle) |
| `BOT_CROSS_WORLD_DWELL_MS` | `600000` | ms the detacher gathers per trip |
| `BOT_STRATEGY` | `true` | run the periodic whole-content strategy pass |
| `BOT_STRATEGY_INTERVAL_MS` | `1800000` | ms between strategy passes (0 runs once); first pass is delayed up to 90 s after startup |
| `BOT_CONTENT_WATCH` | `true` | compare bundled game content/rules with upstream; first check is delayed 60 s |
| `BOT_CONTENT_WATCH_INTERVAL_MS` | `21600000` | ms between upstream checks (minimum 60000) |
| `BOT_COMBAT_ANALYTICS` | `false` | write bounded per-fight JSONL diagnostic files |
| `BOT_IDLE_SLEEP_MS` | `3000` | idle decision-pass sleep |
| `ARES_CHARACTER_ID` | – | pin one character; otherwise the whole roster is used |
| `ARES_WORLD` | `nauvis` | fallback world |
| `BOT_STATE_DIR` | `.state` | ledger + pending-transaction storage |
| `BOT_LOG_LEVEL` | `info` | log verbosity: `silent`, `error`, `warn`, `info`, `debug`, `trace` (read in `shared/logger.ts`) |
| `BOT_LOG_SCOPES` | – | per-scope override, e.g. `dungeon=debug,trace=trace,party=warn` |
| `BOT_DEBUG` | – | legacy: same as `BOT_LOG_LEVEL=debug` when `BOT_LOG_LEVEL` is unset |
| `BOT_PROFILE_PREVIEW` | unset | print fight-preview planner timings (independent of the log level); leave unset in normal operation |

At every `run` startup, `main.ts` prints the effective log level, profile-preview status and scope
overrides directly to the console. SDK `tx` lines bypass the app logger, so this line helps diagnose
seeing transactions while application messages are filtered. `info` is the operational default;
`debug` adds decision detail; `trace` prints each awaited decision step. The health heartbeat is every
15 s after character loops start, and a decision pass taking 60 s or more warns. The whole-content
strategy scan runs in a worker thread so it cannot freeze the realtime event loop. See the Runtime
logs section in `README.md`.

## Vendoring

`bun scripts/sync_vendor.mjs` copies `sdk`/`fight`/`protocol`/`immutable` `src` (+ the SDK's
`examples`) and the runtime `seed/content` files from `../aresrpg`, preserving the monorepo layout
so cross-package relative paths (`packages/sdk/src/pins.ts -> ../../../pins.json`,
`packages/sdk/examples/* -> ../../../seed/content/*.json`) keep resolving. `--check` reports drift
without writing. The deployment pins live in `pins.json`; content addresses derive from the
**original** seed package id, never the upgraded one.
