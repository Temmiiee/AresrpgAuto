// Headless zkLogin sign-in — no browser wallet, no DOM. Uses the SAME public Enoki API key
// and Google OAuth client the real aresrpg.world client embeds (packages/frontend/.env.example),
// so the resulting zkLogin address is the player's real, existing address — not a new one.
//
// One-time interactive step: the flow needs a genuine Google login. We print a URL, you open
// it and sign in, and a tiny local page hands the result back to this process. After that the
// session (ephemeral keypair + ZK proof) is cached in .enoki-session.json (gitignored) and every
// later run just reuses it headlessly until it naturally expires (tied to Sui epochs).
import { EnokiFlow } from '@mysten/enoki'

import { create_file_store } from './enoki_store.ts'
import { ENOKI_API_KEY_OVERRIDE, NETWORK } from '../shared/network_config.ts'

// Both values are public client config, not secrets — see packages/frontend/.env.example. This
// specific key is a TESTNET-scoped Enoki key — an Enoki key is registered against a specific set
// of allowed networks, so it may simply be rejected once NETWORK=mainnet exists for real; set
// ENOKI_API_KEY to override with the real mainnet key when that's available.
const ENOKI_API_KEY = ENOKI_API_KEY_OVERRIDE ?? 'enoki_public_ff89078fe8efa82d3f14732264813b91'
const GOOGLE_CLIENT_ID = '263863163058-qn6qhkjmdvmlj8f1n4r0kdi4e608usbo.apps.googleusercontent.com'
// Matches the frontend's own dev redirect (`${window.location.origin}/enoki` with
// `bun run dev --host 127.0.0.1 --port 5173`) — the one non-production redirect URI that is
// actually registered with this Google OAuth client.
const REDIRECT_HOST = 'localhost'
const REDIRECT_PORT = 5173
const REDIRECT_URL = `http://${REDIRECT_HOST}:${REDIRECT_PORT}/enoki`

const CAPTURE_PAGE = `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
<p id="s">Signing you in…</p>
<script>
fetch('/enoki-capture', { method: 'POST', body: location.hash })
  .then(() => { document.getElementById('s').textContent = 'Signed in — you can close this tab.' })
  .catch(() => { document.getElementById('s').textContent = 'Something went wrong — check the bot terminal.' })
</script>
</body></html>`

/** Opens the local capture server, prints the login URL, and resolves with the raw URL hash
 *  Google redirects back with (contains the id_token). 
 *  If onLoginUrlReady callback is provided, calls it with the login URL for external handling (e.g. Discord). */
const capture_login_hash = (login_url: string, onLoginUrlReady?: (url: string) => void): Promise<string> =>
  new Promise((resolve, reject) => {
    const server = Bun.serve({
      hostname: REDIRECT_HOST,
      port: REDIRECT_PORT,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/enoki' && request.method === 'GET')
          return new Response(CAPTURE_PAGE, { headers: { 'content-type': 'text/html' } })
        if (url.pathname === '/enoki-capture' && request.method === 'POST') {
          const hash = await request.text()
          setTimeout(() => server.stop(), 50)
          resolve(hash)
          return new Response('ok')
        }
        return new Response('not found', { status: 404 })
      },
    })
    console.log('\nOpen this URL in your browser and sign in with the SAME Google account you use for aresrpg.world:\n')
    console.log(login_url)
    console.log('\nWaiting for sign-in…')
    
    // Call the callback if provided (for Discord notification)
    if (onLoginUrlReady) {
      onLoginUrlReady(login_url)
    }
    
    setTimeout(() => {
      server.stop()
      reject(new Error('Timed out waiting for sign-in (5 minutes)'))
    }, 300_000)
  })

/** Returns a Signer usable directly as `SDK({ signer })` — the real zkLogin address, not a
 *  throwaway one. Reuses a cached session when possible; otherwise runs the interactive login. 
 *  Optional callback receives the login URL for external handling (e.g. sending to Discord). */
export const get_enoki_signer = async (onLoginUrlReady?: (url: string) => void) => {
  const flow = new EnokiFlow({ apiKey: ENOKI_API_KEY, store: create_file_store() })

  const existing = await flow.getSession()
  if (existing) {
    try {
      return await flow.getKeypair({ network: NETWORK })
    } catch (error) {
      // stored session present but unusable (e.g. proof stale) — fall through to a fresh login
      console.error(
        `cached session unusable, signing in fresh: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const login_url = await flow.createAuthorizationURL({
    provider: 'google',
    clientId: GOOGLE_CLIENT_ID,
    redirectUrl: REDIRECT_URL,
    network: NETWORK,
  })
  const hash = await capture_login_hash(login_url, onLoginUrlReady)
  await flow.handleAuthCallback(hash) // returns the OAuth `state` param, not the address — unused
  const keypair = await flow.getKeypair({ network: NETWORK })
  console.log(`signed in as ${keypair.toSuiAddress()}`)
  return keypair
}
