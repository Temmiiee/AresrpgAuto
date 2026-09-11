// SPDX-License-Identifier: LicenseRef-AresRPG-Source-Available
// © 2026 Sceat — All rights reserved. See LICENSE.

export const readable_transaction_error = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/%([0-9a-f]{2})/gi, (encoded, hex: string) => {
    const byte = Number.parseInt(hex, 16)
    return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : encoded
  })
}

/** The SDK's executed-failure envelope. A digest means the transaction is terminal even when
 * its game effects rolled back; operational callers must journal it instead of retrying. */
export const executed_transaction_digest = (error: unknown): string | null =>
  readable_transaction_error(error).match(/^\[sdk\] transaction (\S+) failed on-chain:/)?.[1] ?? null

/** A receipt-fresh owned ref may reach one resolver before another. Only pre-submission failures
 * are retry candidates; a digest-bearing execution is terminal. Timing belongs to the caller. */
export const pre_submission_version_race = (error: unknown): boolean => {
  const message = readable_transaction_error(error)
  const stale_input =
    /provided version (?:doesn't|does not) match/i.test(message) ||
    /transaction needs to be rebuilt because object .* is unavailable for consumption, current version:/i.test(message)
  return !message.includes('failed on-chain') && message.includes('NOT submitted') && stale_input
}

export const pre_submission_stale_owned_ref = (error: unknown): boolean => {
  const message = readable_transaction_error(error)
  if (message.includes('failed on-chain')) return false
  const versions = message.match(
    /provided version (?:doesn't|does not) match[^]*?provided:\s*(\d+)\s+actual:\s*(0x[\da-f]+|\d+)/i
  )
  if (versions) return BigInt(versions[1]!) < BigInt(versions[2]!)
  // "unresolved object ... hydrate it first" (client.ts's resolve()) is the SAME class of
  // problem with no version numbers to compare: a locally-cached custody object (a kiosk's
  // PersonalKioskCap, most often) went stale because a PRECEDING transaction in this same
  // session advanced it without this resolver picking up the change -- confirmed live
  // 2026-09-05: fight.engage failed with this exact message immediately after a successful
  // zone-refresh transaction in the same run, then succeeded immediately when retried fresh
  // (a brand-new process, no stale cache, reproduced the identical call with no other change).
  // retry_stale_kiosk_ref already exists to force exactly that fresh refetch -- it just never
  // recognized this message shape as the retry-worthy case it is.
  return /unresolved object .* hydrate it first/i.test(message)
}

export const pre_submission_close_projection_lag = (error: unknown): boolean => {
  const message = readable_transaction_error(error)
  const close_guard = /::fight::close|::combat::assert_closable/i.test(message)
  return !message.includes('failed on-chain') && /abort code:\s*1712/i.test(message) && close_guard
}
