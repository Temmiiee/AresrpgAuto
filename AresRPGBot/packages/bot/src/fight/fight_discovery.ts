// Phase 2 of a group fight: find an in-progress fight to resume, or search + screen + engage a
// fresh one.
//
// find_or_create_fight calls run_one_group_fight (fight_session.ts, the orchestrator) on two
// specific on-chain races (abort 1702/1703 — see below) to fully restart the fight from scratch.
// That makes this file and fight_session.ts mutually import each other — safe here because
// neither call happens at module load, only inside an async function body invoked well after
// both modules have finished evaluating (standard ESM circular-import pattern).
import type { BotSdk } from '../auth/sdk_client.ts'
import { read_group_state, write_group_state } from '../state/group_state.ts'
import { read_hp_state, ms_until_fraction } from '../state/hp_state.ts'
import { read_mob_groups } from '../shared/zone_read.ts'
import { message_of, sleep, submit_with_retry } from '../shared/chain_retry.ts'
import { CHARACTERS, LEADER, WORLD } from '../config/party_config.ts'
import { reward_score, type SimBatchResult, type SimMobGroupMember } from '../ai/simulate.ts'
import { simulate_many_parallel } from '../ai/sim_pool.ts'
import { load_trained_policy } from '../ai/policy_store.ts'
import type { PartyPrep } from './fight_progression.ts'
import type { Position, MobInfo, FightOutcome } from './fight_state.ts'
import { run_one_group_fight } from './fight_session.ts'

const SPEED_BUDGET = 1150
const SPEED_SCALE = 100_000
const WAIT_MARGIN_MS = 4_000
// A mob group is skipped unless its average member level is within this many levels of the
// party's own average. Was 2 (the lesson from the moka fight, avg level 7.3 vs party avg 4.5,
// back when nothing screened harder groups at all before engaging) — widened once real
// simulation became the actual safety check (MIN_SIM_WIN_RATE below): this is now only a cheap
// pre-filter against truly hopeless matchups, not the winnability gate itself, so it can afford
// to let much harder — and more rewarding — groups through to simulation (2026-09-03, user
// request: prefer harder-but-still-winnable fights over always the safest one).
const MAX_LEVEL_MARGIN = 8
// How many level-eligible groups get an actual offline simulation before engaging — bounded
// because each one costs real wall-clock time (harder matchups run several seconds), not because
// it costs gas (it doesn't). Raised alongside MAX_LEVEL_MARGIN so opening the level range doesn't
// just get shadowed by an unchanged cap — see the pre-sort below for which groups fill it first
// when there are more eligible ones than this.
const SIM_SCREEN_CANDIDATES = 10
const SIM_SCREEN_RUNS = 5
// The hard safety floor: a group under this simulated win rate is skipped no matter how
// rewarding it looks — "always winnable" stays non-negotiable; reward_score (ai/simulate.ts) only
// ever ranks candidates that already clear it. Deliberately NOT loosened alongside
// MAX_LEVEL_MARGIN above (2026-09-03, explicit user instruction: focus fights that are ALWAYS
// winnable, just don't rule out harder/farther ones a-priori before simulation gets to check).
// Revisit only once AresRPG-RL exports a validated stronger policy (learned_policy.local.json,
// the sibling repo's tools/export_policy_to_bot.py) that measurably wins harder fights faster —
// cli_validate_policy.ts's held-out comparison is the signal to check first.
const MIN_SIM_WIN_RATE = 0.6
// Don't walk into another fight under-healed — the lesson from going in at 1 HP after a loss.
const MIN_HP_FRACTION = 0.8

// Screening memo: a group's simulated win rate is a pure function of the GROUP's composition and
// the PARTY's current profile (levels + equipped weapon categories) at a given (zx, zz) seed —
// none of which change between consecutive battles in the same zone (the only mutable thing,
// `mob_taken`, is captured by the group list `read_mob_groups` already re-read fresh each pass).
// Without this, re-fighting a zone re-simulated the same ~10 candidates every battle, a ~140 s
// silent stretch (measured 2026-09-16: 10 candidates × 5 runs, 139.8 s) — on every one of the
// BATTLES_PER_ZONE fights. The cache keys on the group index + full composition + the party
// profile (levels, weapon category per character) + the run count, so ANY of those changing
// recomputes naturally; nothing can go stale-and-wrong because the key encodes every input the
// result depends on. Bounded (clears at 1000 entries) so a long roamer doesn't grow it forever.
const SCREEN_CACHE_MAX = 1000
const screen_cache = new Map<string, SimBatchResult>()
const { policy: SCREEN_POLICY } = load_trained_policy()
const SCREEN_POLICY_KEY = JSON.stringify(SCREEN_POLICY)

