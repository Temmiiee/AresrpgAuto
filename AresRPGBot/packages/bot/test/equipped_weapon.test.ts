import { describe, expect, test } from 'bun:test'

import { read_equipped_weapon, read_equipped_items } from '../src/fight/equipped_weapon.ts'

// The live EquipmentKey DF payload captured off mainnet 2026-09-16 for omori — the node's JSON
// decode of Field<EquipmentKey, VecMap<String, EquippedRecord>>. Kept verbatim so the parser
// never drifts from a payload it was actually built against (code-law L-D4), minus the noise.
const OMORI_LIVE = {
  json: {
    value: {
      contents: [
        { key: 'pet', value: { category: 'pet', damages: [], item: '0x937b4f90d2716948257adbc30655128d97ed2fb8bda1a11909a5c00c97df6b18' } },
        { key: 'hat', value: { category: 'hat', damages: [], item: '0x14eb88f6357e9f4c11dc5c1c91fd2ce6a3ca1c9649be0f7f47aa7fc7c7a32d75' } },
        { key: 'left_ring', value: { category: 'ring', damages: [], item: '0x3a8189e2cdc25e986ab102ebc454abcb81bb7375980924b9d89314d9476bc7bf' } },
        { key: 'tool', value: { category: 'tool_herbalist', damages: [], item: '0x1bdf82fcb0592dedfe58545eb383d6d155f0bcf365af30371f8099963d17ae98' } },
      ],
    },
  },
}

const CORE = (objects: unknown[]) => ({
  listDynamicFields: async () => ({ dynamicFields: [{ name: { type: '0x1::equipment::EquipmentKey' }, fieldId: '0xeq' }] }),
  getObjects: async () => ({ objects }),
})

const SDK = (core: unknown) => ({ sui_client: { core } })

const sdk = SDK(CORE([OMORI_LIVE])) as unknown as Parameters<typeof read_equipped_weapon>[0]

describe('read_equipped_weapon (L-D4 equipped-weapon read)', () => {
  test('the live omori payload has no weapon slot → honestly unarmed', async () => {
    expect(await read_equipped_weapon(sdk, '0xomori')).toBeNull()
  })

  test('a weapon slot resolves to a WeaponSource over the authored lines', async () => {
    const with_weapon = {
      json: {
        value: {
          contents: [
            ...OMORI_LIVE.json.value.contents,
            {
              key: 'weapon',
              value: {
                category: 'spear',
                damage: undefined,
                damages: [{ from: 12, to: 22, damage_type: 'physical', element: 'earth' }],
                item: '0x1234',
              },
            },
          ],
        },
      },
    }
    const local = SDK(CORE([with_weapon])) as unknown as Parameters<typeof read_equipped_weapon>[0]
    const weapon = await read_equipped_weapon(local, '0xchar')
    expect(weapon).toEqual({ category: 'spear', damages: [{ element: 'earth', from: 12n, to: 22n }] })
  })

  test('u16 damages may arrive as JSON strings — tolerated', async () => {
    const with_strings = {
      json: {
        value: {
          contents: [
            { key: 'weapon', value: { category: 'bow', damages: [{ from: '3', to: '8', damage_type: 'air', element: 'air' }] } },
          ],
        },
      },
    }
    const local = SDK(CORE([with_strings])) as unknown as Parameters<typeof read_equipped_weapon>[0]
    expect(await read_equipped_weapon(local, '0xchar')).toEqual({
      category: 'bow',
      damages: [{ element: 'air', from: 3n, to: 8n }],
    })
  })

  test('a mismatched or empty record falls back to null, never throws', async () => {
    const garbage = { json: { value: { contents: [{ key: 'weapon', value: { category: 12, damages: 'no' } }] } } }
    const bad = { json: { value: { contents: [{ key: 'weapon', value: { category: 'axe', damages: [{ from: 1, to: 2 }] } }] } } }
    const a = SDK(CORE([garbage])) as unknown as Parameters<typeof read_equipped_weapon>[0]
    const b = SDK(CORE([bad])) as unknown as Parameters<typeof read_equipped_weapon>[0]
    expect(await read_equipped_weapon(a, '0xchar')).toBeNull()
    expect(await read_equipped_weapon(b, '0xchar')).toBeNull()
  })
})

describe('read_equipped_items (L-D4 multi-slot read for slot upgrades)', () => {
  test('the live omori payload exposes every occupied slot with its receiving item id', async () => {
    const local = SDK(CORE([OMORI_LIVE])) as unknown as Parameters<typeof read_equipped_items>[0]
    expect(await read_equipped_items(local, '0xomori')).toEqual([
      { slot: 'pet', item_id: '0x937b4f90d2716948257adbc30655128d97ed2fb8bda1a11909a5c00c97df6b18' },
      { slot: 'hat', item_id: '0x14eb88f6357e9f4c11dc5c1c91fd2ce6a3ca1c9649be0f7f47aa7fc7c7a32d75' },
      { slot: 'left_ring', item_id: '0x3a8189e2cdc25e986ab102ebc454abcb81bb7375980924b9d89314d9476bc7bf' },
      { slot: 'tool', item_id: '0x1bdf82fcb0592dedfe58545eb383d6d155f0bcf365af30371f8099963d17ae98' },
    ])
  })

  test('a slot with no readable item id is dropped, a missing EquipmentKey yields empty', async () => {
    const partial = {
      json: { value: { contents: [{ key: 'weapon', value: { category: 'bow', damages: [] } }, { key: 'hat' }] } },
    }
    const local = SDK(CORE([partial])) as unknown as Parameters<typeof read_equipped_items>[0]
    expect(await read_equipped_items(local, '0xchar')).toEqual([])
    const empty = SDK(CORE([])) as unknown as Parameters<typeof read_equipped_items>[0]
    expect(await read_equipped_items(empty, '0xchar')).toEqual([])
  })

  test('an empty or garbage record never throws', async () => {
    const garbage = { json: { value: { contents: [{ key: 12, value: { item: 5 } }] } } }
    const local = SDK(CORE([garbage])) as unknown as Parameters<typeof read_equipped_items>[0]
    expect(await read_equipped_items(local, '0xchar')).toEqual([])
  })
})