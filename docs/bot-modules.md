# Specialized bot modules

The modules are focused schedulers around the existing shared engine. They do not duplicate login,
WebSocket, state, combat simulation, travel, inventory or transaction code. This keeps all safety
fixes and combat improvements common while each command pays only for decisions useful to its goal.

Only one bot process may run for an account. Starting a second profile evicts the first connection.

## Combat XP

```sh
bun run bot:xp [character] [target-level]
```

Example: `bun run bot:xp omori 50`.

- keeps party combat, roaming and the XP-per-turn strategy scan;
- disables gathering, crafting, pets, cross-world trips, chores and new dungeon runs;
- uses the full class-aware spell planner, buffs, healing, positioning and conservative win-rate
  screen rather than a simplified combat routine;
- holds new actions and reports completion when the optional target reaches the requested level.

The character controls the completion target. Combat remains party-based by default because safe,
high-value group fights are usually the fastest account-wide XP path.

## Profession level

```sh
bun run bot:job <JOB> [character] [target-level]
```

Supported gathering jobs are `FARMER`, `HERBALIST`, and `MINER`. Supported crafting jobs are
`FORGER`, `CARVER`, `TAILOR`, `JEWELER`, `TANNER`, `HANDYMAN`, `ALCHEMIST`, and `BAKER`.

Gathering mode assigns exactly the requested job to the selected character, so auto-equip keeps its
matching tool. Other characters stay idle and cannot spend gas swapping tools or farming unrelated
resources. Ordinary monster hunting is disabled; resource-protector fights are still completed and
their deterministic 50-resource bags are claimed through the normal recovery path.

Crafting-profession mode assigns one crafter, restricts recipe rotation to that profession, and
retains only the roster's fixed gathering roles as suppliers. Combat and strategy stay available
because some legal recipes need mob drops. Unrelated profession filler cannot consume reserved
ingredients. The module holds when the optional target job level is reached.

## Exact item

```sh
bun run bot:craft <item-type> [quantity] [character]
```

Example: `bun run bot:craft silkblade_thread 5 omori`.

The output must have an authored recipe; invalid targets fail before the live loop begins. The item
becomes the sole craft objective, and its complete recursive inputs drive gathering and desired mob
drops. Default gear, dungeon-key, pet-food and filler objectives are excluded. Attempts are capped
to the missing quantity, including the one-at-a-time rule for non-stackable equipment. Once the
owned inventory reaches the requested amount, all new actions hold and the completion is logged and
sent to Discord.

## Environment form and overrides

The wrappers set the same values that can be placed in `packages/bot/.env`:

```dotenv
BOT_MODULE=craft
BOT_MODULE_CHARACTER=omori
BOT_CRAFT_TARGET=silkblade_thread
BOT_CRAFT_QUANTITY=5
```

The equivalent XP fields are `BOT_XP_TARGET_LEVEL`; job fields are `BOT_JOB_TARGET` and
`BOT_JOB_TARGET_LEVEL`. Explicit play toggles still override a module's safe defaults. For example,
`BOT_GROUP=false bun run bot:xp omori 50` opts into independent fights. Such overrides are advanced
controls: enabling dungeons or maintenance in a focused profile makes it less focused.

An active dungeon route is always recovered even if `BOT_DUNGEON=false`; the toggle prevents new
key commitments, not safe completion of already-spent keys.
