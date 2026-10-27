// Ambient shims so the vendored SDK sources compile without the DOM lib. The bot is a headless
// Bun daemon — there is no window, but the SDK's `browser_transaction_storage()` guards with
// `typeof window === 'undefined'`, and bun-types/SDK code references `window` at the type level
// only. Declaring it as `undefined`-union keeps that code type-safe: at runtime the guard always
// takes the `null` branch.
//
// The bot provides its own durable storage (see chain/storage.ts) rather than sessionStorage.
declare global {
  var window:
    | {
        readonly sessionStorage: {
          getItem(key: string): string | null
          setItem(key: string, value: string): void
          removeItem(key: string): void
        }
      }
    | undefined
}

export {}