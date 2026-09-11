// Tracks each character's HP across separate fights (session or single-run), so the bot can
// wait for natural regen before walking back into another fight instead of going in near-death.
// progression.move regenerates at a flat 1 HP/second regardless of level — no on-chain read
// exists for "current regenerated HP" outside a fight (it's a dynamic field, and the only door
// that recomputes it is entering combat), so this is the bot's own best estimate: it captures
// hp-at-fight-end and the wall-clock moment, then projects forward next time.
import { fileURLToPath } from 'node:url'

import { create_local_json_store } from './local_store.ts'

const REGEN_PER_MS = 1 / 1_000 // progression.move REGEN_MS_PER_HP = 1_000

export type HpRecord = { hp: number; at_ms: number; max_hp: number }
export type HpState = Record<string, HpRecord> // character_id -> record

const store = create_local_json_store<HpState>(fileURLToPath(new URL('../../hp-state.local.json', import.meta.url)), {})

export const read_hp_state = store.read
export const write_hp_state = store.write

/** BASE_HP(50) + HP_PER_LEVEL(5)*level + vitality — progression.move's formula, minus the gear
 *  fold (unknown here, and these characters carry little to no vitality gear) — a small
 *  under-estimate of true max HP is the safe direction for an 80%-threshold gate. */
export const estimate_max_hp = (level: number, vitality: number): number => 50 + 5 * level + vitality

export const regenerated_hp = (record: HpRecord, now_ms: number): number =>
  Math.min(record.max_hp, record.hp + Math.floor((now_ms - record.at_ms) * REGEN_PER_MS))

/** Milliseconds until this record's projected HP reaches `target_fraction` of max — 0 if already there. */
export const ms_until_fraction = (record: HpRecord, target_fraction: number, now_ms: number): number => {
  const target = Math.ceil(record.max_hp * target_fraction)
  const current = regenerated_hp(record, now_ms)
  if (current >= target) return 0
  return (target - current) / REGEN_PER_MS
}
