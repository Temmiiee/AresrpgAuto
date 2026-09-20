// Runs one full fight entirely offline against @aresrpg/fight — the same deterministic engine
// the chain's Move logic mirrors exactly (movement, damage, resistances, crits, mob AI, all of
// it), just local and free. mob_turn is built into the engine itself (turns.ts:
// run_until_player), so apply()ing 'end_turn' automatically resolves every mob turn up to the
// next living player — the caller only ever decides PLAYER actions.
import { create_character_source, create_fight, player_max_hp, mob_scalar_for_level, xp_award_of } from '@aresrpg/fight'
import type { FightMobInput, FightPlayerInput, HydratedFightCheckpoint, WeaponSource } from '@aresrpg/fight'

import { get_item_price } from '../market/item_valuation.ts'

import { decide_turn } from './sim_decide.ts'
import { find_mob_template, all_spell_sources } from './sim_content.ts'
import { DEFAULT_POLICY, type Policy } from './policy.ts'

/** The shape of both sim_decide.ts's decide_turn and lookahead.ts's decide_turn_with_lookahead
 *  — simulate_fight doesn't care which one it's driving with. */
export type TurnDecider = (
  checkpoint: HydratedFightCheckpoint,
  acting_idx: bigint,
  max_hp_by_character: ReadonlyMap<string, bigint>,
  policy: Policy
) => readonly import('@aresrpg/fight').FightCommand[]

export type SimPartyMember = {
  name: string
  classe: string
  level: number
  vitality: number
  wisdom: number
  strength: number
  intelligence: number
  chance: number
  agility: number
  /** The character's equipped weapon (read_equipped_weapon) — absent means honestly unarmed:
   *  the sim's build strikes with the same unarmed fallback the chain resolves for a bare slot. */
  weapon?: WeaponSource
  /** Raised spell levels (read_spell_book): spell name -> invested level. A spell absent here
   *  casts at its self-learned level 1, matching the chain's own default. Absent entirely means
   *  every spell at level 1 — the honest default for sims built from scratch (cli_train,
   *  composition sweeps) that have no chain reads behind them. */
  spell_levels?: Readonly<Record<string, number>>
}

export type SimMobGroupMember = { mob_type: string; level: number }

export type SimOutcome = {
  won: boolean
  turns: number
  rounds: number
  xp_gained: Readonly<Record<string, number>>
  final_hp_fraction: Readonly<Record<string, number>>
}

const SPELLS = all_spell_sources()

// Exported so record_replay.ts (cli_record_replay.ts's fight-visualization recorder) can build
// the exact same players/mobs/characters shape without duplicating this logic.
export const build_setup = (party: readonly SimPartyMember[], mob_group: readonly SimMobGroupMember[]) => {
  const characters = party.map((member, index) => {
    const source = create_character_source({
      name: member.name,
      classe: member.classe,
      level: BigInt(member.level),
      vitality: BigInt(member.vitality),
      wisdom: BigInt(member.wisdom),
      strength: BigInt(member.strength),
      intelligence: BigInt(member.intelligence),
      chance: BigInt(member.chance),
      agility: BigInt(member.agility),
      weapon: member.weapon ?? null,
      spell_levels: Object.fromEntries(Object.entries(member.spell_levels ?? {}).map(([name, lvl]) => [name, BigInt(lvl)])),
    })
    return { id: `0xplayer${index}`, source }
  })
  const players: FightPlayerInput[] = characters.map(({ id, source }) => ({
    character: id,
    owner: '0xowner',
    team: 0n,
    ready: true,
    hp: player_max_hp(source),
    source,
  }))
  const mobs: FightMobInput[] = mob_group.map(({ mob_type, level }) => {
    const template = find_mob_template(mob_type)
    return { team: 1n, scalar: mob_scalar_for_level(template, BigInt(level)), template }
  })
  return { players, mobs, characters }
}

/** One fight, one deterministic seed. Each mob's `level` is clamped into ITS OWN level_min/max
 *  band by mob_scalar_for_level — asking for a level outside its range just simulates the
 *  nearest end of that band, matching how the real game would scale it. */
