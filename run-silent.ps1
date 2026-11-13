$ErrorActionPreference = 'Stop'

$env:Path = 'C:\Program Files\nodejs;C:\Program Files (x86)\cloudflared;' + (Join-Path $env:APPDATA 'npm') + ';' + $env:Path
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $key = $matches[1].Trim()
      $value = $matches[2].Trim()
      if ($key -and $value) {
        Set-Item -Path "env:$key" -Value $value
      }
    }
  }
}

foreach ($name in 'SCRIPT_URL', 'SCRIPT_KEY', 'OPENCODE_SERVER_PASSWORD') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
    throw "Required environment variable $name is missing from .env."
  }
}

$npm = 'C:\Program Files\nodejs\npm.cmd'
$node = 'C:\Program Files\nodejs\node.exe'
$cloudflared = Get-Command cloudflared.exe -ErrorAction Stop
$opencode = Get-Command opencode.cmd -ErrorAction SilentlyContinue

if (-not $opencode) {
  Write-Host '[launcher] Installing OpenCode CLI...'
  & $npm install --global --allow-scripts=opencode-ai opencode-ai
  if ($LASTEXITCODE -ne 0) {
    throw "OpenCode installation failed with exit code $LASTEXITCODE."
  }
  $opencode = Get-Command opencode.cmd -ErrorAction SilentlyContinue
}
if (-not $opencode) {
  throw 'OpenCode CLI is not available as opencode.cmd after installation.'
}

function Test-LocalPort([int]$port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(1000)) {
      return $false
    }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Stop-ExpectedListener([int]$port, [string]$expectedCommand) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($processId in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if (-not $process -or $process.CommandLine -notmatch $expectedCommand) {
      throw "Refusing to stop unexpected process PID $processId on port $port."
    }
    Write-Host "[launcher] Stopping existing managed listener on port $port (PID: $processId)"
    Stop-Process -Id $processId -Force
  }
}

Write-Host '[launcher] Checking managed listeners...'
Stop-ExpectedListener 3001 'next.*--port"?\s+"?3001"?'
Stop-ExpectedListener 4096 'opencode.*serve'

$managedTunnels = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq 'cloudflared.exe' -and
    $_.CommandLine -match 'tunnel' -and
    $_.CommandLine -match 'http://127\.0\.0\.1:(3001|4096)(?:\s|$)'
  }
foreach ($process in $managedTunnels) {
  Write-Host "[launcher] Restarting managed tunnel (PID: $($process.ProcessId)); preserving unrelated tunnels."
  Stop-Process -Id $process.ProcessId -Force
}
Start-Sleep -Seconds 1

$opencodeOutLog = Join-Path $PSScriptRoot 'opencode-serve.out.log'
$opencodeErrLog = Join-Path $PSScriptRoot 'opencode-serve.err.log'
$opencodeTunnelLog = Join-Path $PSScriptRoot 'cloudflared.log'
$serverTunnelLog = Join-Path $PSScriptRoot 'serverless-cloudflared.log'
$serverOutLog = Join-Path $PSScriptRoot 'server-silent.out.log'
$serverErrLog = Join-Path $PSScriptRoot 'server-silent.err.log'

Write-Host '[launcher] Starting OpenCode serve on port 4096...'
Remove-Item -Force $opencodeOutLog, $opencodeErrLog -ErrorAction SilentlyContinue
$opencodeProcess = Start-Process -FilePath $opencode.Source `
  -ArgumentList @('serve', '--hostname', '127.0.0.1', '--port', '4096') `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
  -RedirectStandardOutput $opencodeOutLog -RedirectStandardError $opencodeErrLog -PassThru

$deadline = (Get-Date).AddSeconds(45)
while (-not (Test-LocalPort 4096) -and (Get-Date) -lt $deadline) {
  if ($opencodeProcess.HasExited) {
    throw "OpenCode exited during startup. Check $opencodeErrLog."
  }
  Start-Sleep -Seconds 1
}
if (-not (Test-LocalPort 4096)) {
  throw "OpenCode did not start listening on port 4096. Check $opencodeErrLog."
}

Write-Host '[launcher] Starting Cloudflare Quick Tunnels...'
Remove-Item -Force $opencodeTunnelLog, $serverTunnelLog -ErrorAction SilentlyContinue
Start-Process -FilePath $cloudflared.Source `
  -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:4096', '--logfile', $opencodeTunnelLog, '--loglevel', 'info') `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
Start-Process -FilePath $cloudflared.Source `
  -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:3001', '--logfile', $serverTunnelLog, '--loglevel', 'info') `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null

Write-Host '[launcher] Building production app...'
Push-Location $PSScriptRoot
try {
  & $npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "Production build failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

Write-Host '[launcher] Starting silent production app on port 3001...'
Remove-Item -Force $serverOutLog, $serverErrLog -ErrorAction SilentlyContinue
$serverProcess = Start-Process -FilePath $npm `
  -ArgumentList @('run', 'start:silent', '--', '--port', '3001') `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
  -RedirectStandardOutput $serverOutLog -RedirectStandardError $serverErrLog -PassThru

$deadline = (Get-Date).AddSeconds(90)
while (-not (Test-LocalPort 3001) -and (Get-Date) -lt $deadline) {
  if ($serverProcess.HasExited) {
    throw "Production server exited during startup. Check $serverErrLog."
  }
  Start-Sleep -Seconds 1
}
if (-not (Test-LocalPort 3001)) {
  throw "Production server did not start listening on port 3001. Check $serverErrLog."
}

Write-Host '[launcher] Syncing OpenCode and server URLs to Google Sheets...'
Push-Location $PSScriptRoot
try {
  & $node 'sync-tunnels.js'
  if ($LASTEXITCODE -ne 0) {
    throw "Tunnel URL sync failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

Write-Host '[launcher] Starting tunnel healer background process...'
$healerLog = Join-Path $PSScriptRoot 'tunnel-healer.out.log'
$healerErrLog = Join-Path $PSScriptRoot 'tunnel-healer.err.log'
Remove-Item -Force $healerLog, $healerErrLog -ErrorAction SilentlyContinue
$healerProcess = Start-Process -FilePath $node `
  -ArgumentList @('tunnel-healer.js') `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
  -RedirectStandardOutput $healerLog -RedirectStandardError $healerErrLog -PassThru

Write-Host "[launcher] Ready: OpenCode PID $($opencodeProcess.Id), server PID $($serverProcess.Id), healer PID $($healerProcess.Id)."
