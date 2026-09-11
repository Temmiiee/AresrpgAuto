// bun run src/cli_record_replay.ts [count] [seed] -- records `count` (default 5) fights with the
// currently loaded policy (learned_policy.local.json if trained, else DEFAULT_POLICY) against
// varied scenarios, and writes each as JSON to replays/<n>.json for the replay viewer artifact
// to load. Picked scenarios use random_scenarios (training_scenarios.ts) same as cli_train.ts,
// so what's on screen is representative of what training actually tests against, not a cherry-
// picked easy fight.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { record_fight } from '../ai/record_replay.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import { random_scenarios } from '../ai/training_scenarios.ts'

const COUNT = Number(process.argv[2] ?? 5)
const SEED = Number(process.argv[3] ?? Date.now() % 1_000_000)

const OUT_DIR = fileURLToPath(new URL('../../replays/', import.meta.url))
mkdirSync(OUT_DIR, { recursive: true })

const { policy, source } = load_trained_policy()
console.log(`Policy: ${source}`)

const scenarios = random_scenarios(SEED, COUNT)
const index: { file: string; label: string; won: boolean; turns: number }[] = []

for (const [i, scenario] of scenarios.entries()) {
  const replay = record_fight(scenario.party, scenario.group, 1n, policy)
  const file = `${i}.json`
  writeFileSync(join(OUT_DIR, file), JSON.stringify(replay))
  index.push({ file, label: scenario.label, won: replay.won, turns: replay.frames.length })
  console.log(`  [${i}] ${scenario.label} -> ${replay.won ? 'WON' : 'lost'} in ${replay.frames.length} turns (${file})`)
}

writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2))
console.log(`\nWrote ${scenarios.length} replays to ${OUT_DIR}`)
console.log('Open the replay viewer (https://claude.ai/code/artifact/76ebe6c6-025f-4d18-a987-39459d388e61) and load any of these .json files to watch the fight.')
