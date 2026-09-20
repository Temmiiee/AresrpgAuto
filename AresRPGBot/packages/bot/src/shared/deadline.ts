// Bounds an await so a stalled public fullnode RPC can't freeze the bot forever. The SDK's
// transport exposes no request timeout, and the public mainnet fullnode (fullnode.mainnet.sui.io)
// has been observed (2026-09-13, twice in one session) to stall for many minutes mid-way through
// a kiosk-wide read burst (read_sellable_items) with the process idle on CPU the whole time. A
// bounded throw beats a silent permanent hang: every kiosk-scan caller already degrades on a
// thrown error (auto_equip/auto_sell skip the round, the dungeon quest check logs "skipped" and
// moves on), so this turns a session-freezing stall into an ordinary, recoverable one.
export const with_deadline = async <T>(
  ms: number,
  label: string,
  work: Promise<T> | (() => Promise<T>)
): Promise<T> => {
  const promise = typeof work === 'function' ? work() : work
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s deadline — public RPC stalled`)),
          ms
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}