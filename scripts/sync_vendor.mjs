// Vendors the read/write core of AresRPG into this bot's workspace.
//
// The bot must build and typecheck on its own, without depending on sibling checkouts. We copy
// the four packages in the dependency closure of `@aresrpg/sdk`'s write path:
//
//   sdk       -> @aresrpg/immutable + @aresrpg/protocol (+ @mysten/*)
//   protocol  -> @aresrpg/fight + @aresrpg/immutable
//   fight     -> (standalone)
//   immutable -> (standalone)
//
// Cross-package relative paths must keep resolving:
//   packages/sdk/src/pins.ts                 -> ../../../pins.json
//   packages/sdk/examples/agent_plan.ts      -> ../../../seed/content/*.json
// which is why we reproduce the monorepo's `packages/*` + root `pins.json`/`seed/` layout.
//
// Usage:  bun scripts/sync_vendor.mjs          (re-copy everything from ../aresrpg)
//         bun scripts/sync_vendor.mjs --check  (report drift without writing)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const V2_ROOT = resolve(HERE, '..')
const SOURCE_ROOT = resolve(V2_ROOT, '..', 'aresrpg')
const DEST_PACKAGES = join(V2_ROOT, 'packages')

const CHECK_ONLY = process.argv.includes('--check')

// Per-package: which top-level entries inside the source package we copy. We deliberately skip
// `node_modules`, `test`, and build scripts: the bot only needs the runtime source + the SDK's
// official examples (which the bot reuses for its planners).
const PACKAGES = {
  immutable: ['src', 'package.json'],
  fight: ['src', 'package.json'],
  protocol: ['src', 'package.json'],
  sdk: ['src', 'examples', 'package.json'],
}

// Seed content files the bot reads at runtime (catalog + worlds). Copied flat; the heavy
// `snapshots/` (historical chain dumps) and empty `journal/` are intentionally excluded.
const SEED_FILES = [
  'items.json',
  'recipes.json',
  'mobs.json',
  'worlds.json',
  'spells.json',
  'fight_boards.json',
  'grain_visuals.json',
  'structure_packs.json',
]

const log = (message) => console.log(`[sync_vendor] ${message}`)

const copy_entry = (source, dest) => {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(source, dest, { recursive: true, dereference: true })
}

const seed_source_dir = join(SOURCE_ROOT, 'seed', 'content')
const seed_dest_dir = join(V2_ROOT, 'seed', 'content')

const main = () => {
  if (!existsSync(SOURCE_ROOT)) {
    console.error(`[sync_vendor] source checkout not found: ${SOURCE_ROOT}`)
    process.exit(1)
  }

  const planned = []

  for (const [name, entries] of Object.entries(PACKAGES)) {
    const source_pkg = join(SOURCE_ROOT, 'packages', name)
    if (!existsSync(source_pkg)) {
      console.error(`[sync_vendor] missing source package: ${source_pkg}`)
      process.exit(1)
    }
    for (const entry of entries) {
      const source = join(source_pkg, entry)
      if (!existsSync(source)) {
        console.error(`[sync_vendor] missing ${relative(SOURCE_ROOT, source)}`)
        process.exit(1)
      }
      planned.push({ source, dest: join(DEST_PACKAGES, name, entry) })
    }
  }

  planned.push({ source: join(SOURCE_ROOT, 'pins.json'), dest: join(V2_ROOT, 'pins.json') })

  for (const file of SEED_FILES) {
    const source = join(seed_source_dir, file)
    if (!existsSync(source)) {
      console.error(`[sync_vendor] missing seed file: ${relative(SOURCE_ROOT, source)}`)
      process.exit(1)
    }
    planned.push({ source, dest: join(seed_dest_dir, file) })
  }

  if (CHECK_ONLY) {
    let drift = 0
    for (const { source, dest } of planned) {
      if (!existsSync(dest)) {
        log(`DRIFT (missing): ${relative(V2_ROOT, dest)}`)
        drift += 1
        continue
      }
      const source_files = collect_files(source)
      const dest_files = collect_files(dest)
      const changed = source_files.length !== dest_files.length
      if (changed) {
        log(`DRIFT (file count): ${relative(V2_ROOT, dest)}`)
        drift += 1
      }
    }
    log(drift === 0 ? 'vendored tree is up to date' : `${drift} entries drifted`)
    process.exit(drift === 0 ? 0 : 2)
  }

  for (const { source, dest } of planned) {
    copy_entry(source, dest)
  }
  log(`vendored ${planned.length} entries from ${SOURCE_ROOT}`)
}

const collect_files = (root) => {
  const stats = statSync(root)
  if (!stats.isDirectory()) return [root]
  const found = []
  for (const entry of readdirSync(root)) {
    found.push(...collect_files(join(root, entry)))
  }
  return found
}

main()
