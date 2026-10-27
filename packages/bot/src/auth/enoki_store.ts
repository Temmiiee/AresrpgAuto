// A file-backed SyncStore for @mysten/enoki's EnokiFlow. The real client uses browser
// localStorage; here a small JSON file plays the same role so a zkLogin session (ephemeral
// keypair + ZK proof) survives across separate `bun run` invocations.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SESSION_STORE_PATH = fileURLToPath(new URL('../../.enoki-session.json', import.meta.url))

const read_existing = (): Record<string, string> => {
  if (!existsSync(SESSION_STORE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(SESSION_STORE_PATH, 'utf8')) as Record<string, string>
  } catch (error) {
    console.error(
      `[enoki_store] ${SESSION_STORE_PATH} is unreadable, starting a fresh session: ${error instanceof Error ? error.message : String(error)}`
    )
    return {}
  }
}

export const create_file_store = () => {
  let data = read_existing()
  const persist = (): void => writeFileSync(SESSION_STORE_PATH, JSON.stringify(data), { mode: 0o600 })
  return {
    get: (key: string): string | null => data[key] ?? null,
    set: (key: string, value: string): void => {
      data = { ...data, [key]: value }
      persist()
    },
    delete: (key: string): void => {
      const { [key]: _removed, ...rest } = data
      data = rest
      persist()
    },
  }
}
