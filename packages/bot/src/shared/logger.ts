// A tiny timestamped logger. No log levels library: the bot is a headless daemon and stderr is
// its operator channel.
//
// Verbosity is controlled by environment variables (read here, like the legacy BOT_DEBUG flag):
//   BOT_LOG_LEVEL   silent | error | warn | info | debug | trace   (default: info)
//   BOT_LOG_SCOPES  per-scope override, e.g. "dungeon=debug,trace=trace,party=warn"
//   BOT_DEBUG       legacy flag, still means BOT_LOG_LEVEL=debug when BOT_LOG_LEVEL is unset
const stamp = (): string => new Date().toISOString().slice(11, 23)

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 } as const
export type LogLevel = keyof typeof LEVELS
type EmitLevel = Exclude<LogLevel, 'silent'>

/** A message, or a function building it: the function only runs when the level is enabled, so
 *  hot paths pay nothing for verbose diagnostics. */
export type LogMessage = string | (() => string)

const parse_level = (raw: string | undefined): LogLevel | null => {
  const value = raw?.trim().toLowerCase()
  return value && value in LEVELS ? (value as LogLevel) : null
}

const base_level: LogLevel =
  parse_level(process.env.BOT_LOG_LEVEL) ?? (process.env.BOT_DEBUG ? 'debug' : 'info')

const scope_levels = new Map<string, LogLevel>()
for (const entry of (process.env.BOT_LOG_SCOPES ?? '').split(',')) {
  const [scope, raw] = entry.split('=').map((part) => part.trim())
  const level = parse_level(raw)
  if (scope && level) scope_levels.set(scope, level)
}

export const log_enabled = (scope: string, level: EmitLevel): boolean =>
  LEVELS[level] <= LEVELS[scope_levels.get(scope) ?? base_level]

const text = (message: LogMessage): string => (typeof message === 'function' ? message() : message)

export const log_info = (scope: string, message: LogMessage): void => {
  if (log_enabled(scope, 'info')) console.log(`[${stamp()}] ${scope} · ${text(message)}`)
}

export const log_warn = (scope: string, message: LogMessage): void => {
  if (log_enabled(scope, 'warn')) console.warn(`[${stamp()}] ${scope} ! ${text(message)}`)
}

export const log_error = (scope: string, error: unknown): void => {
  if (!log_enabled(scope, 'error')) return
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[${stamp()}] ${scope} ✗ ${message}`)
}

/** Verbose diagnostics (BOT_LOG_LEVEL=debug, or the legacy BOT_DEBUG). Used to trace decision
 *  paths that would otherwise return silently (waiting turns, held projections, group holds). */
export const log_debug = (scope: string, message: LogMessage): void => {
  if (log_enabled(scope, 'debug')) console.log(`[${stamp()}] ${scope} · ${text(message)}`)
}

/** Very chatty step-by-step tracing (BOT_LOG_LEVEL=trace). */
export const log_trace = (scope: string, message: LogMessage): void => {
  if (log_enabled(scope, 'trace')) console.log(`[${stamp()}] ${scope} · ${text(message)}`)
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
