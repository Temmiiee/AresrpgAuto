import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIR = fileURLToPath(new URL('../../logs/fights/', import.meta.url))

type Event = Readonly<{ type: string; payload?: Record<string, unknown> }>
type Totals = {
  fights: number
  wins: number
  losses: number
  unknown: number
  rounds: number
  turns: number
  passes: number
  dealt: number
  received: number
  healed: number
  ap_spent: number
  mp_spent: number
  casts: Map<string, number>
  actions: Map<string, number>
}

const empty = (): Totals => ({
  fights: 0, wins: 0, losses: 0, unknown: 0, rounds: 0, turns: 0, passes: 0,
  dealt: 0, received: 0, healed: 0, ap_spent: 0, mp_spent: 0, casts: new Map(), actions: new Map(),
})

const as_number = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const increment = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1)
}

const add_events = (totals: Totals, events: readonly Event[]): void => {
  totals.fights += 1
  for (const event of events) {
    const payload = event.payload ?? {}
    if (event.type === 'fight_ended') {
      const winner = payload.winner
      if (winner === 0 || winner === '0') totals.wins += 1
      else if (winner === null) totals.unknown += 1
      else totals.losses += 1
    }
    if (event.type === 'turn_submitted') {
      totals.turns += 1
      if (payload.passed === true) totals.passes += 1
      for (const action of Array.isArray(payload.actions) ? payload.actions : []) {
        if (!action || typeof action !== 'object') continue
        const row = action as Record<string, unknown>
        const kind = String(row.type ?? 'unknown')
        increment(totals.actions, kind)
        if (typeof row.spell === 'string') increment(totals.casts, row.spell)
      }
    }
    if (event.type === 'checkpoint') {
      totals.rounds = Math.max(totals.rounds, as_number(payload.round))
      for (const change of Array.isArray(payload.changes) ? payload.changes : []) {
        if (!change || typeof change !== 'object') continue
        const row = change as Record<string, unknown>
        const delta = as_number(row.hp_delta)
        if (row.team === '0') {
          if (delta < 0) totals.received -= delta
          else if (delta > 0) totals.healed += delta
          totals.ap_spent += Math.max(0, -as_number(row.ap_delta))
          totals.mp_spent += Math.max(0, -as_number(row.mp_delta))
        } else if (delta < 0) totals.dealt -= delta
      }
    }
  }
}

const sum_totals = (into: Totals, from: Totals): void => {
  for (const key of ['fights', 'wins', 'losses', 'unknown', 'rounds', 'turns', 'passes', 'dealt', 'received', 'healed', 'ap_spent', 'mp_spent'] as const)
    into[key] += from[key]
  for (const [key, value] of from.casts) into.casts.set(key, (into.casts.get(key) ?? 0) + value)
  for (const [key, value] of from.actions) into.actions.set(key, (into.actions.get(key) ?? 0) + value)
}

const top = (map: Map<string, number>): string => {
  const rows = [...map].sort((a, b) => b[1] - a[1]).slice(0, 5)
  return rows.length ? rows.map(([name, count]) => `${name} ×${count}`).join(', ') : 'aucun'
}

const report = (label: string, totals: Totals): string => {
  const concluded = totals.wins + totals.losses
  const win_rate = concluded ? `${Math.round((totals.wins / concluded) * 100)}%` : 'n/a'
  const average_rounds = totals.fights ? (totals.rounds / totals.fights).toFixed(1) : '0'
  const average_turns = totals.fights ? (totals.turns / totals.fights).toFixed(1) : '0'
  const lines = [
    `${label}: ${totals.fights} combat(s) · victoires ${totals.wins}/${concluded} (${win_rate}) · ${average_rounds} rounds/combat · ${average_turns} tours soumis/combat`,
    `  PV ennemis retirés: ${totals.dealt} · PV alliés perdus: ${totals.received} · soins: ${totals.healed}`,
    `  PA/PM consommés: ${totals.ap_spent}/${totals.mp_spent} · tours passés: ${totals.passes}`,
    `  actions: ${top(totals.actions)} · sorts: ${top(totals.casts)}`,
  ]
  if (totals.passes) lines.push(`  diagnostic: ${totals.passes} tour(s) sans action soumis; examiner positions, portée, PA/PM et états du checkpoint.`)
  if (totals.unknown) lines.push(`  ${totals.unknown} combat(s) sans résultat de fin enregistré.`)
  return lines.join('\n')
}

