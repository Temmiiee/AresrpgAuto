# @aresrpg/bot

A headless automation bot for a real AresRPG player's party — built directly on the game's own
`@aresrpg/sdk` (not the web client, not browser automation), signing in via the same zkLogin
flow the real app uses. No private key ever leaves your machine; there's nothing to export.

Lives inside the vendored `aresrpg` monorepo clone (`vendor/aresrpg-src/packages/bot`) as a Bun
workspace package, because `@aresrpg/sdk` and `@aresrpg/fight` are private, unpublished
packages pinned to exact dependency versions — this is the only way to use them without a
version-mismatch risk.

## Setup

```sh
bun install   # from the repo root, vendor/aresrpg-src
cd packages/bot
```

Edit `src/config/party_config.ts` with your own party: the 4 (or fewer) character object ids, their
classes, which one leads, the Party object id (see the README section below for how to find
one you don't have handy), and the world name. The committed values are one real party used to
build and test this bot — replace them with yours.

```sh
bun run enoki-login   # one-time interactive Google sign-in; cached after (.enoki-session.json)
```

The very first run prints a Google login URL — open it in a browser and sign in with the same
account you use for aresrpg.world. After that, every other command reuses the cached session
headlessly until it naturally expires.

## Usage

```sh
bun run group-fight    # one full fight: search, engage, join, ready, fight, settle
bun run session [n]    # loop fights back-to-back (omit n to run indefinitely) — see below
bun run dungeon        # assign/confirm today's mastery quest, clear it if keys allow — see below
bun run session-stats  # terminal summary of session.jsonl
bun run dashboard      # live web view of the same data — http://localhost:5180
bun run faucet-check   # one-shot: claim testnet SUI if the wallet balance is low
bun run auto-sell      # one-shot: plan (and optionally --live execute) HDV listings — see below
```

Position **chains automatically** between fights — the very first fight needs a starting
position (`INITIAL_CHAIN_X`/`INITIAL_CHAIN_Z` in `party_config.ts`, in the chain's coordinate
grid, not the 3D voxel coordinates the game UI shows — see `chain_to_client_coordinate` /
`client_to_chain_coordinate` in `packages/immutable/src/world.ts` for the conversion). Every
fight after that uses the position the last one actually happened at (`position.local.json`).

## How it decides what to do

- **Difficulty check** — skips any mob group whose average level is more than
  `MAX_LEVEL_MARGIN` above the party's own average level, rather than picking a fight it can't
  win. Scans every group in the searched zone and picks the nearest one that qualifies.
- **HP-regen gate** — waits for the slowest-healing character to reach `MIN_HP_FRACTION` (80%)
  of estimated max HP before starting another fight, projected from HP-at-last-fight-end plus
  the game's flat 1 HP/second regen rate (there's no on-chain read for "current regenerated
  HP" outside combat, so `hp-state.local.json` tracks the bot's own best estimate across runs).
- **Real movement** — `src/fight/fight_geometry.ts` reuses `packages/fight`'s own deterministic TS
  twin of the Move combat grid (`fight_path_to`, `bfs_cast_cell`, `approach_field`) to find the
  nearest reachable cell in range + line-of-sight for a given attack, so the bot's movement
  decisions can't diverge from what the chain will actually accept.
- **Damage-per-AP spell ranking** — `src/ai/spell_catalog.ts` scores each known spell by its
  authored direct-damage effect divided by its AP cost (not raw damage — a spell that's
  cheaper AND nearly as strong should usually win over one big expensive cast), classifying
  spells as `damage`, `support` (a buff/heal aimed at an ally or self), or `other`
  (traps/displacement/utility, which the current logic doesn't use well and skips).
- **Multi-action turns** — a character spends its *whole* AP budget each turn where it can:
  the turn loop greedily picks the best remaining affordable, reachable action (repeatedly)
  instead of stopping after one spell, composing them into a single `[move, cast, cast, …]`
  transaction. This is the main lever against turn count and gas cost — one big turn beats many
  small ones.
- **Ally support** — heal spells target the most-wounded living ally (self included) below
  80% HP; non-heal buffs target self. Both are ranked alongside damage spells by the same
  score-per-AP metric, so they get used when they're actually the best available action, not
  forced in every turn regardless of need.
- **Learned spell effectiveness** — `src/ai/spell_memory.ts` tracks, per class and spell name,
  how often a cast actually lands once tried (persisted in `spell-memory.local.json`), and
  multiplies each candidate's score by that success rate. A spell that keeps failing for this
  party's usual positioning gets tried less over time; nothing is hardcoded — it's inferred
  from real attempts.
- **Focus fire** — every turn's target is whichever living enemy currently has the lowest HP.
  No shared coordination needed: since every character's turn re-reads the same live state,
  the whole party naturally converges on one target without any extra bookkeeping.

All of the above lives in exactly one place, `src/fight/fight_session.ts` — both `group-fight` (one
fight) and `session` (looping) call it, so there's a single source of truth for the combat logic.

## Running unattended

`cli_group_session.ts` runs fights in a loop, appending each result to `session.jsonl`, and
retries rather than crashing on errors (a transient network hiccup waits 30s; "no suitable mob
group in this zone" waits 10 minutes, since zones only reroll every 2h). Ctrl+C to stop — an
in-progress fight (if any) resumes cleanly on the next run via `group-state.local.json`.

**Gas-cost check**: the dev's own guidance is ~0.02 SUI **per character**, not per fight — a
group fight charges every owned participant's turns, so this committed 4-character party's
normal fight totals ~0.08 SUI. `GAS_WARN_MIST` (`src/state/session_stats.ts`) flags at 5x that
per-party baseline (scaled by `party_config.ts`'s actual roster size, so it stays correct if you
run a different party size) rather than a flat number. Both `group-fight` and `session` print a
warning with the fight id and wallet address whenever a fight crosses that threshold;
`session-stats` and the dashboard also list every flagged fight from the log.

To actually run this in the background: start it in its own terminal window/tab and leave it,
or use your OS's usual tools (a background terminal tab, `start /min`, a scheduled task,
tmux/screen, etc.) — nothing here needs a Claude session to stay open.

### Dashboard

`bun run dashboard` starts a tiny local web server (port 5180) serving a single
self-contained page — open `http://localhost:5180`. It polls every 2s and shows: whether the
session looks alive (a status update within the last 60s counts as "running" — a local-file
freshness check, not real process supervision), the live status line, session-wide stats
(fights/win rate/gas/XP), the mob types **and levels** fought, a banner for any 0.1+ SUI
fights, and a table of recent fights. It reads only local files — no wallet, no chain calls, no
cost to leave open, and it works even before a session has ever run.

## Files

`src/` is organized by domain, not flat: `auth/` (sign-in, SDK wiring), `fight/` (the group-fight
engine), `dungeon/` (the daily mastery quest + dungeon runs), `ai/` (the evolutionary policy,
simulator, lookahead), `market/` (auto-sell, pricing, kiosk reads), `state/` (local
`*.local.json`-backed state), `cli/` (every runnable entry point), `shared/` (chain retry,
network config, cross-cutting reads), `config/` (the party roster). This list is selective, not
exhaustive — see "On building a stronger combat AI" below for the AI-side
files, or just read a domain folder directly.

- `src/config/party_config.ts` — the party roster (characters, party id, world, starting position) —
  the one file to edit for a different party
- `src/auth/enoki_auth.ts`, `src/auth/enoki_store.ts` — headless zkLogin sign-in (a Signer, not a raw key)
- `src/auth/sdk_client.ts` — wires `@aresrpg/sdk` + its `character`/`fight` action builders to that
  signer (the kiosk cap is re-fetched fresh on every call — a cached ref goes stale after the
  very next transaction)
- `src/fight/fight_session.ts` — the shared group-fight engine's thin orchestrator (both CLIs
  below call it), sequencing four phase modules in the same folder: `fight_progression.ts`
  (pre-fight stat/spell spending), `fight_discovery.ts` (search/screen/engage), `fight_turn.ts`
  (the live turn-decision loop), `fight_settle.ts` (settle + loot). `fight_state.ts` holds the
  shared raw-chain-JSON types/reads all four build on.
- `src/fight/fight_geometry.ts` — movement/targeting geometry via `packages/fight`'s deterministic
  Move twin
- `src/ai/spell_catalog.ts` — damage-per-AP-ranked castable spells per class/level, read straight
  from `seed/content/spells.json`
- `src/ai/spell_memory.ts` — learned per-spell success rate across fights
- `src/state/hp_state.ts` — HP-at-fight-end tracking for the pre-fight regen gate
- `src/shared/zone_read.ts` — read-only zone content (mob groups) via a simulated Move view call —
  devInspect is dead on public testnet fullnodes, so this uses `sdk.simulate(...,
  { include: { commandResults: true } })` instead
- `src/state/group_state.ts`, `src/state/position_state.ts`, `src/state/status_state.ts`, `src/state/session_log.ts`,
  `src/state/session_stats.ts` — local state: in-progress-fight resume, last known position, the
  dashboard's live status line, the append-only fight log, and shared stats computation
- `src/cli/cli_enoki_login.ts` — read-only: signs in and lists your characters, to confirm the bot
  is looking at the right account before it's ever allowed to touch it
- `src/cli/cli_group_fight_loop.ts`, `src/cli/cli_group_session.ts`, `src/cli/cli_session_stats.ts`,
  `src/cli/cli_dashboard.ts` — the runnable entry points

## Auto-equip

After every fight settles, `src/market/auto_equip.ts` tries to fill every EMPTY equipment slot on every
character from the account's spare (unlisted, unequipped) kiosk inventory — highest item level
first per slot, since gear power scales with level here. It does **not** try to upgrade a slot
that's already occupied: reading what's currently equipped means decoding a nested on-chain
dynamic field (`EquippedRecord` — item stats, damages) with no real captured payload to build
and verify that decoder against, which is exactly the failure shape code-law's L-D4 exists to
prevent. Filling empty slots needs none of that — every character starts with nothing worn, so
this is real, safe value without it. One `equip` call per candidate slot (not one batched call
per character): a batch is all-or-nothing, and without reading current gear there's no way to
know in advance which slots are already taken, so batching would let one occupied slot cost
every other, genuinely empty slot its equip too. An occupied slot, a level requirement, or a
duplicate relic template are the expected, zero-gas outcome of trying — logged only if something
else went wrong. Runs automatically; nothing to opt into.

## Testnet SUI: automatic top-up

`session` checks the wallet's live balance before every fight (`sdk.read_sui_balance()`) and,
whenever it drops below `DEFAULT_MIN_BALANCE_MIST` (`src/market/faucet.ts` — ~15 fights of headroom at
this party's actual size, ~1.2 SUI for the committed 4-character roster), claims from the
same official testnet faucet endpoint the frontend's own "Add funds" modal points players at
(`requestSuiFromFaucetV2` against `getFaucetHost('testnet')` — an unauthenticated, rate-limited
developer API Mysten Labs runs for this purpose, not the captcha'd browser page at
faucet.sui.io). A claim attempt (success or failure, including a rate-limit backoff) is logged
inline with the fight output; the session keeps running either way — a failed claim just means
the next fight may error out on gas, which the existing retry loop already handles.

Recipient is always the bot's own live signed-in address (`bot.address`, derived from the
zkLogin signer) — never a hardcoded one — so it always tops up the wallet actually paying gas.
Run `bun run faucet-check` standalone any time to check/claim without starting a session.

## Mainnet readiness

The game itself hasn't deployed to Sui mainnet yet — `pins.json`'s `mainnet` entry is still every
field `null` (checked 2026-09-06). What's here is the bot's own code-side readiness, so flipping
the switch the day that changes is a one-line env change, not a scramble:

- **`SUI_NETWORK=testnet|mainnet`** (`src/shared/network_config.ts`, default `testnet`) is read
  once and threads through `src/auth/sdk_client.ts` and `src/auth/enoki_auth.ts` — nothing else
  hardcodes a network. `SUI_RPC_URL` overrides the default public RPC endpoint for either network.
  `ENOKI_API_KEY` overrides the baked-in (testnet-scoped) Enoki key — an Enoki key is registered
  in the Enoki dashboard against a specific set of allowed networks, so the testnet key may
  simply be rejected on mainnet; this repo can't know the real mainnet key in advance.
- **The testnet faucet auto-gates off** (`src/market/faucet.ts`) the moment `SUI_NETWORK` isn't
  `testnet` — no wasted calls to an endpoint that wouldn't exist for real funds.
- **Two real spend circuit breakers** in the session loop (`src/cli/cli_group_session.ts`):
  `MAX_CONSECUTIVE_LOSSES` (default 5) and `MAX_SESSION_GAS_SUI` (default 1) actually STOP the
  loop instead of only logging a warning past them, as `GAS_WARN_MIST` alone used to.

**What's still a manual, non-code step before a real mainnet run**: a funded mainnet wallet, a
verified mainnet Enoki API key + Google OAuth audience (the same Google account/zkLogin identity
the real game client uses there), and a human sanity check of `item_prices.json`'s fallback
pricing (`item_valuation.ts` calls it an unverified guess even on testnet) before letting
`auto-sell` run unattended against real value. None of these are things code can supply blind.

## HDV auto-selling (testnet now, mainnet-ready)

`bun run auto-sell` prices and lists the bot's spare kiosk inventory on the marketplace — built
and testable on testnet today, and works unchanged on mainnet once that exists (only
`SUI_NETWORK`/`SUI_RPC_URL`, see "Mainnet readiness" above, need to point there).

- **Reading inventory** (`src/market/kiosk_inventory.ts`) goes straight to the chain — the bot's own
  kiosk contents via `@mysten/kiosk`'s `getKiosk`, no dependency on the game server's
  authenticated websocket protocol (`packet/market_observe` and friends), which this headless
  bot never connects to. Equipped items are structurally absent from the result: equipping SENDS
  the item out of the kiosk to the character's own address (`equipment.move`'s own module doc) —
  so anything unlisted here is, by construction, spare inventory, never gear a character has on.