export const simulate_fight = (
  party: readonly SimPartyMember[],
  mob_group: readonly SimMobGroupMember[],
  seed: bigint,
  policy: Policy = DEFAULT_POLICY,
  decider: TurnDecider = decide_turn
): SimOutcome => {
  const { players, mobs, characters } = build_setup(party, mob_group)
  const max_hp_by_character = new Map(characters.map(({ id, source }) => [id, player_max_hp(source)]))

  const fight = create_fight({
    setup: { fight_id: 'sim', world: 'sim', board_seed: seed, players, mobs, spells: SPELLS },
    mode: 'local',
    seed,
  })
  // The engine enforces the same real turn_min_ms (3s) floor the chain does — a virtual clock
  // that actually advances each turn is required, or every end_turn reads as "too soon" and the
  // fight never progresses past round 1.
  const TURN_MIN_MS = 3_100n
  let virtual_ms = 0n
  fight.apply({ type: 'start', observed_ms: virtual_ms })

  let turns = 0
  let checkpoint: HydratedFightCheckpoint = fight.state()
  while (!checkpoint.contract.ended && turns < 400) {
    const acting_idx = checkpoint.contract.queue[Number(checkpoint.contract.turn_ptr)]!
    const actions = decider(checkpoint, acting_idx, max_hp_by_character, policy)
    for (const action of actions) fight.apply(action)
    virtual_ms += TURN_MIN_MS
    const result = fight.apply({ type: 'end_turn', fighter: acting_idx, observed_ms: virtual_ms })
    checkpoint = result.state
    turns += 1
  }

  const won = checkpoint.contract.winner === 0n
  const xp_gained: Record<string, number> = {}
  const final_hp_fraction: Record<string, number> = {}
  for (const { id } of characters) {
    const seat = checkpoint.contract.fighters.findIndex((f) => f.kind.type === 'player' && f.kind.character === id)
    const fighter = seat >= 0 ? checkpoint.contract.fighters[seat] : undefined
    const max_hp = max_hp_by_character.get(id) ?? 1n
    final_hp_fraction[id] = fighter ? Number(fighter.hp) / Number(max_hp) : 0
    xp_gained[id] = seat >= 0 ? Number(xp_award_of(checkpoint, BigInt(seat))) : 0
  }

  return { won, turns, rounds: Number(checkpoint.contract.round), xp_gained, final_hp_fraction }
}

export type SimBatchResult = {
  runs: number
  win_rate: number
  avg_turns: number
  avg_rounds: number
  avg_final_hp_fraction_when_won: number
  /** Only over WINS -- see fitness_score's comment for why avg_turns (pooled over wins and
   *  losses) can't be the thing scored. */
  avg_turns_when_won: number
  /** Total party XP per turn spent, across ALL runs (losses count as 0 XP but still cost
   *  turns) — the "fastest to beat for the most reward" ranking signal in one number. */
  avg_xp_per_turn: number
}

// Every turn is a real transaction on the real chain — winning slowly still burns gas the whole
// way there. win_rate is scaled large enough (300) that winning always beats losing regardless
// of turn count (even a 290-turn win beats an instant loss), but AMONG wins, turn count is a
// real, substantial factor: 100 fewer turns is worth as much as a 33-point win-rate swing.
// The single number cli_train.ts, cli_tune.ts, and fight_session.ts's pre-engage screening all
// rank candidates by — keeping "winning fast matters most" consistent everywhere it's used.
//
// Scores avg_turns_when_won, NOT the pooled avg_turns across wins and losses (2026-09-03,
// flagged by the project owner): penalizing turn count on ALL outcomes rewards a policy for
// dying FASTER in the fights it loses, which is exactly backwards — speed should only ever
// be a tiebreaker among ways of WINNING. A scenario the policy never wins scores 0 from this
// term regardless of how long the losses took (not a bug — losing fast and losing slow are
// both just losing; win_rate already penalizes not winning at full WIN_RATE_SCALE weight).
// This exact same flaw existed in the sibling AresRPG-RL repo's Python port too — fixed
// there in the same pass, see rl/evolve.py.
const WIN_RATE_SCALE = 300
const TURN_PENALTY = 1
export const fitness_score = (result: SimBatchResult): number =>
  result.win_rate * WIN_RATE_SCALE - result.avg_turns_when_won * TURN_PENALTY

/** Expected SUI value of one fight's loot, straight off the mobs' own authored drop tables —
 *  entirely offline, no gas, no chain read (seed content is static). Uses the RAW chance_bp, not
 *  the party's actual Chance-boosted roll (fight.move's roll_and_split scales it by team Chance,
 *  capped at 10000bp) — a deliberate underestimate, since it's safer to undervalue a fight's
 *  reward than to chase one on an inflated expectation with no real market data behind it
 *  (item_valuation.ts's own honest limitation). An unrecognized mob_type (a game-content update
 *  the seed content hasn't caught up to yet) is skipped rather than aborting the whole estimate. */
