# run-24h.ps1 — 24/7 launcher + auto-restart watchdog for the all-in-one roam bot.
#   .\run-24h.ps1        launch the roamer (unlimited expeditions) and restart it if it ever exits
#   .\run-24h.ps1 -Once  run exactly one roamer pass, then stop
#   Ctrl+C               stop everything and exit
param(
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Clear any stale transcript from an interrupted previous run so logging always starts clean.
try { Stop-Transcript | Out-Null } catch {}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun not found on PATH" }

# Refuse to double-launch: a second roamer over the same party would collide on custody.
$stray = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'cli_roam' }
if ($stray) {
  Write-Host "[run-24h] WARNING: a roamer is already running (PID $($stray.ProcessId -join ', ')). Refusing to start a second one."
  exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null

$restart_min = 5
$backoff = 15

while ($true) {
  $log = Join-Path (Join-Path $PSScriptRoot 'logs') ("roam-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
  $started = Get-Date
  Write-Host "`n[run-24h] starting roamer at $(Get-Date -Format 'HH:mm:ss') - log: $log"

  Start-Transcript -Path $log -Force | Out-Null
  $code = 0
  try {
    & bun run roam
    $code = $LASTEXITCODE
  } catch {
    $code = 1
    Write-Warning $_.Exception.Message
  } finally {
    try { Stop-Transcript | Out-Null } catch {}
  }

  $ran_min = [Math]::Round(((Get-Date) - $started).TotalMinutes, 1)
  Write-Host "[run-24h] roamer exited (exit $code) after $ran_min min"

  if ($Once) { Write-Host "[run-24h] -Once mode, stopping."; break }

  if ($ran_min -lt $restart_min) {
    $backoff = [Math]::Min($backoff * 2, 300)
    Write-Host "[run-24h] exited fast - possible crash. backing off $backoff s before restart"
  } else {
    $backoff = 15
    Write-Host "[run-24h] restarting in $backoff s"
  }
  Start-Sleep -Seconds $backoff
}