# On-chain version gate (MoveAbort 601)

`version::assert_latest` abort 601 means the game deployment is rejecting writes from the package
version the bot currently calls. It can indicate either a deliberate server-side pause during an
upgrade or deployment pins that no longer match the live packages. It is distinct from a stale
object reference, so retrying the same transaction does not repair it.

The bot now latches a process-wide circuit breaker on the first classified 601, notifies once, and
stops all character loops from submitting further actions. The latch clears when the process exits.
Resolve the game deployment/pin mismatch first, then restart the bot. The bot does not guess new
package IDs or rewrite `pins.json` from an abort message.

During a gate pause, fights cannot progress or settle and gathering, crafting, travel checkpoint
searches, and equipment actions will also stop. The websocket and read-only previews can continue.
