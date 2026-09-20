import { describe, expect, test } from 'bun:test'

import { read_snapshots } from '../src/market/kiosk_inventory.ts'
import { read_kiosk_listings } from '../src/market/kiosk_listings.ts'

describe('read_snapshots', () => {
    const type_package = '0x123pkg'

    test('parses item JSON snapshots in batch without dynamic field lookups', async () => {
        const mock_client = {
            core: {
                getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
                    objects: objectIds.map((id) => ({
                        objectId: id,
                        type: `${type_package}::item::Item`,
                        json: {
                            name: `Item ${id}`,
                            item_type: `res_${id}`,
                            category: 'resource',
                            level: 5,
                        },
                    })),
                }),
            },
        }

        const snapshots = await read_snapshots(mock_client as never, type_package, ['0x1', '0x2'])
        expect(snapshots).toHaveLength(2)
        expect(snapshots[0]).toEqual({
            id: '0x1',
            name: 'Item 0x1',
            item_type: 'res_0x1',
            category: 'resource',
            level: 5,
        })
        expect(snapshots[1]).toEqual({
            id: '0x2',
            name: 'Item 0x2',
            item_type: 'res_0x2',
            category: 'resource',
            level: 5,
        })
    })

    test('re-throws transient RPC errors (429 / Too Many Requests) instead of swallowing them', async () => {
        const mock_client = {
            core: {
                getObjects: async () => ({
                    objects: [new Error('RpcError: Too Many Requests')],
                }),
            },
        }

        await expect(read_snapshots(mock_client as never, type_package, ['0x1'])).rejects.toThrow(
            'RpcError: Too Many Requests'
        )
    })

    test('resolves unreadable non-transient items as null', async () => {
        const mock_client = {
            core: {
                getObjects: async () => ({
                    objects: [new Error('Object not found')],
                }),
            },
        }

        const snapshots = await read_snapshots(mock_client as never, type_package, ['0x1'])
        expect(snapshots).toEqual([null])
    })
})

describe('read_kiosk_listings', () => {
    test('batches listing getObjects calls into a single request and returns map', async () => {
        let get_objects_call_count = 0
        const mock_sdk = {
            sui_client: {
                core: {
                    listDynamicFields: async () => ({
                        dynamicFields: [
                            { fieldId: '0xf1', name: { type: '0x2::kiosk::Listing' } },
                            { fieldId: '0xf2', name: { type: '0x2::kiosk::Listing' } },
                        ],
                        hasNextPage: false,
                        cursor: null,
                    }),
                    getObjects: async ({ objectIds }: { objectIds: string[] }) => {
                        get_objects_call_count += 1
                        expect(objectIds).toEqual(['0xf1', '0xf2'])
                        return {
                            objects: [
                                { json: { name: { id: 'item_a' }, value: '1000000000' } },
                                { json: { name: { id: 'item_b' }, value: '2000000000' } },
                            ],
                        }
                    },
                },
            },
        }

        const listings = await read_kiosk_listings(mock_sdk as never, '0xkiosk1')
        expect(get_objects_call_count).toBe(1)
        expect(listings.get('item_a')).toBe(1000000000n)
        expect(listings.get('item_b')).toBe(2000000000n)
    })

    test('walks every dynamic-field page so listed items are not treated as unlisted', async () => {
        const pages = [
            {
                dynamicFields: [{ fieldId: '0xf1', name: { type: '0x2::kiosk::Listing' } }],
                hasNextPage: true,
                cursor: 'page-2',
            },
            {
                dynamicFields: [{ fieldId: '0xf2', name: { type: '0x2::kiosk::Listing' } }],
                hasNextPage: false,
                cursor: null,
            },
        ]
        let page = 0
        const mock_sdk = {
            sui_client: {
                core: {
                    listDynamicFields: async ({ cursor }: { cursor?: string | null }) => {
                        if (page === 1) expect(cursor).toBe('page-2')
                        return pages[page++]!
                    },
                    getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
                        objects: objectIds.map((id) => ({
                            json: { name: { id: id === '0xf1' ? 'item_a' : 'item_b' }, value: '1' },
                        })),
                    }),
                },
            },
        }

        const listings = await read_kiosk_listings(mock_sdk as never, '0xkiosk1')
        expect(page).toBe(2)
        expect(listings.get('item_a')).toBe(1n)
        expect(listings.get('item_b')).toBe(1n)
    })

    test('re-throws transient rate limit error in kiosk listings', async () => {
        const mock_sdk = {
            sui_client: {
                core: {
                    listDynamicFields: async () => ({
                        dynamicFields: [{ fieldId: '0xf1', name: { type: '0x2::kiosk::Listing' } }],
                        hasNextPage: false,
                        cursor: null,
                    }),
                    getObjects: async () => ({
                        objects: [new Error('Code: RESOURCE_EXHAUSTED Method: sui.rpc.v2.LedgerService/BatchGetObjects')],
                    }),
                },
            },
        }

        await expect(read_kiosk_listings(mock_sdk as never, '0xkiosk1')).rejects.toThrow('RESOURCE_EXHAUSTED')
    })
})