export const expected_loot_value_sui = (mob_group: readonly SimMobGroupMember[]): number => {
  let total = 0
  for (const { mob_type } of mob_group) {
    let template
    try {
      template = find_mob_template(mob_type)
    } catch (error) {
      console.warn(`simulate: skipping loot estimate for unknown mob_type ${mob_type} (${String(error)})`)
      continue
    }
    for (const drop of template.loot) {
      const chance = Number(drop.chance_bp) / 10_000
      const avg_qty = (Number(drop.min_qty) + Number(drop.max_qty)) / 2
      total += chance * avg_qty * get_item_price(drop.item_type).unit_price_sui
    }
  }
  return total
}

// Reward-aware ranking for CHOOSING which group to engage — separate from fitness_score, which
// stays win-rate/speed only: a POLICY's job is to win whatever it's given efficiently, regardless
// of target, so training should never optimize it for "picks profitable fights." Group selection
// is the opposite job — among candidates a policy can ALREADY reliably beat (the caller applies
// MIN_SIM_WIN_RATE as a hard gate before ever calling this), prefer whichever pays out more per
// turn, since turns are what cost real gas — "reward per gas," not just raw reward. XP and loot
// sit on very different scales (tens-to-low-thousands of XP vs. hundredths of a SUI) with no real
// exchange rate between them absent live market data, so they're kept as two independently
// weighted terms rather than a fabricated combined unit — SUI_PER_TURN_WEIGHT is a rough scale
// pick (a typical ~0.01-0.05 SUI/turn single-material drop registers like a modest XP swing,
// neither negligible nor dominant), a first cut for a real cli_tune.ts-style search later.
//
// 2026-09-16: SUI_PER_TURN_WEIGHT dropped 2_000 → 200 to compensate the 10x bump in
// item_valuation.ts (item_prices.json x10, ROYALTY_FLOOR coverage). The expected-loot read feeds
// on the now-valued unit prices, so the loot term silently became 10x stronger than this comment's
// scale pick intended — enough to drown XP entirely and make fight discovery pick the richest
// easy fights (1-xp lorito lv1-2) instead of the winnable ones that award real XP. ÷10 restores
// the original "both terms matter" intent behind this heuristic.
const XP_PER_TURN_WEIGHT = 1
const SUI_PER_TURN_WEIGHT = 200
export const reward_score = (result: SimBatchResult, mob_group: readonly SimMobGroupMember[]): number => {
  const loot_per_turn = result.avg_turns > 0 ? expected_loot_value_sui(mob_group) / result.avg_turns : 0
  return result.avg_xp_per_turn * XP_PER_TURN_WEIGHT + loot_per_turn * SUI_PER_TURN_WEIGHT
}

/** Runs `runs` fights with distinct seeds and aggregates — the actual "can we beat this, and
 *  how cleanly" answer, since a single fight's outcome depends on crit/dodge rolls. */
export const simulate_many = (
  party: readonly SimPartyMember[],
  mob_group: readonly SimMobGroupMember[],
  runs: number,
  seed_base = 1n,
  policy: Policy = DEFAULT_POLICY,
  decider: TurnDecider = decide_turn
): SimBatchResult => {
  const outcomes: SimOutcome[] = []
  for (let i = 0; i < runs; i += 1)
    outcomes.push(simulate_fight(party, mob_group, seed_base + BigInt(i), policy, decider))
  const wins = outcomes.filter((o) => o.won)
  const avg = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)
  const total_turns = outcomes.reduce((sum, o) => sum + o.turns, 0)
  const total_xp = outcomes.reduce((sum, o) => sum + Object.values(o.xp_gained).reduce((a, b) => a + b, 0), 0)
  return {
    runs,
    win_rate: wins.length / runs,
    avg_turns: avg(outcomes.map((o) => o.turns)),
    avg_rounds: avg(outcomes.map((o) => o.rounds)),
    avg_final_hp_fraction_when_won: avg(wins.flatMap((o) => Object.values(o.final_hp_fraction))),
    avg_turns_when_won: avg(wins.map((o) => o.turns)),
    avg_xp_per_turn: total_turns > 0 ? total_xp / total_turns : 0,
  }
}
