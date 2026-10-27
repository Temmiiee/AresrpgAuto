// A tiny timestamped logger. No log levels library: the bot is a headless daemon and stderr is
// its operator channel.
const stamp = (): string => new Date().toISOString().slice(11, 23)

export const log_info = (scope: string, message: string): void => {
  console.log(`[${stamp()}] ${scope} · ${message}`)
}

export const log_warn = (scope: string, message: string): void => {
  console.warn(`[${stamp()}] ${scope} ! ${message}`)
}

export const log_error = (scope: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[${stamp()}] ${scope} ✗ ${message}`)
}

/** Verbose diagnostics, off unless BOT_DEBUG is set. Used to trace decision paths that would
 *  otherwise return silently (waiting turns, held projections, group holds). */
export const log_debug = (scope: string, message: string): void => {
  if (process.env.BOT_DEBUG) console.log(`[${stamp()}] ${scope} · ${message}`)
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
