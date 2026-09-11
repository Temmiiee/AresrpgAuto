// bun run src/cli_enoki_login.ts — READ-ONLY: signs in via zkLogin (interactive the first time,
// cached after), then lists every character in every owned kiosk so you can confirm the bot is
// looking at your real profile before it's ever allowed to touch it. Takes no chain action.
import { KioskClient } from '@mysten/kiosk'

import { get_enoki_signer } from '../auth/enoki_auth.ts'
import { create_bot_sdk } from '../auth/sdk_client.ts'

const main = async () => {
  const signer = await get_enoki_signer()
  const { sdk, address } = create_bot_sdk(signer)

  console.log(`\naddress: ${address}`)
  const balance = await sdk.read_sui_balance()
  console.log(`balance: ${balance} MIST`)

  const { kioskOwnerCaps } = await sdk.get_owned_kiosks(address)
  console.log(`\nowned kiosks: ${kioskOwnerCaps.length}`)

  const kiosk_client = new KioskClient({ client: sdk.sui_client as never, network: sdk.network })

  for (const cap of kioskOwnerCaps) {
    const { items } = await kiosk_client.getKiosk({ id: cap.kioskId })
    const characters = items.filter((item) => item.type.endsWith('::character::Character'))
    if (characters.length === 0) continue
    for (const character of characters) {
      const { objects } = await sdk.sui_client.core.getObjects({
        objectIds: [character.objectId],
        include: { json: true },
      })
      const json = objects[0]?.json as Record<string, unknown> | undefined
      console.log(
        `  ${character.objectId}  "${json?.name ?? '?'}"  classe=${json?.classe ?? '?'}  level=${json?.level ?? '?'}  kiosk=${cap.kioskId}`
      )
    }
  }
}

await main()
