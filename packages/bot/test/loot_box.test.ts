import { describe, expect, it } from 'bun:test'

import { resource_bag_reward } from '../src/actions/loot_box.ts'

describe('resource protector bags', () => {
  it('recognises the guaranteed 50-resource bags', () => {
    expect(resource_bag_reward('bag_green_mushroom')).toEqual({ item_type: 'green_mushroom', amount: 50 })
    expect(resource_bag_reward('bag_quartz')).toEqual({ item_type: 'quartz', amount: 50 })
    expect(resource_bag_reward('bag_wheat')).toEqual({ item_type: 'wheat', amount: 50 })
  })

  it('rejects ordinary items and non-resource loot boxes', () => {
    expect(resource_bag_reward('green_mushroom')).toBeNull()
    expect(resource_bag_reward('sui_crate')).toBeNull()
    expect(resource_bag_reward('not_an_item')).toBeNull()
  })
})
