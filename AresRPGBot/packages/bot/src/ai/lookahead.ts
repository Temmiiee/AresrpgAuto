// Multi-turn lookahead: instead of committing to sim_decide.ts's single greedy-best turn plan,
// generate the top-K distinct plans, roll each one forward a few turns (mobs auto-resolve via
// the engine's own mob_turn; allies keep playing the plain greedy policy — no recursion, so this
// stays tractable), and pick whichever plan leads to the best resulting position on average
// across a few RNG seeds. This is what a single-turn scorer structurally cannot do, no matter
// how its weights are tuned: it's the first real look past "what's best RIGHT NOW."
//
// Cost is real (K candidates x S seeds x a few rollout turns, per decision) — fine for the live
// bot, which already waits out the chain's turn_min_ms every turn regardless, but too slow to
// use inside cli_train.ts's evolutionary search (thousands of decisions per generation). Treat
// this as a live-quality upgrade on top of whatever policy training settles on, not a
// replacement for it.
import { create_fight, type FightCommand, type HydratedFightCheckpoint } from '@aresrpg/fight'

import { decide_turn } from './sim_decide.ts'
import { DEFAULT_POLICY, type Policy } from './policy.ts'

export type LookaheadOptions = {
  /** How many distinct first-turn plans to compare. */
  candidates: number
  /** How many of the other actors' turns to roll forward (mobs + allies) before evaluating —
   *  roughly one full round for a typical 4v3 fight. */
  rollout_steps: number
  /** RNG seeds averaged per candidate, to smooth out crit/dodge variance in the evaluation. */
  samples: number
}
export const DEFAULT_LOOKAHEAD: LookaheadOptions = { candidates: 3, rollout_steps: 6, samples: 2 }

const TURN_MIN_MS = 3_100n

const max_hp_of = (
  fighter: HydratedFightCheckpoint['contract']['fighters'][number],
  max_hp_by_character: ReadonlyMap<string, bigint>
): number =>
  fighter.kind.type === 'mob'
    ? Number(fighter.kind.snapshot.max_hp)
    : Number(max_hp_by_character.get(fighter.kind.character) ?? 1n)

// Every turn costs real gas on the real chain (fixed cost per transaction regardless of how
// much damage it did) — a plan that wins in fewer rollout steps is worth MORE than one that
// merely wins, not just tied with it. steps_to_end counts rollout steps consumed (this
// candidate's own turn + however many other actors' turns followed before the fight ended);
// null means the rollout horizon ran out before either side finished.
const WIN_BASE = 1000
const STEPS_PENALTY = 20 // per rollout step consumed before the win — keeps "won faster" strictly better than "won slower" without ever letting turn count outweigh actually winning

/** Total living HP fraction for one team minus the other's — plus a large win/loss bonus so an
 *  actually-decisive plan always beats a merely-better-positioned one, and a FASTER win beats a
 *  slower one. Dead fighters contribute 0, not a penalty beyond already being absent from the
 *  sum (a death is already reflected in every future turn that fighter can no longer take). */
const evaluate = (
  checkpoint: HydratedFightCheckpoint,
  my_team: bigint,
  max_hp_by_character: ReadonlyMap<string, bigint>,
  steps_to_end: number | null
): number => {
  const { contract } = checkpoint
  if (contract.ended) {
    if (contract.winner !== my_team) return contract.winner === null ? 0 : -1000
    return WIN_BASE - STEPS_PENALTY * (steps_to_end ?? 0)
  }
  let mine = 0
  let theirs = 0
  for (const f of contract.fighters) {
    if (f.dead) continue
    const fraction = Number(f.hp) / Math.max(1, max_hp_of(f, max_hp_by_character))
    if (f.team === my_team) mine += fraction
    else theirs += fraction
  }
  return mine - theirs
}

/** Which candidate (by sim_decide.ts's own key shape) a plan's first non-move action used —
 *  the thing to exclude next time to get a genuinely different plan, not a cosmetic variant of
 *  the same one (a move_to alone, from the "nothing reachable, approach" fallback, has nothing
 *  to exclude — there's only ever one such fallback anyway). */
