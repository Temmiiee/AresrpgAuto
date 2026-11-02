# Progression plan — jobs, resources, zones, and leveling

Confirmed from the seed content, the on-chain game rules (`aresrpg/packages/move`), and the
immutable mirrors the bot vendors. Everything below is derived, not guessed.

> **Status (current build).** Progression is specialized: Omori concentrates all craft XP, while
> Memorien, Llokan, and Archero each own one gathering job and keep its matching tool. A specialized
> gatherer never falls back to another job when its local resource is absent; the excursion planner
> relocates it instead. §6's excursion design is implemented in `actions/excursion.ts`.

## 1. Jobs and ownership

| character | default chore (`BOT_CHORE_PLAN`) | goal |
|-----------|----------------------------------|------|
| **omori** (leader) | objective-driven crafting | unlock the party's target crafts |
| **memorien** | gather FARMER | keep `tool_farmer` equipped and level FARMER |
| **llokan** | gather MINER | keep `tool_miner` equipped and level MINER |
| **archero** | gather HERBALIST | keep `tool_herbalist` equipped and level HERBALIST |

- Gathering jobs: `FARMER`, `HERBALIST`, `MINER` (`immutable/identity.ts`).
- Crafting trades: `FORGER, CARVER, TAILOR, JEWELER, TANNER, HANDYMAN, ALCHEMIST, BAKER`
  (`job_groups` minus `gathering`; the rotation already uses exactly this list in `craft.ts`).
- Every character also fights for xp regardless of its chore. Craft XP is intentionally not spread
  across the roster: every useful batch advances the one crafter responsible for recipe unlocks.
- **One signer / one shared inventory.** The bot drives the selected roster over a single
  WebSocket for one address, and `state.inventory` is the address's item pool — so a tool omori
  crafts is immediately equippable by archero. No item transfer is needed.

## Combat build progression

`actions/progression.ts` now compares the next legal spell level using the current authored seed
effects: expected damage and life steal, healing (with the game's Intelligence scaling), buffs,
AP/MP removal, control, area, range, cast limit, cooldown, and critical effects. It weights those
effects by class role: **Yogan** is a ranged damage carry, **Mori** is a hybrid controller with
sustain, and **Tomoda** is a party support with healing and high-value buffs. For classes without a
dedicated profile, it uses balanced weights. It saves spell points when the next raise cannot be
afforded and spends them on the best marginal value per point.

In grouped combat those roles affect the action choice too: **Yogan is assigned the damage-carry
role**, **Mori the controller role**, and **Tomoda the support role**. Damage, healing, buffs,
control, displacement and casualty prevention now share one engine-backed HP-impact-per-AP scorer.
It compares each candidate after the same projected enemy response, values buffs by the extra damage
or movement they unlock for allies, and still falls back to direct damage or safe movement when no
tactical action has positive impact. The same planner is used by live fights and win-rate previews.

Stat spending evaluates the effect of one additional natural point at a time, then applies the exact
class characteristic cost ladder. Elemental damage and Intelligence-scaled healing feed the combat
value; Agility changes the crit estimate; Wisdom receives the game's +1% XP per point and improves
the estimated value of AP/MP removal; Vitality gets a survival value for its +1 max HP. XP value
fades at the level cap. The profile weights are a transparent PvM farming heuristic; they do not
yet learn from a character's own fight history or model each enemy's resistance and actual party HP
state. Fight logs are still needed to tune those weights for a particular roster and farm tier.

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

### omori (objective-driven crafter)
Crafting is deliberately strict. The first live priority is a dungeon key, then a missing gathering
tool, then the highest-value gear upgrade. If its trade is level-locked, Omori crafts only the
highest-XP legal recipe of that same trade until the required level is reached. Other professions
do not request resources, redirect loot farming, or consume ingredients while this objective is
blocked. The least-trained rotation is only a fallback when no key, tool, or gear objective exists.

To feed the focused trade:

- Harvests from the gatherers feed the **refine recipes** (FARMER flours, HERBALIST salves, MINER
  powders): 4 slots = 50 xp, 5 slots = 100 xp (e.g. `bloodstone_powder` needs
  bloodstone+moonstone+jade+amber). These also level the matching gathering job.
- 6-slot refine recipes need tier 7–11 resources → **unreachable**; the ceiling refine is 5 slots.
- Equipment recipes (derived job from category) need chitin/silk/hide **monster drops** + refined
  materials. Group fights are how those drop.
- **Tools** (HANDYMAN) come from drops too, and directly supply the gatherers.

So the loop is: **fights (drops) + gather excursions (raw resources) → omori refines & crafts →
tools/gear back to the party.** With one shared inventory this is automatic.

### Equipment acquisition invariant

The equipment path is validated end to end against all 116 craftable wearables:

1. Score the best legal upgrade for each character and slot using class affinity and actual stats.
2. Allocate held item ids leader-first, exactly like auto-equip; one copy cannot satisfy two users.
3. Keep the goal when a held random roll is weaker than the worn piece.
4. Train only the target recipe's job when its ingredient-count gate is still locked.
5. Expand intermediates recursively into gatherable leaves and mob-only drops.
6. Craft unique equipment with one attempt and no stack output target.
7. Detect the minted id, verify kiosk ownership, and equip it when the character is idle and fresh.

Every gear recipe terminates in gatherable, lootable, or craftable inputs; the regression suite also
checks that there are no dependency cycles or unreachable job-level gates.

### Resource protector bags

A successful protector fight can award a deterministic bag for the protected resource. The idle
party leader opens and claims these boxes before starting another fight. Only seed entries with one
guaranteed gatherable-resource reward are accepted; each supported bag returns **50 units**, and up
to 50 boxes from one stack are processed together. The resulting stock immediately participates in
the normal craft-demand calculation.

## 6. Periodic gathering excursions (design and current status)

The party normally roams/fights together. The runtime now runs assigned gathering/crafting chores,
can detach the configured cross-world gatherer on a timer, and can start a party excursion when
local gather demand stays blocked. These are distinct mechanisms: `BOT_CROSS_WORLD_*` controls the
individual detacher; the party excursion planner reacts to demand and its own dwell/return conditions.
The original planning model below is useful context, but is not a complete account of current behavior:

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

1. **Current job levels** — startup logs report the selected characters' job levels. Confirm those
   against the live roster when diagnosing a tier choice; they determine the starting tier.
2. **Excursion policy** — current party excursions are demand-driven; tuning their scope and return
   conditions may still be useful as the gather/craft demand model evolves.
3. **Yakutia fights** — cross-world gathering and fighting share the normal fight planner, but the
   desired balance between gathering and combat there remains a gameplay choice.
