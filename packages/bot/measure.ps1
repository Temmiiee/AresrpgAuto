# measure.ps1 — one-shot throughput readout from the activity ledger + run log.
# Usage: powershell -ExecutionPolicy Bypass -File .state\measure.ps1 [minutes]
param([int]$Minutes = 60)

$ErrorActionPreference = 'SilentlyContinue'
$led = '.state\activity.log'
if (-not (Test-Path $led)) { "no ledger at $led"; exit 0 }

$rows = Get-Content $led | ForEach-Object { $_ | ConvertFrom-Json }
$end = ($rows | Select-Object -Last 1).at_ms
if (-not $end) { $end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$start = $end - ($Minutes * 60000)
$win = $rows | Where-Object { $_.at_ms -ge $start }

$hours = $Minutes / 60.0
"=== ledger window: last $Minutes min ($($win.Count) entries) ==="
$win | Group-Object kind | Sort-Object Count -Descending | ForEach-Object { "{0,6}  {1}" -f $_.Count, $_.Name }

$eng = @($win | Where-Object { $_.kind -eq 'fight_engage' })
$set = @($win | Where-Object { $_.kind -eq 'fight_settle' })
$amb = @($win | Where-Object { $_.kind -eq 'ambush' })
""
"engages  : $($eng.Count)  ({0:N1}/h)" -f ($eng.Count / $hours)
"settles  : $($set.Count)"
"ambushes : $($amb.Count)"

""
"=== engages ==="
foreach ($o in $eng) {
  $t = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$o.at_ms).ToLocalTime().ToString('HH:mm:ss')
  "{0}  zone={1} group={2} n={3}" -f $t, $o.detail.zone, $o.detail.group, $o.detail.mobs.Count
}

""
"=== gathers by item ==="
$win | Where-Object { $_.kind -eq 'gather' } | Group-Object { $_.detail.item_type } | Sort-Object Count -Descending |
  ForEach-Object { "{0,6}  {1}" -f $_.Count, $_.Name }

""
"=== crafts by item ==="
$win | Where-Object { $_.kind -eq 'craft' } | Group-Object { $_.detail.item_type } | Sort-Object Count -Descending |
  ForEach-Object { "{0,6}  {1}" -f $_.Count, $_.Name }

""
"=== run-log signals ==="
$out = '.state\bot.out.log'
if (Test-Path $out) {
  foreach ($pat in @('staging group', 'engaged group', 'settled fight', 'roam .+holding', 'roam .+no winnable|no winnable group', 'rejoin|walking home', 'wrote off')) {
    $n = (Select-String -Path $out -Pattern $pat).Count
    "{0,5}  /{1}/" -f $n, $pat
  }
  ""
  "=== last 20 notable lines ==="
  Select-String -Path $out -Pattern 'staging group|engaged group|settled fight|holding|no winnable|walking home|wrote off|roamed|joined .* partner' |
    ForEach-Object { $_.Line } | Select-Object -Last 20
}