// Detects a character already seated in an on-chain fight by walking its OWNER chain up to 2
// hops (character -> immediate owner -> that owner's owner), since a character inside a fight is
// owned by the Fight object either directly or via one wrapper. Best-effort: a read failure just
// means "couldn't tell," not "definitely not in a fight," so the caller falls through to the
// normal search-a-fresh-fight path rather than treating it as fatal. Accepted soft hotspot
// (cyclomatic ~14 vs. this repo's usual 12 ceiling) — the 2-hop walk is inherently this many
// branches; splitting it further would trade clarity for a number this package isn't gated on.
const find_active_fight_id = async (
  sdk: BotSdk['sdk'],
  character_id: string,
  log: (msg: string) => void
): Promise<string | null> => {
  const is_fight = (t?: string) => Boolean(t && t.endsWith('::fight::Fight'))
  const owner_id = (object?: { owner?: unknown }): string | null => {
    const owner = (object?.owner as { ObjectOwner?: unknown })?.ObjectOwner
    return typeof owner === 'string' ? owner : null
  }
  // The gRPC transport accepts `owner` in `include` at runtime; SuiTransport's own declared type
  // only names `json` (client.ts's narrower structural interface for the SDK's OWN needs) — this
  // local widening reflects the real, wider runtime contract without touching the shared SDK.
  const get_objects_with_owner = (input: { objectIds: string[]; include: { owner?: boolean; json?: boolean } }) =>
    sdk.sui_client.core.getObjects(input as { objectIds: string[]; include?: { json?: boolean } })
  try {
    const { objects: r1 } = await get_objects_with_owner({ objectIds: [character_id], include: { owner: true } })
    const p1 = owner_id(r1[0])
    if (!p1) return null

    const { objects: r2 } = await get_objects_with_owner({ objectIds: [p1], include: { owner: true, json: true } })
    if (is_fight(r2[0]?.type)) return p1
    const p2 = owner_id(r2[0])
    if (!p2) return null

    const { objects: r3 } = await sdk.sui_client.core.getObjects({ objectIds: [p2], include: { json: true } })
    return is_fight(r3[0]?.type) ? p2 : null
  } catch (error) {
    log(`active-fight detection for ${character_id} inconclusive (${message_of(error)}) — assuming not in a fight`)
    return null
  }
}

export type FoundFight = Readonly<
  { kind: 'ready'; fight_id: string; mobs: readonly MobInfo[] } | { kind: 'retried'; outcome: FightOutcome }
>

