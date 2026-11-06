$env:Path = 'C:\Program Files\nodejs;C:\Program Files (x86)\cloudflared;' + $env:Path
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

# Load env vars from .env
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $key = $matches[1].Trim()
      $val = $matches[2].Trim()
      if ($key -and $val) {
        [Environment]::SetEnvironmentVariable($key, $val, "Process")
        Set-Item -Path "env:$key" -Value $val
      }
    }
  }
}

function Kill-Port([int]$port) {
  try {
    $output = cmd /c "netstat -ano | findstr :$port" 2>$null
    if ($output) {
      $pids = @()
      foreach ($line in $output) {
        if ($line -match '\s+(\d+)$') {
          $procId = $matches[1]
          if ($procId -ne '0' -and $pids -notcontains $procId) { $pids += $procId }
        }
      }
      foreach ($procId in $pids) {
        Write-Host "[launcher] Killing process on port $port (PID: $procId)"
        cmd /c "taskkill /PID $procId /F" 2>$null | Out-Null
      }
      if ($pids.Count -gt 0) { Start-Sleep -Seconds 2 }
    } else { Write-Host "[launcher] No process found on port $port" }
  } catch { Write-Host "[launcher] Error checking port ${port}: $($_.Exception.Message)" }
}

Write-Host "[launcher] Checking for processes on port 3001..."
Kill-Port 3001
Write-Host "[launcher] Checking for processes on port 4096..."
Kill-Port 4096

# Stop existing cloudflared tunnels started by this flow
try { Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 1

Write-Host "[launcher] Starting opencode serve..."
try {
  if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Remove-Item -Force "opencode-serve.log" -ErrorAction SilentlyContinue
    $pwd = $env:OPENCODE_SERVER_PASSWORD
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c","set OPENCODE_SERVER_PASSWORD=$pwd && opencode.cmd serve --hostname 127.0.0.1 --port 4096 > opencode-serve.log 2>&1" -WindowStyle Hidden -ErrorAction SilentlyContinue
    Write-Host "[launcher] opencode serve started (log: opencode-serve.log)"
  } else { Write-Host "[launcher] opencode not found - skipping" }
} catch { Write-Host "[launcher] opencode start failed: $($_.Exception.Message)" }

Write-Host "[launcher] Starting cloudflared tunnel for opencode (4096)..."
try {
  if (Get-Command cloudflared -ErrorAction SilentlyContinue) {
    Remove-Item -Force "cloudflared.log" -ErrorAction SilentlyContinue
    Start-Process -FilePath "cloudflared" -ArgumentList "tunnel","--url","http://127.0.0.1:4096","--logfile","cloudflared.log","--loglevel","info" -WindowStyle Hidden -ErrorAction SilentlyContinue
    Write-Host "[launcher] cloudflared (4096) started (log: cloudflared.log)"
  } else { Write-Host "[launcher] cloudflared not found - skipping" }
} catch { Write-Host "[launcher] cloudflared(4096) start failed: $($_.Exception.Message)" }

Write-Host "[launcher] Starting cloudflared tunnel for serverless app (3001)..."
try {
  if (Get-Command cloudflared -ErrorAction SilentlyContinue) {
    Remove-Item -Force "serverless-cloudflared.log" -ErrorAction SilentlyContinue
    Start-Process -FilePath "cloudflared" -ArgumentList "tunnel","--url","http://127.0.0.1:3001","--logfile","serverless-cloudflared.log","--loglevel","info" -WindowStyle Hidden -ErrorAction SilentlyContinue
    Write-Host "[launcher] cloudflared (3001) started (log: serverless-cloudflared.log, SERVERLESS_ID=$env:SERVERLESS_ID)"
  } else { Write-Host "[launcher] cloudflared not found - skipping serverless tunnel" }
} catch { Write-Host "[launcher] cloudflared(3001) start failed: $($_.Exception.Message)" }

Write-Host "[launcher] Building..."
npm.cmd run build
if ($LASTEXITCODE -ne 0) { Write-Host "[launcher] Build failed (exit $LASTEXITCODE) - continuing anyway" }

Write-Host "[launcher] Syncing tunnel URLs to Google Sheets (waiting)..."
node sync-tunnels.js

Write-Host "[launcher] Starting app on port 3001..."
npm.cmd run start:visible -- --port 3001
