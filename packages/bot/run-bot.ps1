# run-bot.ps1 - launch the AresRPG bot DETACHED from the calling shell.
#
# The bot is a long-running process. Launching it in the foreground of an agent/terminal session
# ties its lifetime to that session: when the session ends the child is killed, which is exactly
# how an overnight run silently stopped. Start-Process detaches the bot so it keeps farming.
#
#   powershell -ExecutionPolicy Bypass -File run-bot.ps1
#
# Output is captured to .state/bot.out.log and .state/bot.err.log; the pid is written to
# .state/bot.pid. Discord gets a startup message; progress arrives as a periodic digest.
param(
  # Skip killing an already-running bot instance.
  [switch]$NoKill
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# 1. Stop any existing bot instance (match only our entrypoint, never unrelated bun processes).
if (-not $NoKill) {
  $targets = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'main.ts|run start' }
  foreach ($t in $targets) {
    Write-Host "stopping existing bot pid $($t.ProcessId)"
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}

# 2. Runtime environment (also present in .env; explicit here so the group loop is unambiguous).
$env:BOT_PARTY_SIZE = '4'
$env:BOT_GROUP = 'true'

# 3. Launch detached, capturing both streams to the state dir.
$stateDir = Join-Path $here '.state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$outLog = Join-Path $stateDir 'bot.out.log'
$errLog = Join-Path $stateDir 'bot.err.log'

$bun = (Get-Command bun -ErrorAction Stop).Source
$proc = Start-Process -FilePath $bun -ArgumentList 'run', 'start' -WorkingDirectory $here -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $stateDir 'bot.pid') -Value $proc.Id

Start-Sleep -Seconds 3
if ($proc.HasExited) {
  Write-Host "bot exited immediately (code $($proc.ExitCode)) - see $errLog"
  exit 1
}
Write-Host "bot started detached - pid $($proc.Id)"
Write-Host "  stdout: $outLog"
Write-Host "  stderr: $errLog"
