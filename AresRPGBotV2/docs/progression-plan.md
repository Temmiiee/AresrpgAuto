# Progression plan — jobs, resources, zones, and leveling

Confirmed from the seed content, the on-chain game rules (`aresrpg/packages/move`), and the
immutable mirrors the bot vendors. Everything below is derived, not guessed.

> **Status (current build).** The default chore plan is `gather_craft` for every character
> (`archero` uses `gather_all_craft`), so all four gather AND level the crafting trades. The
> per-character split in §1 and the "someone else crafts for me" framing in §5 are the ORIGINAL
> plan, kept only for the still-accurate game math; §6's excursion design is implemented in
> `actions/excursion.ts` (leader-driven, `gather_needs`).

## 1. Jobs and ownership

| character | default chore (`BOT_CHORE_PLAN`) | goal |
|-----------|----------------------------------|------|
| **omori** (leader) | gather HERBALIST + rotate every crafting trade | level **every job** |
| **memorien** | gather FARMER + rotate every crafting trade | " |
| **llokan** | gather MINER + rotate every crafting trade | " |
| **archero** | gather EVERY gathering job + rotate every crafting trade | " |

- Gathering jobs: `FARMER`, `HERBALIST`, `MINER` (`immutable/identity.ts`).
- Crafting trades: `FORGER, CARVER, TAILOR, JEWELER, TANNER, HANDYMAN, ALCHEMIST, BAKER`
  (`job_groups` minus `gathering`; the rotation already uses exactly this list in `craft.ts`).
- Every character also fights for xp regardless of its chore; the default plan keeps every
  gatherer leaf covered while all four level the crafting trades.
- **One signer / one shared inventory.** The bot drives all four characters over a single
  WebSocket for one address, and `state.inventory` is the address's item pool — so a tool omori
  crafts is immediately equippable by archero. No item transfer is needed.

## 2. How job XP works (the leveling levers)

Job levels follow `job_experience_curve` (100 levels). Milestones:
`L10 = 1,911 xp · L20 = 8,097 · L30 = 19,242 · L40 = 36,641 · L50 = 62,491 · L60 = 100,421 · L100 = 581,687`.

**Gathering** (`job_xp.move`): each harvest banks `gather_xp(required) = 10 + floor(required/2)`
where `required = tier_unlock_level(tier) = (tier-1)*10`. One **node per transaction**.

| tier | unlock at level | xp / node | node cooldown (fresh → 100) |
|------|-----------------|-----------|------------------------------|
| t1 | 1 | 10 | 12s → 2s |
| t2 | 10 | 15 | |
| t3 | 20 | 20 | |
| t4 | 30 | 25 | |
| t5 | 40 | 30 | |
| t6 | 50 | 35 | |

**Crafting** (`job_xp.move::craft_xp`): xp is driven by the number of **distinct ingredient slots**:

| distinct inputs | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|-----------------|---|---|---|---|---|---|---|
| xp / batch | 10 | 25 | 50 | 100 | 250 | 500 | 1000 |

Slots unlock with level: 2 at birth, then 3/4/5/6/7/8 at L10/20/40/60/80/100. A recipe whose slot
count is 4+ below current capacity grants **0 xp** (retro floor) — so always craft at the current
capacity. Success chance = `50% + 0.5%·(level-1)`, capped 99%.

## 3. The world / resource map

Only **two worlds place resources**:

- **nauvis** — entry level 1 → tiers **1–3**.
- **yakutia** — entry level 20 → tiers **4–6**.

Tiers **7–11 have no world** (not in `worlds.json`), so the gatherable ceiling is **tier 6**
(reaches job level 50; past that you keep farming t6).

A resource spawns only in zones whose **biome** is listed for it (or in one of its **cities**).
Biome coverage (share of all zones), with the resources each hosts:

**nauvis**

