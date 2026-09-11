// bun run src/cli_simulate_session.ts [fights] — one live stat read for the real party, then
// everything else is offline simulation (free, instant, no gas). Runs `fights` simulated fights
// spread across a realistic mix of mob-group matchups near the party's own level (calibrated the
// same way training_scenarios.ts calibrates — probed and nudged toward genuinely contested,
// not just "whatever a raw random roll produced") using the CURRENT live decision algorithm
// (fight_session.ts and this simulator share the same policy — DECISION_POLICY, loaded from
// learned_policy.local.json if training ever beats the hand-built default, else the default).
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { PRIMARY_STAT_BY_CLASS } from '../ai/stat_allocation.ts'
import { simulate_fight, type SimPartyMember } from '../ai/simulate.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import { random_mob_group, make_rng } from '../ai/training_scenarios.ts'
import { DEFAULT_POLICY } from '../ai/policy.ts'

const TOTAL_FIGHTS = Number(process.argv[2] ?? 50)
const SCENARIO_COUNT = Math.min(10, TOTAL_FIGHTS)
const RUNS_PER_SCENARIO = Math.ceil(TOTAL_FIGHTS / SCENARIO_COUNT)

const CALIBRATION_ATTEMPTS = 5
const CONTESTED_MIN = 0.15
const CONTESTED_MAX = 0.9

const main = async () => {
  const { policy, source } = load_trained_policy()
  console.log(`combat policy: ${source}`)

  const signer = await get_enoki_signer()
  const { sdk } = create_bot_sdk(signer)
  const party: SimPartyMember[] = []
  for (const c of CHARACTERS) {
    const { level, vitality, wisdom, strength, intelligence, chance, agility } = await read_live_character_stats(
      sdk,
      c.id
    )
    party.push({ name: c.name, classe: c.classe, level, vitality, wisdom, strength, intelligence, chance, agility })
  }
  const party_level = Math.round(party.reduce((sum, c) => sum + c.level, 0) / party.length)
  console.log(`Party: ${party.map((c) => `${c.name}(${c.classe} lv${c.level})`).join(', ')}`)
  console.log(`Simulating ${TOTAL_FIGHTS} fights across ${SCENARIO_COUNT} matchups near party level ${party_level}…\n`)

  // Same calibration technique as training_scenarios.ts (probe with the live policy, nudge mob
  // levels within their own band, drop a mob if level-nudging alone can't reach a contest) —
  // a realistic session mixes easy, contested, and rough fights, not 10 free wins.
  const rng = make_rng(Date.now() & 0xffffffff)
  const scenarios: { label: string; group: ReturnType<typeof random_mob_group> }[] = []
  for (let i = 0; i < SCENARIO_COUNT; i += 1) {
    let group = random_mob_group(rng, party_level)
    for (let attempt = 0; attempt < CALIBRATION_ATTEMPTS; attempt += 1) {
      const probe = simulate_fight(party, group, 999n + BigInt(attempt), policy)
      const rough_rate = probe.won ? 1 : 0 // single-shot probe is coarse but cheap; good enough to steer away from walls
      if (rough_rate >= CONTESTED_MIN && rough_rate <= CONTESTED_MAX) break
      group = group.map((m) => ({ ...m, level: Math.max(1, m.level + (rough_rate > CONTESTED_MAX ? 2 : -2)) }))
    }
    scenarios.push({ label: group.map((g) => `${g.mob_type}(${g.level})`).join('+'), group })
  }

  let wins = 0
  let total_turns = 0
  let total_xp = 0
  let fights_run = 0
  const per_scenario: { label: string; wins: number; runs: number; avg_turns: number }[] = []

  for (const { label, group } of scenarios) {
    let scenario_wins = 0
    let scenario_turns = 0
    let scenario_runs = 0
    for (let run = 0; run < RUNS_PER_SCENARIO && fights_run < TOTAL_FIGHTS; run += 1) {
      const outcome = simulate_fight(party, group, BigInt(1000 + fights_run), policy)
      fights_run += 1
      scenario_runs += 1
      total_turns += outcome.turns
      scenario_turns += outcome.turns
      total_xp += Object.values(outcome.xp_gained).reduce((a, b) => a + b, 0)
      if (outcome.won) {
        wins += 1
        scenario_wins += 1
      }
    }
    per_scenario.push({
      label,
      wins: scenario_wins,
      runs: scenario_runs,
      avg_turns: scenario_turns / Math.max(1, scenario_runs),
    })
  }

  console.log('Per matchup:')
  for (const s of per_scenario)
    console.log(
      `  ${s.label}: ${s.wins}/${s.runs} won (${((s.wins / s.runs) * 100).toFixed(0)}%), avg ${s.avg_turns.toFixed(1)} turns`
    )

  console.log(`\n${fights_run} fights: ${wins} won (${((wins / fights_run) * 100).toFixed(1)}%)`)
  console.log(`avg turns/fight: ${(total_turns / fights_run).toFixed(1)}`)
  console.log(`total party xp: ${total_xp}  (${(total_xp / fights_run).toFixed(0)}/fight)`)
  if (policy === DEFAULT_POLICY)
    console.log('\n(using the untrained default policy — no trained policy has beaten it yet)')
}

await main()
