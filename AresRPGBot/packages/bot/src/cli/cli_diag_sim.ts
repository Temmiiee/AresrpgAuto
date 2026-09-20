// bun run src/cli/cli_diag_sim.ts [runs=3] [mob_spec]
// Diagnostic for the offline fight simulator: builds the REAL live party (chain reads only, no
// writes), then times and reports the same mob group fought two ways — with every spell at its
// level-1 self-learned default (the pre-spell-book behavior that silently under-rated the party)
// and with the party's ACTUAL invested spell book. The wall-clock split separates what the turn
// planner (ai/sim_decide.ts) costs from what the engine itself costs, so a regression in either
// shows up directly. mob_spec is `type:level,type:level,...` (defaults to the reported-suspicious
// moyumi:14,aragne__air:14 — a party averaging ~16 reportedly simmed 0% against it, the bug this
// diagnostic exists to explain).
import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'
import { CHARACTERS } from '../config/party_config.ts'
import { simulate_fight, type SimPartyMember } from '../ai/simulate.ts'
import { decide_turn } from '../ai/sim_decide.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import { read_live_character_stats } from '../shared/live_character.ts'
import { read_spell_book } from '../shared/spell_book.ts'
import { read_equipped_weapon } from '../fight/equipped_weapon.ts'

const RUNS = Number(process.argv[2] ?? 3)
const SPEC =
  process.argv[3] ??
  'moyumi:14,aragne__air:14'
const GROUP = SPEC.split(',').map((entry) => {
  const [mob_type, level] = entry.split(':')
  return { mob_type: mob_type!, level: Number(level ?? 1) }
})

const avg = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
const ms = (started: number): number => performance.now() - started

// A decider wrapper that accumulates wall time spent in the turn planner, so the engine cost is
// (fight total - planner total), not a guess.
const timed_decide = (
  decision_ms: { value: number },
  ...args: Parameters<typeof decide_turn>
): ReturnType<typeof decide_turn> => {
  const started = performance.now()
  const result = decide_turn(...args)
  decision_ms.value += ms(started)
  return result
}

const build_party = async (): Promise<SimPartyMember[]> => {
  const signer = await get_enoki_signer()
  const { sdk } = create_bot_sdk(signer)
  const party: SimPartyMember[] = []
  for (const c of CHARACTERS) {
    const stats = await read_live_character_stats(sdk, c.id)
    const book = await read_spell_book(sdk, c.id)
    const weapon = await read_equipped_weapon(sdk, c.id)
    party.push({ name: c.name, classe: c.classe, ...stats, spell_levels: book, weapon: weapon ?? undefined })
  }
  return party
}

const report_fight = (
  label: string,
  party: SimPartyMember[],
  group: typeof GROUP,
  policy: ReturnType<typeof load_trained_policy>['policy']
): void => {
  let wins = 0
  let turns_sum = 0
  let wall_sum = 0
  let decision_sum = 0
  let caps = 0
  const decision_ms = { value: 0 }
  const outcomes: string[] = []
  for (let run = 0; run < RUNS; run += 1) {
    decision_ms.value = 0
    const started = performance.now()
    const outcome = simulate_fight(party, group, BigInt(1 + run), policy, (...args) => timed_decide(decision_ms, ...args))
    const wall = ms(started)
    wall_sum += wall
    decision_sum += decision_ms.value
    turns_sum += outcome.turns
    if (outcome.won) wins += 1
    if (outcome.turns >= 400) caps += 1
    outcomes.push(
      `${outcome.won ? 'W' : 'L'}:${outcome.turns}t/${outcome.rounds}r ${(wall / 1000).toFixed(2)}s (${(wall / Math.max(1, outcome.turns)).toFixed(0)}ms/turn)`
    )
  }
  console.log(`  ${label}:`)
  console.log(`    ${RUNS} runs → ${wins}/${RUNS} won (${((wins / RUNS) * 100).toFixed(0)}%), avg ${(turns_sum / RUNS).toFixed(1)} turns`)
  console.log(`    wall: avg ${(wall_sum / RUNS / 1000).toFixed(2)}s/fight (${(wall_sum / Math.max(1, turns_sum)).toFixed(0)}ms/turn), planner ${(decision_sum / RUNS).toFixed(0)}ms/fight (${((decision_sum / Math.max(1, wall_sum)) * 100).toFixed(1)}% of wall)`)
  if (caps > 0) console.log(`    ⚠ ${caps}/${RUNS} hit the 400-turn cap (fight unresolved)`)
  console.log(`    per-run: ${outcomes.join(' | ')}`)
  console.log(`    final hp (won): ${'—'}`)
}

const main = async (): Promise<void> => {
  const { policy, source } = load_trained_policy()
  console.log(`policy: ${source}`)
  console.log(`group: ${GROUP.map((g) => `${g.mob_type}:${g.level}`).join(', ')} (${RUNS} runs each)\n`)

  const party = await build_party()
  const party_avg = avg(party.map((m) => m.level))
  console.log(
    `party (avg lv ${party_avg.toFixed(1)}): ${party
      .map((m) => `${m.name}(${m.classe} lv${m.level}) ${Object.entries(m.spell_levels ?? {}).length} raised spell(s): ${Object.entries(m.spell_levels ?? {}).map(([s, l]) => `${s}@${l}`).join(', ') || 'none'}`)
      .join('\n                    ')}\n`
  )

  const book_party = party
  const level1_party = party.map((m) => ({ ...m, spell_levels: {} }))

  console.log(`>>> every spell at level 1 (pre-fix behavior):`)
  report_fight('level-1 spells', level1_party, GROUP, policy)
  console.log(`\n>>> actual invested spell book:`)
  report_fight('spell book', book_party, GROUP, policy)
  console.log('')
}

await main()
