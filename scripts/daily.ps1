# The daily run, from a home machine: the screener's trending ten, then the social read
# about exactly those ten, then the files to the server, then the API rebuilt there.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\daily.ps1
#
# Runs from Windows Task Scheduler once a day (see README, "Running it"). It has to be a
# home machine with a logged-in desktop: pull-chain.mjs reads DexScreener in a visible
# Chromium window, which a data-centre IP is refused. The social read needs no browser.
#
# Server details live in .deploy beside the repo (gitignored), one per line:
#   host=root@1.2.3.4
#   key=C:\Users\me\.ssh\id_ed25519
#   dir=/var/www/brain
# Everything is logged to .daily.log (gitignored). A failed step stops the run before the
# deploy, so the server never gets half a day.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$log = Join-Path $root ".daily.log"
function Log($m) { $line = "$(Get-Date -Format s) $m"; $line | Out-File -FilePath $log -Append -Encoding utf8; Write-Host $line }

$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"; $scp = "C:\Windows\System32\OpenSSH\scp.exe"

$deployFile = Join-Path $root ".deploy"
if (-not (Test-Path $deployFile)) { Log "no .deploy file - nothing deployed"; exit 1 }
$d = @{}; Get-Content $deployFile | ForEach-Object { if ($_ -match "^\s*(\w+)\s*=\s*(.+?)\s*$") { $d[$matches[1]] = $matches[2] } }
$sshOpts = @("-i", $d.key, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20")

function Step($name, $cmd) {
  Log "-- $name"
  & $cmd 2>&1 | ForEach-Object { $_ | Out-File -FilePath $log -Append -Encoding utf8 }
  if ($LASTEXITCODE -ne 0) { Log "!! $name failed ($LASTEXITCODE)"; exit 1 }
}

$env:CHAIN = "robinhood"
Log "== daily run start"
Step "pull-chain (DexScreener trending ten)" { & $node scripts\pull-chain.mjs }
Step "pull-daily (X about those ten)"       { & $node scripts\pull-daily.mjs }
Step "deploy data files" { & $scp @sshOpts chain-data.js daily-data.js "$($d.host):$($d.dir)/" }
Step "deploy avatars"    { & $scp -r @sshOpts avatars "$($d.host):$($d.dir)/" }
Step "rebuild on server" { & $ssh @sshOpts $d.host "chown -R www-data:www-data $($d.dir)/chain-data.js $($d.dir)/daily-data.js $($d.dir)/avatars && cd $($d.dir) && CHAIN=robinhood timeout 500 node scripts/read-chain.mjs >/dev/null 2>&1; CHAIN=robinhood node scripts/build-api.mjs" }

# The public repo carries the day's data files too, so anyone can recompute the page.
try {
  & git add chain-data.js daily-data.js avatars 2>&1 | Out-Null
  & git -c core.safecrlf=false commit -q -m "Daily read $(Get-Date -Format yyyy-MM-dd)" 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { & git push -q origin main 2>&1 | Out-Null; Log "-- committed and pushed" } else { Log "-- nothing new to commit" }
} catch { Log "-- git skipped: $($_.Exception.Message)" }

Log "== daily run done"
