# Keeps the dashboard server alive. Task Scheduler's own "restart on failure"
# does not reliably fire for a logon-triggered task (verified: killing the
# server left it dead for 75+ seconds with the task back in "Ready" state) —
# so this polls the port itself and relaunches whenever nothing answers.
$appDir = Split-Path -Parent $PSScriptRoot
$port = 4175
$node = (Get-Command node -ErrorAction Stop).Source

while ($true) {
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) {
        Start-Process -FilePath $node -ArgumentList "src\server.js" -WorkingDirectory $appDir -WindowStyle Hidden
    }
    Start-Sleep -Seconds 15
}