const first_choice_key = (actions: readonly FightCommand[]): string | null => {
  const first = actions.find((a) => a.type === 'cast_spell' || a.type === 'weapon_strike')
  if (!first) return null
  if (first.type === 'cast_spell') return `cast:${first.spell}:${first.target_cell}`
  return `strike::${first.target_cell}`
}

const rollout_from = (
  checkpoint: HydratedFightCheckpoint,
  max_hp_by_character: ReadonlyMap<string, bigint>,
  policy: Policy,
  seed: bigint,
  steps: number
): { checkpoint: HydratedFightCheckpoint; steps_to_end: number | null } => {
  const fight = create_fight({ state: checkpoint, mode: 'local', seed })
  let current = checkpoint
  let step = 0
  for (; step < steps && !current.contract.ended; step += 1) {
    const acting_idx = current.contract.queue[Number(current.contract.turn_ptr)]!
    const actor = current.contract.fighters[Number(acting_idx)]!
    if (actor.kind.type === 'player' && !actor.dead) {
      for (const action of decide_turn(current, acting_idx, max_hp_by_character, policy)) fight.apply(action)
    }
    current = fight.apply({ type: 'end_turn', fighter: acting_idx, observed_ms: TURN_MIN_MS * BigInt(step + 1) }).state
  }
  // step = exactly how many rollout iterations ran before the fight ended (0 if it was already
  // ended going in, i.e. ended during the candidate's own turn, before any rollout iteration).
  return { checkpoint: current, steps_to_end: current.contract.ended ? step : null }
}

/** The lookahead-driven replacement for sim_decide.ts's decide_turn: generates the top-K plans
 *  for the CURRENT actor, rolls each forward, and returns whichever plan scored best — falling
 *  back to the plain greedy pick (K=1 behavior) if only one distinct plan exists (most turns:
 *  there's usually one clearly-best reachable action and nothing else competitive). */
export const decide_turn_with_lookahead = (
  checkpoint: HydratedFightCheckpoint,
  acting_idx: bigint,
  max_hp_by_character: ReadonlyMap<string, bigint>,
  policy: Policy = DEFAULT_POLICY,
  options: LookaheadOptions = DEFAULT_LOOKAHEAD
): readonly FightCommand[] => {
  const acting = checkpoint.contract.fighters[Number(acting_idx)]!
  const my_team = acting.team

  const excluded = new Set<string>()
  const plans: { actions: readonly FightCommand[]; key: string | null }[] = []
  for (let i = 0; i < options.candidates; i += 1) {
    const actions = decide_turn(checkpoint, acting_idx, max_hp_by_character, policy, excluded)
    if (actions.length === 0) break
    const key = first_choice_key(actions)
    if (plans.some((p) => p.key !== null && p.key === key)) break // exhausted distinct options
    plans.push({ actions, key })
    if (key === null) break // the approach-fallback has no alternative to exclude and try again
    excluded.add(key)
  }
  if (plans.length <= 1) return plans[0]?.actions ?? []

  let best_actions = plans[0]!.actions
  let best_score = -Infinity
  for (const plan of plans) {
    let total = 0
    for (let sample = 0; sample < options.samples; sample += 1) {
      // checkpoint is already an in-progress fight (round >= 1) — construct straight from it,
      // no 'start' here (that's only for the placement -> round-1 transition).
      const fight = create_fight({ state: checkpoint, mode: 'local', seed: BigInt(7919 * (sample + 1)) })
      for (const action of plan.actions) fight.apply(action)
      const after_own_turn = fight.apply({
        type: 'end_turn',
        fighter: acting_idx,
        observed_ms: TURN_MIN_MS,
      }).state
      const { checkpoint: rolled, steps_to_end } = rollout_from(
        after_own_turn,
        max_hp_by_character,
        policy,
        BigInt(104729 * (sample + 1)),
        options.rollout_steps
      )
      // +1: the candidate's own turn (already applied above, before the rollout started) also
      // costs a real transaction — a plan that wins ON ITS OWN turn should score higher than
      // one that only wins after several more rollout steps, and this keeps both counted.
      total += evaluate(rolled, my_team, max_hp_by_character, steps_to_end === null ? null : steps_to_end + 1)
    }
    const avg = total / options.samples
    if (avg > best_score) {
      best_score = avg
      best_actions = plan.actions
    }
  }
  return best_actions
}
