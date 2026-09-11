// bun run src/cli_validate_policy.ts — compares the trained policy against the untrained
// default on a FRESH random scenario set (different seed than cli_train.ts used), so a
// meaningful delta here is real generalization, not the training set's own noise. No chain
// calls — pure offline simulation.
import { simulate_many } from '../ai/simulate.ts'
import { DEFAULT_POLICY } from '../ai/policy.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import { random_scenarios } from '../ai/training_scenarios.ts'

const HELD_OUT_SEED = 771 // deliberately different from cli_train.ts's SCENARIO_SEED
const SCENARIO_COUNT = Number(process.argv[2] ?? 10)
const RUNS = Number(process.argv[3] ?? 8)

const trained = load_trained_policy()
console.log(`trained policy source: ${trained.source}`)
console.log(`policy: ${JSON.stringify(trained.policy)}\n`)

const scenarios = random_scenarios(HELD_OUT_SEED, SCENARIO_COUNT)
const scores = scenarios.map(({ label, party, group }) => {
  const base = simulate_many(party, group, RUNS, 1n, DEFAULT_POLICY)
  const learned = simulate_many(party, group, RUNS, 1n, trained.policy)
  console.log(label)
  console.log(
    `  default: win=${(base.win_rate * 100).toFixed(0)}% turns=${base.avg_turns.toFixed(1)} xp/turn=${base.avg_xp_per_turn.toFixed(1)}`
  )
  console.log(
    `  learned: win=${(learned.win_rate * 100).toFixed(0)}% turns=${learned.avg_turns.toFixed(1)} xp/turn=${learned.avg_xp_per_turn.toFixed(1)}`
  )
  return {
    base_score: base.win_rate * 100 + base.avg_xp_per_turn,
    learned_score: learned.win_rate * 100 + learned.avg_xp_per_turn,
  }
})
const default_total = scores.reduce((sum, s) => sum + s.base_score, 0)
const learned_total = scores.reduce((sum, s) => sum + s.learned_score, 0)
console.log(
  `\nheld-out avg score: default=${(default_total / scenarios.length).toFixed(2)}  learned=${(learned_total / scenarios.length).toFixed(2)}`
)
