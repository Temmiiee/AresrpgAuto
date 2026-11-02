// Resource-protector bags are deterministic loot boxes: every authored bag contains exactly one
// gatherable reward worth 50 units. Open and claim them while the party is idle so valuable harvest
// stock never sits trapped in consumables.
import type { ItemRow } from '@aresrpg/protocol'

import { gatherable_of, items_by_type } from '../content/catalog.ts'
import { log_info, log_warn } from '../shared/logger.ts'
import { select_character, unavailable_item_ids } from '../state/selectors.ts'
import { custody_of, type ActionContext } from './context.ts'

const BOX_BATCH_LIMIT = 50

export type ResourceBagReward = Readonly<{ item_type: string; amount: number }>

/** Return the guaranteed gatherable reward of a protector bag; reject ordinary/random loot boxes. */
export const resource_bag_reward = (item_type: string): ResourceBagReward | null => {
  const consumable = items_by_type[item_type]?.consumable
  if (consumable?.type !== 'loot_box' || consumable.rewards.length !== 1) return null
  const reward = consumable.rewards[0]!
  if (reward.weight !== 1 || reward.amount !== 50 || !gatherable_of(reward.item_type)) return null
  return Object.freeze({ item_type: reward.item_type, amount: reward.amount })
}

export type ResourceBagOutcome = Readonly<{
  opened: boolean
  bag_type?: string
  reward_type?: string
  boxes?: number
  amount?: number
}>

/** Open one available resource-bag stack and immediately redeem every durable claim. */
export const open_resource_bag_once = async (ctx: ActionContext): Promise<ResourceBagOutcome> => {
  const state = ctx.state()
  const character = select_character(state, ctx.character_id)
  if (!character || character.active_fight || character.custody === 'fight') return Object.freeze({ opened: false })
  const unavailable = unavailable_item_ids(state)
  const candidates = state.inventory
    .flatMap((item) => {
      if (unavailable.has(item.id)) return []
      const reward = resource_bag_reward(item.item_type)
      return reward ? [{ item, reward }] : []
    })
    .sort((left, right) => Number(right.item.amount) - Number(left.item.amount))
  const selected = candidates[0]
  if (!selected) return Object.freeze({ opened: false })

  const count = Math.min(BOX_BATCH_LIMIT, Number(selected.item.amount))
  if (!Number.isSafeInteger(count) || count < 1) return Object.freeze({ opened: false })
  const merge_sources: string[] = []
  let available = Number(selected.item.amount)
  for (const candidate of candidates) {
    if (candidate.item.id === selected.item.id || candidate.item.item_type !== selected.item.item_type) continue
    merge_sources.push(candidate.item.id)
    available += Number(candidate.item.amount)
    if (available >= count) break
  }

  try {
    const opened = await ctx.sdk.character.open_loot_boxes({
      box_item_id: selected.item.id,
      box_item_type: selected.item.item_type,
      count,
      merge_sources,
      custody: custody_of(character),
    })
    ctx.ledger.append({
      kind: 'resource_bag_open',
      digest: opened.digest,
      detail: { bag: selected.item.item_type, boxes: count, reward: selected.reward.item_type },
    })

    const existing = state.inventory
      .filter((item) => item.item_type === selected.reward.item_type && !unavailable.has(item.id))
      .sort((left, right) => Number(right.amount) - Number(left.amount))[0] as ItemRow | undefined
    const claims = opened.rolls.map((roll) => ({
      claim_id: roll.claim_id,
      rolled_item_type: selected.reward.item_type,
      existing: existing?.id ?? null,
    }))
    const claimed = await ctx.sdk.character.claim_loot_batch({ claims, custody: custody_of(character) })
    const amount = opened.rolls.reduce((total, roll) => total + roll.amount, 0)
    ctx.ledger.append({
      kind: 'resource_bag_claim',
      digest: claimed.digest,
      detail: { bag: selected.item.item_type, boxes: count, reward: selected.reward.item_type, amount },
    })
    log_info('loot_box', `opened ${selected.item.item_type} ×${count} -> ${selected.reward.item_type} ×${amount}`)
    return Object.freeze({
      opened: true,
      bag_type: selected.item.item_type,
      reward_type: selected.reward.item_type,
      boxes: count,
      amount,
    })
  } catch (error) {
    log_warn(
      'loot_box',
      `${selected.item.item_type}: ${error instanceof Error ? error.message : String(error)}`
    )
    return Object.freeze({ opened: false })
  }
}
