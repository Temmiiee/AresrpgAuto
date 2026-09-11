import { KioskClient } from '@mysten/kiosk'
import { get_enoki_signer } from './src/auth/enoki_auth.ts'
import { create_bot_sdk } from './src/auth/sdk_client.ts'

const signer = await get_enoki_signer()
const bot = create_bot_sdk(signer)
const { sdk, address } = bot

const kiosk_client = new KioskClient({ client: sdk.sui_client as never, network: sdk.network as never })
const { kioskIds } = await kiosk_client.getOwnedKiosks({ address })
console.log('kioskIds:', kioskIds)

for (const kiosk_id of kioskIds) {
  const { items, kiosk } = await kiosk_client.getKiosk({ id: kiosk_id, options: { withObjects: true } as never })
  console.log(`\nkiosk ${kiosk_id} — itemCount field: ${(kiosk as unknown as { itemCount?: number })?.itemCount}, items.length: ${items.length}`)
  for (const item of items) {
    console.log(`  ${item.objectId}  type=${item.type}`)
  }
}
