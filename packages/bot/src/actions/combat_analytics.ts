// Opt-in, per-fight JSONL diagnostics. The authoritative streamed checkpoints are the outcome
// record; submitted plans can therefore be compared with what the engine actually resolved.
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HydratedFightCheckpoint } from '@aresrpg/fight'

import { config } from '../config.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { notify } from '../shared/discord_notify.ts'

const ROOT = fileURLToPath(new URL('../../logs/fights/', import.meta.url))
const MAX_FIGHT_LOG_BYTES = 8 * 1024 * 1024
const tails = new Map<string, Promise<void>>()
const previous_fighters = new Map<string, readonly FighterSnapshot[]>()
const capped = new Set<string>()
type LiveMetrics = {
  rounds: number; turns: number; passes: number; dealt: number; received: number; healed: number
  ap_spent: number; mp_spent: number; casts: Map<string, number>
}
const live_metrics = new Map<string, LiveMetrics>()

export const combat_analytics_enabled = (): boolean => config.combat_analytics

const metrics_for = (fight: string): LiveMetrics => {
  let metrics = live_metrics.get(fight)
  if (!metrics) {
    metrics = { rounds: 0, turns: 0, passes: 0, dealt: 0, received: 0, healed: 0, ap_spent: 0, mp_spent: 0, casts: new Map() }
    live_metrics.set(fight, metrics)
  }
  return metrics
}

type FighterSnapshot = Readonly<{
  seat: number
  team: string
  kind: string
  name: string
  mob_type?: string
  mob_level?: string
  max_hp?: string
  classe?: string
  mob_spells?: readonly Readonly<{ name: string; ap_cost: string; range_min: string; range_max: string }>[]
  resistances?: Readonly<{ earth: string; fire: string; water: string; air: string }>
  cell: string
  hp: string
  ap: string
  mp: string
  dead: boolean
  effects: readonly unknown[]
  cooldowns: readonly unknown[]
}>

const json_safe = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value

const safe_id = (fight: string): string => basename(fight).replace(/[^a-zA-Z0-9_-]/g, '_')
const path_of = (fight: string): string => join(ROOT, `${safe_id(fight)}.jsonl`)

const snapshot = (cp: HydratedFightCheckpoint): readonly FighterSnapshot[] =>
  Object.freeze(cp.contract.fighters.map((fighter, seat) => {
    const kind = fighter.kind as unknown as Record<string, unknown>
    const kind_name = String(kind.type ?? 'unknown')
    const mob = fighter.kind.type === 'mob' ? fighter.kind.snapshot : undefined
    const player = fighter.kind.type === 'player' ? cp.sources.players[fighter.kind.character] : undefined
    const name = String(player?.name ?? mob?.mob_type ?? kind.character ?? kind.mob_type ?? kind.name ?? kind_name)
    return Object.freeze({
      seat,
      team: String(fighter.team),
      kind: kind_name,
      name,
      ...(mob
        ? {
            mob_type: mob.mob_type,
            mob_level: String(mob.level),
            max_hp: String(mob.max_hp),
            mob_spells: mob.kit.map(({ name, level }) => ({
              name,
              ap_cost: String(level.ap_cost),
              range_min: String(level.range_min),
              range_max: String(level.range_max),
            })),
            resistances: {
              earth: String(mob.earth_res),
              fire: String(mob.fire_res),
              water: String(mob.water_res),
              air: String(mob.air_res),
            },
          }
        : {}),
      ...(player ? { classe: player.classe } : {}),
      cell: String(fighter.cell),
      hp: String(fighter.hp),
      ap: String(fighter.ap),
      mp: String(fighter.mp),
      dead: fighter.dead,
      effects: fighter.effects,
      cooldowns: fighter.cooldowns,
    })
  }))

const append = (fight: string, type: string, payload: unknown): void => {
  if (!config.combat_analytics) return
  const file = path_of(fight)
  const previous = tails.get(file) ?? Promise.resolve()
  const task = previous.then(async () => {
    await mkdir(dirname(file), { recursive: true })
    const line = `${JSON.stringify({ at: new Date().toISOString(), fight, type, payload }, json_safe)}\n`
    const bytes = Buffer.byteLength(line)
    let size = 0
    try {
      size = (await stat(file)).size
    } catch {
      // First record for a fight.
    }
    if (size + bytes > MAX_FIGHT_LOG_BYTES) {
      if (!capped.has(file)) {
        capped.add(file)
        log_warn('analytics', `fight ${fight}: log reached ${MAX_FIGHT_LOG_BYTES} bytes; remaining events omitted`)
      }
      return
    }
    await appendFile(file, line, 'utf8')
  }).catch((error: unknown) => {
    log_warn('analytics', `could not write fight ${fight}: ${error instanceof Error ? error.message : String(error)}`)
  })
  tails.set(file, task)
}

export const analytics_fight_started = (fight: string, payload: unknown): void => {
  if (!config.combat_analytics) return
  metrics_for(fight)
  append(fight, 'fight_started', payload)
}