| biome | ~zones | resources |
|-------|--------|-----------|
| plains | 36.4% | wheat (t1), wheat_barley (t2), wheat_malt (t3) |
| forest | 21.4% | green_mushroom (t1), ivory_shrooms (t3) |
| highlands | 15.9% | quartz (t1), amber (t2) |
| rainforest | 11.1% | green_mushroom (t1), red_orchid (t2), ivory_shrooms (t3) |
| desert | 5.7% | jade (t3) |
| ocean | 9.5% | — (no resources) |

**yakutia**

| biome | ~zones | resources |
|-------|--------|-----------|
| taiga | 33.6% | wheat_tanjirize (t5), nightcap (t5) |
| blue_steppe | 24.4% | wheat_suize (t6) |
| frostfen | 18.1% | aloe_vera (t4), nightcap (t5), crimson_truffle (t6) |
| ice_peaks | 12.3% | duskite (t6) |
| caldera | 6.3% | wheat_burnt (t4), aloe_vera (t4), bloodstone (t5) |
| black_ice | 5.3% | moonstone (t4) |

### City hubs (guaranteed, biome-independent)

A zone within ±1 of a city hosts ONLY that city's resources:

| city | zone / block | distance | resources |
|------|--------------|----------|-----------|
| thebes | zone(1578,1562) `50512,50000` | 480 | **wheat, green_mushroom, quartz** (all t1) |
| the_ruins | zone(1127,1521) `36064,48672` | 13,952 | amber (t2), ivory_shrooms (t3) |
| fuwage | zone(445,709) `14240,22688` | 35,776 | wheat_malt (t3), jade (t3) |

**thebes is the tier-1 hub** — a single stop that reliably yields one resource for each of the
three gathering jobs. Great for the first level-1 → 10 grind.

### Example farm zones near the party's roam ring (~24k blocks out; zone = `zone·32+16`)

| resource | world / biome | example zone |
|----------|---------------|--------------|
| wheat / wheat_barley / wheat_malt | nauvis plains | (818,815) |
| green_mushroom / ivory_shrooms | nauvis forest | (815,815) |
| quartz / amber | nauvis highlands | (860,815) |
| red_orchid | nauvis rainforest | (884,815) |
| jade | nauvis desert | (1109,815) |
| wheat_tanjirize / nightcap | yakutia taiga | (815,815) |
| wheat_suize | yakutia blue_steppe | (938,815) |
| aloe_vera / crimson_truffle | yakutia frostfen | (830,815) |
| moonstone | yakutia black_ice | (1478,815) |
| bloodstone / wheat_burnt | yakutia caldera | (1199,815) |
| duskite | yakutia ice_peaks | (860,815) |

> The biome grid is sampled from the world terrain noise (ported engine `sample_biome_grid`).
> The bot does **not** currently vendor the engine; it discovers packs at runtime from the
> server's `zone_spawns`. The table above is the precomputed map to target zones deliberately.

## 4. Tools — the truth

`gathering.move`: *"prove the matching job tool is equipped (ANY tool of the type — tool level
never gates)"*. So:

- The required tool is **per job**, not per resource: wheat→`tool_farmer`, mushroom/orchid→
  `tool_herbalist`, quartz/amber/jade→`tool_miner`.
- The tool's level is irrelevant; either variant works.
- `ensure_tool(job)` in `gather.ts` **already equips the right tool** — so "give the correct tool
  for the resource being gathered" is already the behaviour. The real gap is **owning** the tool.

