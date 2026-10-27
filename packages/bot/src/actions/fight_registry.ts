// The fight runtime registry: one @aresrpg/fight runtime per watched fight, replaced whole from
// the server's authoritative checkpoint stream (`packet/fight_state`). The runtime is used only as
// a NORMALIZER + read model — create_fight's normalize_checkpoint converts the wire's string/number
// fields to bigint exactly once, and its read helpers (spell/weapon target cells, path finding)
// consume the normalized contract. The bot never replays turn seeds: the server pushes a full
// checkpoint after every turn boundary (FightProjected -> push_state), so the streamed contract is
// always the truth to plan from.
//
// Alongside the runtimes it owns the committed-turn identity — `round:turn_ptr:turn_started_ms` —
// which is the double-commit guard: after we submit a turn there is a window before the next
// checkpoint arrives in which the stream still shows OUR turn, and committing again would burn gas
// on a rejected transaction. The identity changes on the next real turn, releasing the guard.
import type { Fight } from '@aresrpg/fight'

export type FightRuntimeStore = Readonly<{
  /** the normalized runtime for a fight, or null until its first checkpoint arrives */
  get: (fight_id: string) => Fight | null
  /** install the fresh normalized runtime for a fight (packet/fight_state) */
  set: (fight_id: string, runtime: Fight) => void
  /** stop tracking a fight (settled / ended and reconciled) */
  drop: (fight_id: string) => void
  /** true when place/ready was already submitted for this seat (double-submit guard while the
   *  checkpoint stream lags the accepted transaction). */
  placement_sent: (fight_id: string, seat: number, action: 'place' | 'ready') => boolean
  /** remember that a place/ready transaction was accepted for this seat */
  mark_placement_sent: (fight_id: string, seat: number, action: 'place' | 'ready') => void
  /** the turn identity this bot last committed for a fight, or null */
  committed_turn: (fight_id: string) => string | null
  /** record the turn identity just committed, to guard against a double submit */
  mark_committed: (fight_id: string, identity: string) => void
  /** true once this bot has already submitted this fight's settlement (guards against indexer lag
   *  re-offering an unsettled resolution after our own settle transaction landed) */
  settlement_done: (fight_id: string) => boolean
  /** record that this fight's settlement transaction landed */
  mark_settlement_done: (fight_id: string) => void
  /** Serialize every mutating submit for ONE fight. In a group fight the allied seats
   *  (leader + joiners) run their placement/ready/turn loops in parallel; without this lock two
   *  seats can pick the same start cell or double-submit a settlement in the same instant. */
  with_lock: <T>(fight_id: string, fn: () => Promise<T>) => Promise<T>
}>

export const create_fight_runtimes = (): FightRuntimeStore => {
  const runtimes = new Map<string, Fight>()
  const committed = new Map<string, string>()
  const settled = new Set<string>()
  // Per fight, per seat: which placement action (place / ready) was already accepted. The
  // checkpoint stream trails the transaction by a beat, so without this a seat re-submits `ready`
  // (or `place`) the very next pass and the chain aborts it (`combat::ready`, code 1706).
  const placement = new Map<string, Map<number, { placed: boolean; readied: boolean }>>()
  const note_placement = (fight_id: string, seat: number, action: 'place' | 'ready'): void => {
    let seats = placement.get(fight_id)
    if (!seats) {
      seats = new Map()
      placement.set(fight_id, seats)
    }
    const log = seats.get(seat) ?? { placed: false, readied: false }
    if (action === 'place') log.placed = true
    else log.readied = true
    seats.set(seat, log)
  }
  // The tail of each fight's submit queue: the next submit chains onto it, so only one mutating
  // transaction per fight is ever in flight.
  const tails = new Map<string, Promise<unknown>>()
  return Object.freeze({
    get: (fight_id) => runtimes.get(fight_id) ?? null,
    set: (fight_id, runtime) => {
      runtimes.set(fight_id, runtime)
    },
    drop: (fight_id) => {
      runtimes.delete(fight_id)
      committed.delete(fight_id)
      tails.delete(fight_id)
      placement.delete(fight_id)
    },
    placement_sent: (fight_id, seat, action) => {
      const log = placement.get(fight_id)?.get(seat)
      if (!log) return false
      return action === 'place' ? log.placed : log.readied
    },
    mark_placement_sent: (fight_id, seat, action) => {
      note_placement(fight_id, seat, action)
    },
    committed_turn: (fight_id) => committed.get(fight_id) ?? null,
    mark_committed: (fight_id, identity) => {
      committed.set(fight_id, identity)
    },
    settlement_done: (fight_id) => settled.has(fight_id),
    mark_settlement_done: (fight_id) => {
      settled.add(fight_id)
    },
    with_lock: <T>(fight_id: string, fn: () => Promise<T>): Promise<T> => {
      const previous = tails.get(fight_id) ?? Promise.resolve()
      // run the critical section whether the previous submit resolved or threw
      const run = previous.then(fn, fn)
      tails.set(
        fight_id,
        run.then(
          () => undefined,
          () => undefined
        )
      )
      return run
    },
  })
}