export const analytics_fight_origin = (fight: string, payload: unknown): void => {
  append(fight, 'fight_origin', payload)
}

export const analytics_checkpoint = (fight: string, cp: HydratedFightCheckpoint): void => {
  if (!config.combat_analytics) return
  const metrics = metrics_for(fight)
  metrics.rounds = Math.max(metrics.rounds, Number(cp.contract.round))
  const fighters = snapshot(cp)
  const old = previous_fighters.get(fight)
  const changes = old ? fighters.flatMap((fighter) => {
    const before = old[fighter.seat]
    if (!before) return []
    const hp_delta = Number(fighter.hp) - Number(before.hp)
    const ap_delta = Number(fighter.ap) - Number(before.ap)
    const mp_delta = Number(fighter.mp) - Number(before.mp)
    const moved = fighter.cell !== before.cell
    const effects_changed = JSON.stringify(fighter.effects, json_safe) !== JSON.stringify(before.effects, json_safe)
    if (!hp_delta && !ap_delta && !mp_delta && !moved && !effects_changed && fighter.dead === before.dead) return []
    if (fighter.team === '0') {
      if (hp_delta < 0) metrics.received -= hp_delta
      else if (hp_delta > 0) metrics.healed += hp_delta
      metrics.ap_spent += Math.max(0, -ap_delta)
      metrics.mp_spent += Math.max(0, -mp_delta)
    } else if (hp_delta < 0) metrics.dealt -= hp_delta
    return [{ seat: fighter.seat, name: fighter.name, team: fighter.team, hp_delta, ap_delta, mp_delta, from: moved ? before.cell : undefined, to: moved ? fighter.cell : undefined, effects_changed, dead: fighter.dead && !before.dead }]
  }) : []
  previous_fighters.set(fight, fighters)
  append(fight, 'checkpoint', {
    round: String(cp.contract.round),
    turn_ptr: String(cp.contract.turn_ptr),
    turn_started_ms: String(cp.contract.turn_started_ms),
    ended: cp.contract.ended,
    fighters,
    changes,
  })
}

export const analytics_turn_submitted = (
  fight: string,
  cp: HydratedFightCheckpoint,
  seat: number,
  actions: readonly unknown[],
  digest: string
): void => {
  if (!config.combat_analytics) return
  const metrics = metrics_for(fight)
  metrics.turns += 1
  if (actions.length === 0) metrics.passes += 1
  for (const action of actions) {
    const row = action as unknown as Record<string, unknown>
    if (typeof row.spell === 'string') metrics.casts.set(row.spell, (metrics.casts.get(row.spell) ?? 0) + 1)
  }
  append(fight, 'turn_submitted', {
    seat,
    identity: `${cp.contract.round}:${cp.contract.turn_ptr}:${cp.contract.turn_started_ms}`,
    before: snapshot(cp)[seat] ?? null,
    actions,
    digest,
    passed: actions.length === 0,
  })
}

export const analytics_turn_planned = (
  fight: string,
  cp: HydratedFightCheckpoint,
  seat: number,
  actions: readonly unknown[],
  analysis: unknown
): void => {
  append(fight, 'turn_planned', {
    seat,
    identity: `${cp.contract.round}:${cp.contract.turn_ptr}:${cp.contract.turn_started_ms}`,
    actions,
    analysis,
  })
}

export const analytics_turn_rejected = (
  fight: string,
  cp: HydratedFightCheckpoint,
  seat: number,
  actions: readonly unknown[],
  error: unknown,
  fallback_actions?: readonly unknown[]
): void => {
  append(fight, 'turn_rejected', {
    seat,
    identity: `${cp.contract.round}:${cp.contract.turn_ptr}:${cp.contract.turn_started_ms}`,
    actions,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    ...(fallback_actions ? { fallback_actions } : {}),
  })
}

export const analytics_fight_ended = (fight: string, winner: number | null): void => {
  if (!config.combat_analytics) return
  append(fight, 'fight_ended', { winner })
  previous_fighters.delete(fight)
  const metrics = live_metrics.get(fight)
  live_metrics.delete(fight)
  if (!metrics) return
  const spells = [...metrics.casts].sort((left, right) => right[1] - left[1]).slice(0, 3)
  const spell_summary = spells.length ? spells.map(([name, count]) => `${name} ×${count}`).join(', ') : 'aucun'
  const result = winner === 0 ? 'victoire' : winner === null ? 'résultat inconnu' : 'défaite'
  const summary = `${result} · ${metrics.rounds} rounds · ${metrics.turns} tours (${metrics.passes} passes) · dégâts ${metrics.dealt} · dégâts reçus ${metrics.received} · soins ${metrics.healed} · PA/PM consommés ${metrics.ap_spent}/${metrics.mp_spent} · sorts ${spell_summary}`
  log_info('analytics', `fight ${fight}: ${summary}`)
  notify(`📊 AresRPGAuto — combat ${fight}\n${summary}`, 'info')
}