All six tools are **HANDYMAN** crafts (i.e. omori's own trade), from monster drops:

| tool | category | recipe |
|------|----------|--------|
| old_hoe | tool_farmer | gnawed_branch×3, salvaged_scrap×2 |
| basic_pickaxe | tool_miner | gnawed_branch×3, beak_shard×2 |
| tool_herbalist | tool_herbalist | gnawed_branch×3, rabbit_sinew×2 |
| quartzbound_hoe | tool_farmer | gnawed_branch×20, quartzbound_scrap×10, sunforged_talon×1 |
| quartzbound_pickaxe | tool_miner | gnawed_branch×20, quartz_honed_beak×10 |
| quartzbound_sickle | tool_herbalist | gnawed_branch×20, wheatspun_sinew×10 |

So: **one tier-1 tool per gathering job** (old_hoe, basic_pickaxe, tool_herbalist) is enough to
start, and crafting them levels omori's HANDYMAN at the same time. archero is currently
`tool=false`.

## 5. Leveling strategy

### Gatherers (memorien / llokan / archero)
Farm the **highest tier the job level unlocks**, in the matching biome/city of the right world.
Path (fits world entry levels):

1. **L1→10:** t1 at **thebes** (wheat / green_mushroom / quartz) — no travel-hunting needed.
2. **L10→20:** t2 — FARMER wheat_barley (plains), HERBALIST red_orchid (rainforest), MINER amber
   (highlands, or the_ruins).
3. **L20→30:** t3 — FARMER wheat_malt (plains or fuwage), HERBALIST ivory_shrooms (forest/
   rainforest or the_ruins), MINER jade (desert or fuwage).
4. **L30→50:** switch to **yakutia** (entry 20): t4 moonstone/… (black_ice, caldera), t5
   bloodstone (caldera), t6 … (see table).
5. **L50→100:** keep farming t6 (duskite/ice_peaks, crimson_truffle/frostfen, wheat_suize/
   blue_steppe).

`gather_quantity_bounds` raises yield with level, and `gather_time_ms` shortens the cooldown, so
each band is faster than the last. XP, however, is per node — so the count is what matters.

### omori (all craft trades)
The rotation (least-trained trade first, highest-XP affordable recipe) is already correct. The
bottleneck is **ingredients**, not policy. To keep every trade moving:

- Harvests from the gatherers feed the **refine recipes** (FARMER flours, HERBALIST salves, MINER
  powders): 4 slots = 50 xp, 5 slots = 100 xp (e.g. `bloodstone_powder` needs
  bloodstone+moonstone+jade+amber). These also level the matching gathering job.
- 6-slot refine recipes need tier 7–11 resources → **unreachable**; the ceiling refine is 5 slots.
- Equipment recipes (derived job from category) need chitin/silk/hide **monster drops** + refined
  materials. Group fights are how those drop.
- **Tools** (HANDYMAN) come from drops too, and directly supply the gatherers.

So the loop is: **fights (drops) + gather excursions (raw resources) → omori refines & crafts →
tools/gear back to the party.** With one shared inventory this is automatic.

## 6. Periodic gathering excursions (design)

The party normally roams/fights together. Add a **gather phase** that runs on a cadence (and/or
when a gatherer's next tier is reachable but not present at the fight band):

1. Pick, per gatherer, the target `(job, tier, world, biome)` = highest unlocked tier.
2. Party (or just the gatherer) relocates to a zone of that biome; gatherers harvest their own
   job's packs near the rally point; the leader/fighters screen.
3. When a gatherer's target tier is in another world (yakutia for t4–6), the trip is longer —
   either move the whole party, or send gatherers and regroup after.
4. Return to the fight band and resume group fights.

Implementation hooks already present: `run_chore(rt, local_only)` with `PARTY_GATHER_RADIUS`,
`rally_to_leader` / `RALLY_STANDOFF`, `gather_world_for_level`, and the group step ordering in
`run_pass`.

## 7. Open questions

1. **Current job levels** — the bot does not log them today. Confirm them (or add a startup log);
   the plan adapts, but knowing them sets the starting tier.
2. **Excursion cadence** — fixed timer (e.g. every N minutes / M fights), or event-driven (a
   gatherer is "blocked" because its next tier is in another biome/world)?
3. **Excursion scope** — whole party relocates, or only the gatherer(s) detach and regroup?
4. **yakutia fights** — should the party also fight in yakutia (level-20+ mobs) so the trip serves
   both gathering and combat, or keep fights in nauvis and treat yakutia as gather-only?
