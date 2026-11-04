import { describe, expect, it } from 'bun:test'
import type { ItemRow } from '@aresrpg/protocol'

import {
  pet_food_gather_demand,
  pet_food_goals,
  pet_food_is_supplyable,
  unavailable_pet_foods,
} from '../src/actions/pet.ts'
import { initial_game_state, type GameState } from '../src/state/store.ts'

const item = (id: string, item_type: string, category: string, amount = 1): ItemRow => ({
  id,
  item_type,
  category,
  amount,
  name: item_type,
  level: 1,
  kiosk: '0xkiosk',
})

const state = (inventory: readonly ItemRow[]): GameState => ({ ...initial_game_state, inventory })

describe('pet maintenance planning', () => {
  it('requests one food reserve per unfinished pet and ignores fully fed pets', () => {
    const inventory = [
      { ...item('v', 'vaporeon', 'pet'), pet_power: 12 },
      { ...item('b1', 'suifren_bullshark', 'pet'), pet_power: 2 },
      { ...item('b2', 'suifren_bullshark', 'pet'), pet_power: 60 },
      item('food', 'abyssal_arcanite_pet_food', 'resource'),
    ]
    expect(pet_food_goals(state(inventory))).toEqual(['moonfire_pet_food'])
  })

  it('turns missing rare food ingredients into their harvestable resource demand', () => {
    const demand = pet_food_gather_demand(
      state([{ ...item('b1', 'suifren_bullshark', 'pet'), pet_power: 2 }])
    )
    expect(Object.fromEntries(demand)).toEqual({ wheat_burnt: 1, aloe_vera: 1, moonstone: 1 })
  })

  it('does not farm or craft food for a fully fed collection', () => {
    const finished = state([{ ...item('v', 'vaporeon', 'pet'), pet_power: 60 }])
    expect(pet_food_goals(finished)).toEqual([])
    expect([...pet_food_gather_demand(finished)]).toEqual([])
  })

  it('does not chase the Vaporeon recipe while its tier-8 resources exist in no world', () => {
    const vaporeon = state([{ ...item('v', 'vaporeon', 'pet'), pet_power: 12 }])
    expect(pet_food_is_supplyable(vaporeon, 'abyssal_arcanite_pet_food')).toBe(false)
    expect(pet_food_goals(vaporeon)).toEqual([])
    expect([...pet_food_gather_demand(vaporeon)]).toEqual([])
    expect(unavailable_pet_foods(vaporeon)).toEqual(['abyssal_arcanite_pet_food'])
  })

  it('can use legacy tier-8 rares already held even though their nodes are unavailable', () => {
    const inventory = [
      { ...item('v', 'vaporeon', 'pet'), pet_power: 12 },
      item('w', 'abyssal_blood_wheat', 'resource'),
      item('h', 'wither_petal', 'resource'),
      item('a', 'infinity_arcanite', 'resource'),
    ]
    const legacy = state(inventory)
    expect(pet_food_is_supplyable(legacy, 'abyssal_arcanite_pet_food')).toBe(true)
    expect(pet_food_goals(legacy)).toEqual(['abyssal_arcanite_pet_food'])
    expect(unavailable_pet_foods(legacy)).toEqual([])
  })

  it('classifies every currently unavailable pet-food tier', () => {
    const expected = [
      'abyssal_arcanite_pet_food',
      'cursed_diamond_pet_food',
      'phantom_obsidian_pet_food',
      'primordial_dragon_pet_food',
      'spectral_draconite_pet_food',
    ]
    const pet_types = ['vaporeon', 'corbac', 'mosho', 'yago', 'suicune']
    const collection = state(pet_types.map((type, index) => ({ ...item(`p${index}`, type, 'pet'), pet_power: 0 })))
    expect(unavailable_pet_foods(collection)).toEqual(expected)
  })
})
