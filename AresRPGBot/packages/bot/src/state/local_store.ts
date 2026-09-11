// Shared file-backed JSON store for the bot's small local state files (position, HP, group
// state, spell memory, learned policy, market history, item price overrides, ...) — one
// read/write pair instead of every site re-deriving the same existsSync/readFileSync/
// JSON.parse/writeFileSync dance, and one place that decides what a corrupt file means: reset to
// the default, but always REPORTED (console.error), never a silent swallow (code-law L-D1).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const create_local_json_store = <T>(path: string, default_value: T) =>
  Object.freeze({
    read: (): T => {
      if (!existsSync(path)) return default_value
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as T
      } catch (error) {
        console.error(
          `[local_store] ${path} is unreadable, using default: ${error instanceof Error ? error.message : String(error)}`
        )
        return default_value
      }
    },
    write: (value: T): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
  })
