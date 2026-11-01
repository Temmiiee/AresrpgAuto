// Compare bundled game data and local gameplay-rule sources with the canonical game repository.
// The fight simulator embeds content at build time, so drift needs an operator-visible warning and
// a restart after updating the vendored snapshot.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import dungeons from '../../../../seed/content/dungeons.json'
import fight_boards from '../../../../seed/content/fight_boards.json'
import items from '../../../../seed/content/items.json'
import mobs from '../../../../seed/content/mobs.json'
import recipes from '../../../../seed/content/recipes.json'
import spells from '../../../../seed/content/spells.json'
import structure_packs from '../../../../seed/content/structure_packs.json'
import worlds from '../../../../seed/content/worlds.json'
import allocation_campaign from '../../../../seed/content/allocation_campaign.json'

import { config } from '../config.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { notify } from '../shared/discord_notify.ts'

const UPSTREAM = 'https://raw.githubusercontent.com/aresrpg/aresrpg/edge/seed/content'
const RULES_UPSTREAM = 'https://raw.githubusercontent.com/aresrpg/aresrpg/edge'
const SOURCES = Object.freeze({
  'dungeons.json': dungeons,
  'fight_boards.json': fight_boards,
  'items.json': items,
  'mobs.json': mobs,
  'recipes.json': recipes,
  'spells.json': spells,
  'structure_packs.json': structure_packs,
  'worlds.json': worlds,
  'allocation_campaign.json': allocation_campaign,
})

/** Authoritative Move modules that define the rules mirrored by the bot's combat and progression
 *  planners. Seed comparisons alone miss a balance change implemented in code (spell resolution,
 *  damage, enemy scaling, movement, gathering, equipment, etc.). Compare upstream to the local
 *  game-source copy; a mismatch is advisory and never auto-edits vendored or game files. */
const RULE_FILES = Object.freeze([
  'packages/move-combat/sources/combat.move',
  'packages/move-math/sources/fight_math.move',
  'packages/move-math/sources/spell_effect.move',
  'packages/move-math/sources/mob_data.move',
  'packages/move-math/sources/mob_scaling.move',
  'packages/move-math/sources/weapon.move',
  'packages/move-math/sources/item_stats.move',
  'packages/move-math/sources/item_damages.move',
  'packages/move-math/sources/world_map.move',
  'packages/move-math/sources/zone_math.move',
  'packages/move-math/sources/dungeon_data.move',
  'packages/move-math/sources/recipe_data.move',
  'packages/move-math/sources/job_xp.move',
  'packages/move-math/sources/loot_table.move',
  'packages/move/sources/fight.move',
  'packages/move/sources/gathering.move',
  'packages/move/sources/progression.move',
  'packages/move/sources/dungeon.move',
  'packages/move/sources/equipment.move',
  'packages/move/sources/world.move',
  'packages/move/sources/party.move',
  'packages/move/sources/consumable.move',
  'packages/move/sources/crafting.move',
  'packages/move/sources/character.move',
  'packages/move/sources/zone.move',
])
const STARTUP_CHECK_DELAY_MS = 60_000
const VENDORED_RULE_PACKAGES = Object.freeze(['immutable'])

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex')

let last_reported: string | null = null
let last_failed = false

/** One network check; failure is advisory and never prevents the game loop from starting. */
export const check_game_content = async (): Promise<readonly string[] | null> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const content_results = Object.entries(SOURCES).map(async ([file, local]) => {
      const response = await fetch(`${UPSTREAM}/${file}`, { signal: controller.signal })
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`)
      const remote: unknown = await response.json()
      return digest(remote) !== digest(local) ? file : null
    })
    const rule_results = RULE_FILES.map(async (file) => {
      const local_path = fileURLToPath(new URL(`../../../../aresrpg/${file}`, import.meta.url))
      const local = await readFile(local_path, 'utf8')
      const response = await fetch(`${RULES_UPSTREAM}/${file}`, { signal: controller.signal })
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`)
      const remote = await response.text()
      // Git's checkout settings may convert LF to CRLF on Windows; compare the source itself,
      // independent of that transport-level line-ending change.
      return digest(remote.replace(/\r\n/g, '\n')) !== digest(local.replace(/\r\n/g, '\n')) ? file : null
    })
    const vendor_results = VENDORED_RULE_PACKAGES.map(async (name) => {
      const source_dir = new URL(`../../../../aresrpg/packages/${name}/src/`, import.meta.url)
      const bot_dir = new URL(`../../../../packages/${name}/src/`, import.meta.url)
      const source_files = (await readdir(source_dir)).filter((file) => file.endsWith('.ts')).sort()
      const bot_files = (await readdir(bot_dir)).filter((file) => file.endsWith('.ts')).sort()
      const mismatched = source_files.length !== bot_files.length || source_files.some((file, index) => bot_files[index] !== file)
      if (mismatched) return `bot-vendor:${name}/src (file list)`
      for (const file of source_files) {
        const [source, bot] = await Promise.all([
          readFile(new URL(file, source_dir), 'utf8'),
          readFile(new URL(file, bot_dir), 'utf8'),
        ])
        if (source.replace(/\r\n/g, '\n') !== bot.replace(/\r\n/g, '\n'))
          return `bot-vendor:${name}/src/${file}`
      }
      return null
    })
    const results = await Promise.all([...content_results, ...rule_results, ...vendor_results])
    const drift = results.filter((file): file is string => file !== null)
    clearTimeout(timeout)
    last_failed = false
    if (drift.length) {
      const signature = drift.join(',')
      if (signature !== last_reported) {
        const details = drift.map((file) => file.replace(/\.json$|\.move$/, '')).join(', ')
        const message = `Données ou règles du jeu obsolètes : ${details}. Synchronise le contenu et les sources depuis aresrpg/aresrpg, puis redémarre le bot pour recalibrer ses simulations.`
        log_warn('content', message)
        notify(`⚠️ AresRPGAuto — ${message}`, 'warning')
        last_reported = signature
      }
    } else if (last_reported !== null) {
      log_info('content', 'les données de jeu locales sont à jour')
      notify('✅ AresRPGAuto — les données de jeu sont à nouveau à jour.', 'info')
      last_reported = null
    } else {
      log_info('content', 'données et règles de jeu à jour (branche aresrpg/aresrpg:edge)')
    }
    return Object.freeze(drift)
  } catch (error) {
    clearTimeout(timeout)
    if (!last_failed) {
      log_warn('content', `vérification amont indisponible; le bot continue avec ses données locales (${error instanceof Error ? error.message : String(error)})`)
      last_failed = true
    }
    return null
  }
}

/** Start a periodic watcher after startup; errors are logged once until connectivity returns. */
export const start_game_content_watch = (): void => {
  if (!config.content_watch) {
    log_info('content', 'surveillance désactivée (BOT_CONTENT_WATCH=false)')
    return
  }
  const check = async (): Promise<void> => {
    await check_game_content()
    const timer = setTimeout(() => void check(), config.content_watch_interval_ms)
    timer.unref()
  }
  const timer = setTimeout(() => void check(), STARTUP_CHECK_DELAY_MS)
  timer.unref()
}