const fight_context = (events: readonly Event[]): readonly string[] => {
  const latest = [...events].reverse().find((event) => event.type === 'checkpoint')?.payload ?? {}
  const fighters = Array.isArray(latest.fighters) ? latest.fighters as Record<string, unknown>[] : []
  const allies = [...new Set(fighters
    .filter((fighter) => fighter.team === '0' && fighter.kind === 'player')
    .map((fighter) => `${String(fighter.name ?? '?')}${fighter.classe ? `/${String(fighter.classe)}` : ''}`))]
  const enemies = [...new Set(fighters
    .filter((fighter) => fighter.team !== '0' && fighter.kind === 'mob')
    .map((fighter) => String(fighter.mob_type ?? fighter.name ?? '?')))]
  const origin = events.find((event) => event.type === 'fight_origin')?.payload
  const rejected = events.filter((event) => event.type === 'turn_rejected')
  const aborts = new Map<string, number>()
  for (const event of rejected) {
    const error = event.payload?.error
    const text = typeof error === 'string' ? error : JSON.stringify(error ?? '')
    const code = /abort code:\s*(\d+)/i.exec(text)?.[1]
    if (code) increment(aborts, `MoveAbort ${code}`)
    else increment(aborts, 'autre erreur')
  }
  const reasons = new Map<string, number>()
  for (const event of events.filter((entry) => entry.type === 'turn_planned')) {
    const analysis = event.payload?.analysis as Record<string, unknown> | undefined
    const reason = analysis?.selected_reason
    if (typeof reason === 'string') increment(reasons, reason)
  }
  const lines: string[] = []
  if (allies.length) lines.push(`  équipe: ${allies.join(', ')}`)
  if (enemies.length) lines.push(`  ennemis: ${enemies.join(', ')}`)
  if (origin) {
    const details = ['kind', 'resource', 'protector', 'x', 'z']
      .flatMap((key) => origin[key] === undefined ? [] : [`${key}=${String(origin[key])}`])
    if (details.length) lines.push(`  origine: ${details.join(' · ')}`)
  }
  if (rejected.length) lines.push(`  soumissions refusées: ${rejected.length} (${top(aborts)})`)
  if (reasons.size) lines.push(`  motifs du planner: ${top(reasons)}`)
  return lines
}

const roster_classes = (events: readonly Event[]): string[] => {
  const checkpoint = [...events].reverse().find((event) => event.type === 'checkpoint')?.payload ?? {}
  const fighters = Array.isArray(checkpoint.fighters) ? checkpoint.fighters as Record<string, unknown>[] : []
  return [...new Set(fighters
    .filter((fighter) => fighter.team === '0' && fighter.kind === 'player')
    .map((fighter) => String(fighter.classe ?? 'classe inconnue')))].sort()
}

const learning_notes = (totals: Totals): readonly string[] => {
  const notes: string[] = []
  if (totals.turns > 0 && totals.passes / totals.turns >= 0.15)
    notes.push(`passes fréquentes (${Math.round(totals.passes / totals.turns * 100)}% des tours): vérifier les raisons du planner et les options légales dans les événements turn_planned`)
  if (totals.losses > 0)
    notes.push(`${totals.losses} défaite(s): comparer les compositions ennemies, les dégâts reçus et les dernières décisions avant les morts`)
  return notes
}

/** Read complete fight JSONL files and print combat and combined summaries. */
export const analyze_fights = async (directory = DEFAULT_DIR): Promise<void> => {
  let files: string[]
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.jsonl')).sort()
  } catch (error) {
    throw new Error(`Impossible de lire ${directory}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (files.length === 0) {
    console.log(`Aucun fichier de combat JSONL dans ${directory}. Active BOT_COMBAT_ANALYTICS=true puis relance le bot.`)
    return
  }

  const combined = empty()
  const by_opponents = new Map<string, Totals>()
  const by_classes = new Map<string, Totals>()
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8')
    const events = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Event]
      } catch {
        return []
      }
    })
    if (events.length === 0) continue
    const totals = empty()
    add_events(totals, events)
    sum_totals(combined, totals)
    console.log(report(basename(file, '.jsonl'), totals))
    for (const line of fight_context(events)) console.log(line)

    const latest = [...events].reverse().find((event) => event.type === 'checkpoint')?.payload ?? {}
    const fighters = Array.isArray(latest.fighters) ? latest.fighters as Record<string, unknown>[] : []
    const opponents = [...new Set(fighters
      .filter((fighter) => fighter.team !== '0' && fighter.kind === 'mob')
      .map((fighter) => String(fighter.mob_type ?? fighter.name ?? '?')))].sort()
    if (opponents.length) {
      const key = opponents.join(' + ')
      const profile = by_opponents.get(key) ?? empty()
      sum_totals(profile, totals)
      by_opponents.set(key, profile)
    }
    const classes = roster_classes(events)
    if (classes.length) {
      const key = classes.join(' + ')
      const profile = by_classes.get(key) ?? empty()
      sum_totals(profile, totals)
      by_classes.set(key, profile)
    }
  }
  if (combined.fights > 1) console.log(`\nTOTAL · ${report('', combined).trimStart()}`)
  if (by_opponents.size) {
    console.log('\nCOMPARAISON PAR COMPOSITION')
    for (const [composition, totals] of [...by_opponents].sort((left, right) => right[1].fights - left[1].fights))
      console.log(report(composition, totals))
  }
  if (by_classes.size) {
    console.log('\nCOMPARAISON PAR COMPOSITION DE CLASSES')
    for (const [composition, totals] of [...by_classes].sort((left, right) => right[1].fights - left[1].fights))
      console.log(report(composition, totals))
  }
  const notes = learning_notes(combined)
  if (notes.length) {
    console.log('\nPISTES À VÉRIFIER (statistiques descriptives, pas des changements automatiques)')
    for (const note of notes) console.log(`  ${note}`)
  }
}