- **Pricing** (`src/market/market_pricing.ts`) is pure sequential price discovery, not a live
  order-book read — there is no public way for a headless bot to see OTHER sellers' listings
  (that's the same websocket-only market feed above). A first-ever listing for an item type
  undercuts the estimated fair value by 15% (the point the dev flagged: an early/thin market has
  no visible comparable price, so pricing to actually get seen matters more than maximizing the
  first sale); a later listing rises 10% after a fast sale (<6h) or cuts 12% after one that sat
  unsold, floored at 40% of the base estimate either way.
- **The base fair-value estimate** is `item_valuation.ts`'s `get_item_price` — a custom override
  from `item_prices.json` when one exists (currently only the 7 raw materials), else a
  level-scaled flat fallback. That fallback is an uncalibrated placeholder for every equipment
  item_type today; treat early auto-sell prices as rough until real sales (or manually researched
  comparables) get written into `item_prices.json`.
- **Outcomes** (`src/market/market_history.ts`, `market_history.local.json`) are inferred from kiosk
  state, not a sale event feed: a listed item disappearing from the kiosk means sold (the only
  way custody leaves, since nothing here delists automatically); present-but-unlisted means
  someone delisted it by hand. `reconcile_market_history` (run automatically at the start of
  every `auto-sell` invocation) resolves every open record this way before planning the next
  pass, which is how the adaptive pricing above gets its signal.

`auto-sell` defaults to a dry run: reconcile, plan, print what it *would* list and at what
price — nothing is signed. Pass `--live` to actually submit the listings. It's a one-shot command
by design, not wired into `session`'s loop — selling is a deliberate, reviewed action, run by
hand or from your own scheduler, not something a fight loop should trigger unattended.

## Standalone build

`bun run build-standalone [output-dir]` (default: `../../standalone-bot`, a sibling of this
checkout) assembles a minimal, self-contained copy of the bot: its own source plus the exact
dependency closure of the private, unpublished workspace packages it imports (`@aresrpg/sdk`,
`@aresrpg/fight`, `@aresrpg/immutable`, `@aresrpg/protocol`) — none of the game's
frontend/engine/indexer/move/3D-and-audio assets. `cd` in, `bun install`, and it runs the same
commands as above.

This is a **snapshot, regenerated from this checkout, not a permanent fork** — those packages
are pinned to an exact game version specifically so the bot never silently drifts from the live
game (the whole reason it lives inside this checkout at all). Re-run the script after every
`git pull` here rather than hand-editing a standalone copy.

## CI

`.github/workflows/verify.yml` assembles the exact same tree `bun run build-standalone` builds
locally — this repo plus a fresh clone of the game's private `@aresrpg/sdk`, `@aresrpg/fight`,
`@aresrpg/immutable`, `@aresrpg/protocol` — and typechecks it. Runs on every push/PR, **and on a
weekly schedule independent of any push here**, so a game update that moves one of those
packages out from under the bot gets caught even when nobody touched this repo that week — the
one signal the scheduled game-changelog review can't give, since that routine has no access to
this source to compare against. Most spots that used to lean on the shared SDK's own narrower
structural types (or on a plain cast papering over a real mismatch, like `zone_read.ts`'s
mob-group `index` once being declared `bigint` when `bcs.u64()` actually parses to a decimal
string) are widened or corrected locally, without touching that shared package.

**Known current CI failure (2026-09-06), left as-is for now, on purpose**: `fight_settle.ts`
reads `drops_rolled` off a `fight.settle()` receipt — real, working, confirmed live (see that
file's own header comment on why: `fight.move`'s `DropsRolled` event is the only place a fight's
actual loot roll is observable). That field only exists because `packages/sdk/src/fight.ts` in
THIS machine's vendored checkout carries a local, uncommitted patch (`git diff` there shows it)
that reads `fight.move`'s `DropsRolled` event and adds `drops_rolled` to `FightReceipt` — it was
never upstreamed to `aresrpg/aresrpg`. CI's fresh clone of `edge` doesn't have that patch, so
`FightReceipt` there has no `drops_rolled` field and typecheck fails on exactly that line. The
loot-reading behavior itself is correct and live-verified on THIS checkout; the gap is that
nothing ships the patch that makes it typecheck (or work at all) anywhere else. Not resolved in
this pass — left for whoever owns the upstream contribution.

## Fixing an already-misallocated character

`prepare_party` only shapes NEW stat/spell points — it never retroactively fixes points already
spent before `DEFAULT_PRIMARY_STAT_SHARE` (stat_allocation.ts) or `caster_damage_multiplier`
existed, or before the game had a "reset" concept a player might have spent freely against.
`bun run reset-character <name> [--stats-only|--spells-only]` uses `scroll_of_rebirth`
(`character.move`'s `reset_stats` — every level-granted point returns) and/or
`scroll_of_oblivion` (`progression.move`'s `reset_spells` — the raised-spell book clears, points
refund) on the named character. If a scroll isn't already in the kiosk, it's redeemed
automatically from the mastery shop (10 points each, see "Dungeons & the daily mastery quest"
below) rather than bought — there is no shop-purchase door anywhere in this codebase (an earlier
one existed and was removed/restructured upstream; see `cli_reset_character.ts`'s own header).
Refuses cleanly if there aren't enough mastery points yet, instead of guessing at a door that
doesn't exist. The very next `group-fight` / `session` run re-spends the refunded points
correctly through the normal `prepare_party` flow — this script only clears the slate, nothing
more.

## Dungeons & the daily mastery quest

`bun run dungeon` assigns (or confirms) the account's daily mastery quest and, if the party
already holds enough dungeon keys, clears the assigned dungeon room by room — `cli_group_session`
also checks this automatically, at most once every 6h, so an unattended `session` run picks up
each new day's quest on its own. See `dungeon/dungeon_session.ts` for the full flow.

- **The quest is address-wide, not per-character** (`mastery.move`): once per chain epoch
  (~1 real day), it randomly assigns one of the world's dungeons; completing that dungeon's LAST
  room within the same epoch (not just any room) is what counts. Missing a day doesn't just skip
  that day's point — it resets the whole accumulated streak, so running this daily matters more
  than any single completion.
- **Every character needs its own key** — `dungeon.move`'s run state lives on each individual
  character, and joining a room fight together requires each joiner to already hold a matching
  run (their own key burned at entry). Running a 4-character dungeon costs 4 keys, not 1.
- **Missing keys get crafted automatically** (`dungeon/dungeon_keys.ts`, `character.craft`) —
  bounded to exactly how many keys are still needed, never more: crafting has a real success rate
  (progression.move: 50% + 0.5%/level, capped 99%) and BURNS ingredients on a failed attempt too,
  so this is one best-effort batch per run, not a retry-until-success loop chasing bad luck with
  more materials. Still logs and does nothing (spends nothing) if the party doesn't hold enough
  raw ingredients (`seed/content/recipes.json`, e.g. `key_of_gilded_lorito` from
  `stone_lorito_plume` + `quartz_set_trinket`) for even one craft.
- **Auto-sell holds back today's key ingredients** (`market/auto_sell.ts`'s
  `reserved_for_todays_quest`) — while the daily quest isn't completed yet, the exact raw
  materials the assigned dungeon's key recipe needs are excluded from what `auto_sell_spare_loot`
  lists on the HDV, so the automatic seller never sells out from under a pending crafting attempt.
  Only applies to the automatic, unattended sell path; the manual `bun run auto-sell` /
  control-panel review flow still shows everything, since a human reviewing the list should see
  the full picture.
- **Room fights reuse the exact same live turn-decision loop** as open-world fights
  (`fight/fight_turn.ts`, unchanged) — a dungeon room is an ordinary `Fight` object underneath,
  just tagged, so combat quality here tracks whatever policy is currently loaded the same way.
- **Dungeon room loot isn't logged yet** — the same local, unshippable SDK patch this README's
  "CI" section documents (drops_rolled) was only ever applied to the open-world settle path, not
  `dungeon.ts`'s. Loot is still correctly awarded on-chain; this bot's own logs just don't show
  what dropped in a dungeon room specifically.

## Known gap: resource gathering

`gathering::gather` requires a job tool equipped (`tool_farmer` / `tool_herbalist` /
`tool_miner`). As of this beta's seed content (`seed/content/`), there is no shop sale, no
craftable recipe, and no mob loot drop for any starter tool (e.g. `basic_pickaxe`) — so a fresh
character currently has no way to begin gathering at all. This looks like missing beta content
rather than a bug; worth flagging to the team. `src/shared/zone_read.ts` already supports reading live
resource packs (`read_resource_pack`) for whenever that's seeded.

Re-checked 2026-09-03 after the parties/dungeons update: `items.json` now defines starter tools
(`basic_pickaxe`, `old_hoe`, `tool_herbalist`) that didn't exist before, but `recipes.json` and
`mobs.json` still carry zero references to any `tool_*` item — the acquisition gap is unchanged.
Nothing to automate here yet. (Re-checked again 2026-09-06: `shop.json` no longer exists in the
seed content at all — the shop-purchase mechanism this note originally referenced has since been
removed/restructured upstream with no replacement seeded yet; see `cli_reset_character.ts`'s own
header for where that gap surfaced concretely.)

## On building a stronger combat AI

`packages/fight` runs entirely offline, with no chain calls needed — that's what makes a real
self-play search/training loop *possible* for this game without spending gas to train it (unlike
most "let's RL a blockchain game" ideas). This bot now owns that loop natively, not via the
sibling `AresRPG-RL` Python repo (which attempted a PPO neural-net approach first — a documented
dead end, seven configurations, all collapsing to random-policy quality — then pivoted to
porting THIS bot's own evolutionary design back into Python; it's since been archived, no
further active work planned there):

- `ai/policy.ts`'s 6-weight `Policy` (damage/kill-priority/finish/heal/strike-bias/element
  matchup) scores every legal candidate action.
- `cli_train.ts` SEARCHES that vector — a (μ+λ) evolution strategy against
  `ai/simulate.ts`'s offline fights, not a neural net (no ML framework in this environment) —
  and only saves a result to `learned_policy.local.json` once it clears a held-out validation
  gate (`HOLDOUT_SEED`, distinct from training) by a minimum margin, so an in-sample-only
  improvement that doesn't generalize never gets adopted.
- `ai/lookahead.ts` rolls the top-K single-turn plans forward a few turns (both sides, the same
  policy) and picks whichever scores best — a real, if shallow and bounded, search on top of the
  weighted scoring, live-only (too slow to run inside the training loop's thousands of decisions).
- `ai/spell_memory.ts` learns each spell's real landing rate per class, live-only, and multiplies
  every candidate's score by it.

Matching something like OpenAI Five's Dota bots would still take massively more compute and
months of dedicated engineering than any of this — a genuinely deeper search (real multi-ply
MCTS, or a locally-trained neural policy) remains a real, multi-day undertaking beyond what's
here. `cli_validate_policy.ts` is the tool to check whether any future change to this pipeline
actually generalizes before trusting it live.

**Known tradeoff to revisit once that lands**: `fight_session.ts`'s `MAX_LEVEL_MARGIN` and
`MIN_SIM_WIN_RATE` currently bias hard toward safe, winnable fights — which is why every recent
session logs a 100% win rate, and also exactly why: avoiding anything risky enough to ever lose
also avoids the higher-level groups with the better XP and loot. Once a trained policy
measurably wins harder fights in fewer turns (`cli_validate_policy.ts`'s held-out comparison is
the signal), those two constants should loosen — see the TODO at their definition.