export const find_or_create_fight = async (
  bot: BotSdk,
  position: Position,
  zx: number,
  zz: number,
  world: string,
  world_content: string,
  prep: PartyPrep,
  log: (msg: string) => void
): Promise<FoundFight> => {
  const { sdk, fight, character } = bot

  let { fight_id } = read_group_state()
  if (!fight_id) {
    for (const c of CHARACTERS) {
      const active_id = await find_active_fight_id(sdk, c.id, log)
      if (active_id) {
        fight_id = active_id
        write_group_state({ fight_id })
        log(`detected character ${c.name} already in active on-chain fight ${fight_id} — resuming fight!`)
        break
      }
    }
  }
  if (fight_id) {
    log(`resuming fight ${fight_id}`)
    return { kind: 'ready', fight_id, mobs: [] }
  }

  // HP-regen gate: only relevant when we're about to CHOOSE a new fight, not when resuming
  // one already in progress. Waits for the slowest-healing character to reach MIN_HP_FRACTION.
  const hp_state = read_hp_state()
  const now = Date.now()
  const hp_wait_ms = CHARACTERS.reduce((worst, c) => {
    const record = hp_state[c.id]
    return record ? Math.max(worst, ms_until_fraction(record, MIN_HP_FRACTION, now)) : worst
  }, 0)
  if (hp_wait_ms > 0) {
    log(`waiting ${(hp_wait_ms / 1000).toFixed(0)}s for the party to regen to ${MIN_HP_FRACTION * 100}% HP…`)
    await sleep(hp_wait_ms)
  }

  log(`searching zone (${zx},${zz}) at (${position.x},${position.z})…`)
  // search_zone's `refresh` isn't optional (character_actions.ts: false for first discovery,
  // true once the derived Zone object already exists) -- there's no local record of which
  // zones this account has already discovered, so try a fresh discovery first and fall back to
  // refresh only on the specific "already exists" collision. This dry-run-rejects-before-
  // submitting (the SDK's own "NOT submitted" wording), so the fallback costs no extra gas.
  try {
    await submit_with_retry(
      () => character.search_zone({ character_id: LEADER.id, world: WORLD, x: position.x, z: position.z, refresh: false }),
      log
    )
  } catch (error) {
    if (!/EObjectAlreadyExists|derived_object::claim/i.test(message_of(error))) throw error
    log('zone already discovered — refreshing instead…')
    await submit_with_retry(
      () => character.search_zone({ character_id: LEADER.id, world: WORLD, x: position.x, z: position.z, refresh: true }),
      log
    )
  }
  const checkpoint_at = Date.now()

  const groups = await read_mob_groups(sdk, world, world_content, zx, zz)
  if (groups.length === 0) throw new Error('No mob groups found in this zone right now')

  const party_avg_level = [...prep.levels.values()].reduce((sum, lvl) => sum + lvl, 0) / prep.levels.size
  const avg_level_of = (g: (typeof groups)[number]) =>
    g.members.reduce((sum, m) => sum + m.level_scalar, 0) / g.members.length
  const distance_of = (g: (typeof groups)[number]) => Math.hypot(g.x - position.x, g.z - position.z)

  const easy_enough = groups.filter((g) => avg_level_of(g) <= party_avg_level + MAX_LEVEL_MARGIN)
  if (easy_enough.length === 0) {
    const weakest = [...groups].sort((a, b) => avg_level_of(a) - avg_level_of(b))[0]!
    throw new Error(
      `No group in this zone is within reach of the party's level (party avg ${party_avg_level.toFixed(1)}, weakest group here avg ${avg_level_of(weakest).toFixed(1)})`
    )
  }

  // Simulate the toughest level-eligible candidates first against the party's REAL current stats
  // (free, no gas, only wall-clock cost) — when there are more eligible groups than
  // SIM_SCREEN_CANDIDATES can afford to check, spend that budget on the hardest ones, since those
  // are exactly the higher-XP/better-loot groups worth confirming winnable (2026-09-03: "chercher
  // des monstres de niveau plus élevé mais qu'on pourrait toujours battre" — the softer/closer
  // groups this leaves unsimulated are also the ones least likely to ever be the reward-optimal
  // pick anyway). If nothing simulated clears MIN_SIM_WIN_RATE, fall back to the LOWEST-level
  // screened group instead — the safest bet available, mirroring what "nearest" used to proxy for.
  type ScreenedGroup = {
    group: (typeof easy_enough)[number]
    mob_group: SimMobGroupMember[]
    sim: SimBatchResult | null
  }
  const sim_party = CHARACTERS.map((c) => prep.sim_party_stats.get(c.id)!)
  // Reserve one slot for the single EASIEST group in reach, always -- the rest of the budget
  // still goes to the hardest ones (comment above). Without this, the "fall back to the safest
  // simulated group" below (when nothing clears MIN_SIM_WIN_RATE) can only ever fall back to the
  // safest of the SAME hardest-first slice, never anything genuinely easy that just didn't make
  // the cut -- confirmed happening for a fresh level-1 party (2026-09-04): MAX_LEVEL_MARGIN=8
  // let mobs up to level 9 into `easy_enough`, all 10 simulated candidates were drawn from the
  // hard end of that range, none cleared 60%, and the "safest" fallback was still one of those
  // 10 -- never an easier group sitting right there in the same zone.
  const hardest_first = [...easy_enough].sort((a, b) => avg_level_of(b) - avg_level_of(a))
  const easiest = [...easy_enough].sort((a, b) => avg_level_of(a) - avg_level_of(b))[0]!
  const candidates = [easiest, ...hardest_first.filter((g) => g !== easiest)].slice(0, SIM_SCREEN_CANDIDATES)
  // Fully offline, no gas -- but the screening batch used to cost a multi-minute silent stretch
  // between "searching zone" and the pick (measured 2026-09-16: 50 groups, 10 candidates, 140s
  // wall clock with no output at all). Three fixes since: the screen cache (below) reuses results
  // across consecutive battles in the same zone (nothing its key encodes changes mid-zone), the
  // spell-book accuracy fix (fight_progression.ts + read_spell_book) lets the party fight with
  // its REAL invested spell levels (measured ~35% fewer turns than always-casting level-1), and
  // the whole uncached batch now runs across worker threads (sim_pool.ts) instead of one fight
  // after another. Log each candidate as its result lands so the wait still reads as progress,
  // not a hang.
  const party_profile = CHARACTERS.map((c) => {
    const member = sim_party[CHARACTERS.findIndex((m) => m.id === c.id)]!
    return `${member.level}/${member.weapon?.category ?? ''}`
  }).join('|')
  type CandidateWithSim = {
    group: (typeof candidates)[number]
    mob_group: SimMobGroupMember[]
    cache_key: string
  }
  const candidates_with_sim: CandidateWithSim[] = candidates.map((group) => ({
    group,
    mob_group: group.members.map((m) => ({ mob_type: m.mob_type, level: m.level_scalar })),
    cache_key: `${zx},${zz}#${group.index}#${group.members.map((m) => `${m.mob_type}:${m.level_scalar}`).join(',')}#${party_profile}#${SCREEN_POLICY_KEY}#${SIM_SCREEN_RUNS}`,
  }))
  const cached_hits = new Map<number, SimBatchResult>()
  const to_sim: (CandidateWithSim & { index: number })[] = []
  candidates_with_sim.forEach((entry, index) => {
    const cached = screen_cache.get(entry.cache_key)
    if (cached) cached_hits.set(index, cached)
    else to_sim.push({ ...entry, index })
  })
  log(
    `simulating ${candidates.length} candidate group(s) (${SIM_SCREEN_RUNS} runs each, ${to_sim.length} to simulate across worker threads) — hardest first, this is the quiet part…`
  )
  const simulated_at = Date.now()
  const sims =
    to_sim.length > 0
      ? await simulate_many_parallel(
          sim_party,
          to_sim.map((t) => ({ mob_group: t.mob_group, runs: SIM_SCREEN_RUNS })),
          SCREEN_POLICY
        )
      : []
  for (const [local, t] of to_sim.entries()) {
    const sim = sims[local] ?? null
    if (sim) {
      screen_cache.set(t.cache_key, sim)
      if (screen_cache.size > SCREEN_CACHE_MAX) screen_cache.clear()
    }
  }
  const elapsed_s = ((Date.now() - simulated_at) / 1000).toFixed(1)
  const screened: ScreenedGroup[] = []
  for (let idx = 0; idx < candidates_with_sim.length; idx += 1) {
    const { group, mob_group } = candidates_with_sim[idx]
    const cached = cached_hits.get(idx)
    const run_index = to_sim.findIndex((t) => t.index === idx)
    const sim = cached ?? (run_index >= 0 ? (sims[run_index] ?? null) : null)
    if (cached)
      log(
        `  group #${group.index} (avg lv ${avg_level_of(group).toFixed(1)}, ${mob_group.map((m) => `${m.mob_type}(${m.level})`).join(', ')}) — cached (${(cached.win_rate * 100).toFixed(0)}% win, ~${cached.avg_turns.toFixed(0)} turns)`
      )
    else if (sim)
      log(
        `  group #${group.index} (avg lv ${avg_level_of(group).toFixed(1)}, ${mob_group.map((m) => `${m.mob_type}(${m.level})`).join(', ')}) simulated in ${elapsed_s}s → ${(sim.win_rate * 100).toFixed(0)}% win, ~${sim.avg_turns.toFixed(0)} turns`
      )
    else log(`  simulated screening skipped for group #${group.index}`)
    screened.push({ group, mob_group, sim })
  }
  const viable = screened.filter((s) => s.sim !== null && s.sim.win_rate >= MIN_SIM_WIN_RATE)
  // "Always winnable" is meant to be non-negotiable (MIN_SIM_WIN_RATE's own comment) -- refuse to
  // engage rather than force the least-bad simulated option when NOTHING clears the bar, instead
  // of the old unconditional fallback. Confirmed a real problem for a fresh level-1 party
  // (2026-09-04): every simulated candidate came back well under 60%, and the bot fought the
  // "safest of a bad lot" anyway, repeatedly, rather than waiting for a better zone -- burning
  // gas on fights that were never winnable, exactly what MIN_SIM_WIN_RATE exists to prevent.
  if (viable.length === 0) {
    const safest = [...screened].sort((a, b) => avg_level_of(a.group) - avg_level_of(b.group))[0]!
    throw new Error(
      `Nothing in this zone clears the ${(MIN_SIM_WIN_RATE * 100).toFixed(0)}% win-rate floor (best simulated: group #${safest.group.index} at ${safest.sim ? (safest.sim.win_rate * 100).toFixed(0) : '?'}%) -- refusing to force a losing fight`
    )
  }
  const picked = viable.sort((a, b) => reward_score(b.sim!, b.mob_group) - reward_score(a.sim!, a.mob_group))[0]!
  const target = picked.group
  const mobs = target.members.map((m) => ({ mob_type: m.mob_type, level: m.level_scalar }))
  log(
    `${viable.length > 0 ? 'best-reward-simulated' : 'safest fallback (simulation unavailable or nothing met the win-rate bar)'} group #${target.index} (avg lv ${avg_level_of(target).toFixed(1)} vs party avg ${party_avg_level.toFixed(1)}) at (${target.x},${target.z}) — ${mobs.map((m) => `${m.mob_type}(lv${m.level})`).join(', ')}` +
      (picked.sim
        ? ` [simulated: ${(picked.sim.win_rate * 100).toFixed(0)}% win, ~${picked.sim.avg_turns.toFixed(0)} turns, ${picked.sim.avg_xp_per_turn.toFixed(0)} xp/turn]`
        : '')
  )

  const distance = distance_of(target)
  const required_wait_ms = Math.ceil((distance * SPEED_SCALE) / SPEED_BUDGET) + WAIT_MARGIN_MS
  const remaining_ms = required_wait_ms - (Date.now() - checkpoint_at)
  if (remaining_ms > 0) {
    log(`waiting ${(remaining_ms / 1000).toFixed(1)}s for travel time…`)
    await sleep(remaining_ms)
  }

  log(`${LEADER.name} engaging (group-only access)…`)
  let engaged: { fight: string }
  try {
    engaged = await submit_with_retry(
      () =>
        fight.engage({
          character_id: LEADER.id,
          world: WORLD,
          zone_x: zx,
          zone_z: zz,
          group_index: BigInt(target.index),
          mob_types: mobs.map((m) => m.mob_type),
          access: 1,
        }),
      log
    )
  } catch (error) {
    if (/abort code:\s*1702\b/i.test(message_of(error))) {
      log(`group #${target.index} despawned or was engaged by another player (abort code 1702) — re-searching zone…`)
      await sleep(3_000)
      return { kind: 'retried', outcome: await run_one_group_fight(bot, position, log) }
    }
    // EWrongMob (fight.move) -- add_mob rebuilds its pending queue from the zone's on-chain
    // state fresh at execution time, not from what we read minutes ago while simulating/waiting
    // out travel time; if the zone's seed got rerolled in between (another character's search
    // landing after this zone's TTL expired), group #target.index can have a different
    // size/type/order by the time this transaction actually executes. Same class of race as
    // 1702 above (stale client read vs. authoritative on-chain state at execution), just a
    // different failure shape -- same recovery.
    if (/abort code:\s*1703\b/i.test(message_of(error))) {
      log(`group #${target.index}'s composition changed under us (abort code 1703, likely a zone reseed) — re-searching zone…`)
      await sleep(3_000)
      return { kind: 'retried', outcome: await run_one_group_fight(bot, position, log) }
    }
    throw error
  }
  log(`fight created: ${engaged.fight}`)
  write_group_state({ fight_id: engaged.fight })
  return { kind: 'ready', fight_id: engaged.fight, mobs }
}
