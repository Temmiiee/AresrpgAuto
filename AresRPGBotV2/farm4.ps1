# farm4.ps1 — launch the SINGLE bot process that drives the whole party.
#
# The realtime server seats exactly ONE WebSocket per signer address and tracks the whole roster
# on that connection (MAX_TRACKED_CHARACTERS = 6). Launching one process per character — as this
# script used to do — makes every new socket evict the previous one (REPLACED / ALREADY_CONNECTED),
# so only the last character ever played. Run ONE process: it drives up to BOT_PARTY_SIZE
# characters over one shared socket, stamping each packet with the right character_id.
#
# The same invariant applies to a SECOND copy of this script: two processes share one signer, so
# they evict each other's socket and both drive the same characters into stale-state aborts
# (combat EOutOfRange / craft EInputShort). This script therefore stops any already-running bot
# before launching, so re-running it is always a clean restart.
#
# Usage:  ./farm4.ps1            # defaults to 4 characters
#         ./farm4.ps1 -partySize 2
param([int]$partySize = 4)

Set-Location $PSScriptRoot

# One process only: stop any bot already running (matched by its bun command line, since
# Start-Process -WorkingDirectory does not put this repo path in the command line).
$running = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'src[\\/]main\.ts' -or $_.CommandLine -match 'run start' }
if ($running) {
  Write-Host "[farm4] stopping $($running.Count) already-running bot process(es) to keep ONE socket per signer..."
  foreach ($proc in $running) { taskkill /PID $proc.ProcessId /T /F 2>&1 | Out-Null }
  Start-Sleep -Seconds 2
}

$env:BOT_PARTY_SIZE = "$partySize"
bun run bot
