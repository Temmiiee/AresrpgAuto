// bun run src/cli_reset_character.ts <name> [--stats-only|--spells-only]
//
// Uses an already-owned scroll_of_rebirth (progression's reset_stats — every level-granted point
// returns, character.move) and/or scroll_of_oblivion (reset_spells — the raised-spell book
// clears, points refund) on the named character. A rare, manual maintenance action for a
// character whose CURRENT stat/spell allocation predates
// DEFAULT_PRIMARY_STAT_SHARE and caster_damage_multiplier (stat_allocation.ts) — those only
// shape NEW points going forward, never retroactively. This script only clears the slate; the
// very next `bun run session` / `bun run group-fight` naturally re-spends the refunded points
// correctly through the normal prepare_party flow, with no separate re-spend step needed here.
//
// There is no shop-purchase door anywhere in @aresrpg/sdk, no shop.move reference, and no
// seed/content/shop.json (confirmed 2026-09-06 — all of those existed when this script was first
// written, per its own history, and have since been removed/restructured upstream with no
// replacement seeded there). The real acquisition path turned out to be a DIFFERENT system found
// later the same day: both scrolls are mastery shop offers (seed/content/mastery.json, 10 mastery
// points each) — mastery.redeem() (dungeon/mastery_quest.ts, wired from run_daily_dungeon_quest)
// is real and working. This script now tries redeem() automatically for whichever scroll isn't
// already owned, before falling back to refusing.
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { read_sellable_items } from '../market/kiosk_inventory.ts'
import { read_mastery_row } from '../dungeon/mastery_quest.ts'

const RESET_SCROLLS = {
  stats: { item_type: 'scroll_of_rebirth', label: 'stats', mastery_cost: 10 },
  spells: { item_type: 'scroll_of_oblivion', label: 'spells', mastery_cost: 10 },
} as const

const main = async () => {
  const [, , name] = process.argv
  const character = CHARACTERS.find((c) => c.name === name)
  if (!character) {
    console.log(
      `usage: bun run src/cli_reset_character.ts <name>  (one of ${CHARACTERS.map((c) => c.name).join(', ')})`
    )
    process.exitCode = 1
    return
  }
  const only_stats = process.argv.includes('--stats-only')
  const only_spells = process.argv.includes('--spells-only')
  const modes = only_stats ? (['stats'] as const) : only_spells ? (['spells'] as const) : (['stats', 'spells'] as const)

  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)

  console.log(`${character.name}: resetting ${modes.map((m) => RESET_SCROLLS[m].label).join(' + ')}`)
  let items = await read_sellable_items(bot)
  const scrolls = new Map<string, (typeof items)[number]>()
  const still_missing: string[] = []
  for (const mode of modes) {
    const { item_type, mastery_cost } = RESET_SCROLLS[mode]
    const owned = items.find((i) => i.item_type === item_type)
    if (owned) {
      scrolls.set(mode, owned)
      continue
    }
    const mastery_row = await read_mastery_row(bot, bot.mastery.id)
    const points = mastery_row ? Number(mastery_row.points) : 0
    if (!mastery_row || points < mastery_cost) {
      console.log(`  ${item_type}: not owned, and only ${points} mastery point(s) (need ${mastery_cost}) — skipping`)
      still_missing.push(item_type)
      continue
    }
    console.log(`  ${item_type}: not owned — redeeming for ${mastery_cost} mastery points (have ${points})…`)
    await bot.mastery.redeem({ item_type, existing: null })
    items = await read_sellable_items(bot)
    const redeemed = items.find((i) => i.item_type === item_type)
    if (!redeemed) {
      console.log(`  ${item_type}: redeemed but not found in the kiosk afterward — aborting`)
      still_missing.push(item_type)
      continue
    }
    scrolls.set(mode, redeemed)
  }
  if (still_missing.length > 0) {
    console.log(
      `\nstill missing: ${still_missing.join(', ')} — not enough mastery points yet. Run \`bun run dungeon\` to ` +
        `earn more (mastery/mastery_quest.ts), then rerun this.`
    )
    process.exitCode = 1
    return
  }

  for (const mode of modes) {
    const { item_type, label } = RESET_SCROLLS[mode]
    const scroll = scrolls.get(mode)!
    console.log(`using ${item_type} on ${character.name}…`)
    await bot.character.use_consumable({ character_id: character.id, item_id: scroll.id, item_type })
    console.log(`  ${label} reset`)
  }

  console.log(
    `\n${character.name} reset complete — run \`bun run group-fight\` or \`bun run session\` next to re-spend the refunded points.`
  )
}

await main()
