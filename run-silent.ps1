$env:Path = 'C:\Program Files\nodejs;' + $env:Path
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

# Auto-start opencode serve + cloudflared if installed (non-blocking)
try {
  if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Start-Process -FilePath "opencode" -ArgumentList "serve","--hostname","127.0.0.1","--port","4096" -WindowStyle Hidden -ErrorAction SilentlyContinue
  }
} catch { }

try {
  if (Get-Command cloudflared -ErrorAction SilentlyContinue) {
    Start-Process -FilePath "cloudflared" -ArgumentList "tunnel","--url","http://127.0.0.1:4096","--logfile","cloudflared.log","--loglevel","info" -WindowStyle Hidden -ErrorAction SilentlyContinue
  }
} catch { }

npm.cmd run prod:silent -- --port 3001
