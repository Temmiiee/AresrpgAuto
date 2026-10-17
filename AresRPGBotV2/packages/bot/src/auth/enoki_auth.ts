// Headless zkLogin sign-in — no browser wallet, no DOM. Uses the SAME public Enoki API key and
// Google OAuth client the real aresrpg.world client embeds, so the resulting zkLogin address is
// the player's real, existing address — not a new one.
//
// One-time interactive step: the flow needs a genuine Google login. We print a URL, you open it
// and sign in, and a tiny local page hands the result back to this process. After that the
// session is cached (gitignored) and every later run reuses it headlessly until it expires.
import { EnokiFlow } from '@mysten/enoki'
import type { Signer } from '@mysten/sui/cryptography'

import { config } from '../config.ts'
import { NETWORK } from '../shared/network_config.ts'
import { create_file_store } from './enoki_store.ts'

// Public client config, not secrets — this is the Enoki key the frontend build ships (see
// packages/frontend/.env.example). It is network-scoped; set ENOKI_API_KEY for a mainnet key.
const ENOKI_API_KEY = config.enoki_api_key ?? 'enoki_public_ff89078fe8efa82d3f14732264813b91'
const GOOGLE_CLIENT_ID =
  config.google_client_id ?? '263863163058-qn6qhkjmdvmlj8f1n4r0kdi4e608usbo.apps.googleusercontent.com'
const REDIRECT_URL = `http://localhost:${config.login_port}/enoki`
const LOGIN_TIMEOUT_MINUTES = Math.max(1, Math.round(config.login_timeout_ms / 60_000))

const CAPTURE_PAGE = `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
<p id="s">Signing you in…</p>
<script>
fetch('/enoki-capture', { method: 'POST', body: location.hash })
  .then(() => { document.getElementById('s').textContent = 'Signed in — you can close this tab.' })
  .catch(() => { document.getElementById('s').textContent = 'Something went wrong — check the bot terminal.' })
</script>
</body></html>`

/** Opens the local capture server, prints the login URL, and resolves with the raw URL hash
 *  Google redirects back with (contains the id_token). */
const capture_login_hash = (login_url: string, on_login_url_ready?: (url: string) => void): Promise<string> =>
  new Promise((resolve, reject) => {
    const server = Bun.serve({
      hostname: 'localhost',
      port: config.login_port,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/enoki' && request.method === 'GET')
          return new Response(CAPTURE_PAGE, { headers: { 'content-type': 'text/html' } })
        if (url.pathname === '/enoki-capture' && request.method === 'POST') {
          const hash = await request.text()
          setTimeout(() => void server.stop(), 50)
          resolve(hash)
          return new Response('ok')
        }
        return new Response('not found', { status: 404 })
      },
    })
    console.log('\nOpen this URL in your browser and sign in with the SAME Google account you use for aresrpg.world:\n')
    console.log(login_url)
    console.log(`\nWaiting for sign-in… (${LOGIN_TIMEOUT_MINUTES} minutes)\n`)
    on_login_url_ready?.(login_url)
    setTimeout(() => {
      void server.stop()
      reject(new Error(`Timed out waiting for sign-in (${LOGIN_TIMEOUT_MINUTES} minutes)`))
    }, config.login_timeout_ms)
  })

/** Returns a Signer usable directly as `SDK({ signer })` — the real zkLogin address. Reuses a
 *  cached session when possible; otherwise runs the interactive login. The optional callback
 *  receives the login URL so the caller can forward it (e.g. to Discord). */
export const get_enoki_signer = async (on_login_url_ready?: (url: string) => void): Promise<Signer> => {
  const flow = new EnokiFlow({ apiKey: ENOKI_API_KEY, store: create_file_store() })

  const existing = await flow.getSession()
  if (existing) {
    try {
      return await flow.getKeypair({ network: NETWORK })
    } catch (error) {
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
  const hash = await capture_login_hash(login_url, on_login_url_ready)
  await flow.handleAuthCallback(hash)
  const keypair = await flow.getKeypair({ network: NETWORK })
  console.log(`signed in as ${keypair.toSuiAddress()}`)
  return keypair
}

/** Read-only variant: returns the keypair ONLY when a usable session is already cached, never
 *  running the interactive login. Used by previews so they can show real state without blocking. */
export const try_get_cached_signer = async (): Promise<Signer | null> => {
  const flow = new EnokiFlow({ apiKey: ENOKI_API_KEY, store: create_file_store() })
  const existing = await flow.getSession()
  if (!existing) return null
  try {
    return await flow.getKeypair({ network: NETWORK })
  } catch {
    return null
  }
}
