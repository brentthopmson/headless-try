# Local Servers and Cloudflare Tunnels

## Launch order

When asked to launch or restart the full local setup:

1. Start OpenCode on `127.0.0.1:4096` with its configured server password.
2. Start its Cloudflare Quick Tunnel and a separate tunnel for the production app on port `3001`.
3. Build and start the production app in **silent mode** (the current default).
4. Sync the OpenCode URL to `SETTINGS.aiBaseUrl` and the app URL to the `links` row selected by `SERVERLESS_ID`.
5. Leave Ollama running and preserve its authenticated tunnel; verify all active public endpoints.

The Ollama service is expected to run continuously; it normally does not need to be restarted. Confirm that the auth proxy is available before starting its tunnel. Read the proxy's current configuration to determine its local port rather than assuming one.

## Integrated silent launcher

After pulling changes, launch the configured OpenCode service, its tunnel, the production app, the app tunnel, and the Google Sheets URL sync with:

```powershell
.\run-silent.ps1
```

The launcher uses `opencode-ai` and `cloudflared` from `PATH`, builds before starting the production app, and writes process output to local log files. It replaces only listeners/tunnels it recognizes on ports `3001` and `4096`; it must not terminate the Ollama proxy tunnel on port `11435`. It also syncs the configured OpenCode password to `SETTINGS.aiKey`, so that sheet cell must be access-controlled as a secret.

For the same launch with visible browser behavior and normal production logging, use:

```powershell
.\run-visible.ps1
```

The visible launcher follows the same managed-process and tunnel rules, syncs URLs before starting the foreground app, and leaves Ollama's tunnel untouched. It also syncs the configured OpenCode password to `SETTINGS.aiKey`.

## Starting the app

Run these commands from the repository root in PowerShell. On this Windows setup, add Node.js to `PATH` first:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
```

### Production (current default; silent)

Build after pulling changes, then start production on port `3001`:

```powershell
npm.cmd run build
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm.cmd run start:silent -- --port 3001
```

`start:silent` sets production mode, logs only errors, and disables Node warning output. It still prints startup output and errors; it is not a guarantee of zero output. When launching as a hidden background process, pass the same environment variables to that process and capture stdout/stderr in local log files.

### Production (normal logging)

After building, use this when startup and informational logs are needed:

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm.cmd run start -- --port 3001
```

### Development (normal logging)

Use for local development with hot reload; this does not require a production build:

```powershell
npm.cmd run dev -- --port 3001
```

### Development (silent)

Use the development server while reducing logs to errors:

```powershell
npm.cmd run dev:silent -- --port 3001
```

Stop an existing listener on port `3001` before starting another instance. For server-only requests, do not restart either Cloudflare tunnel.

## Restart scope

- **Full setup:** restart the app and both tunnels; do not restart Ollama unless explicitly requested or it is not running.
- **App/server only:** restart the app on port `3001`; leave both Cloudflare tunnels and Ollama alone.
- **Tunnel only:** restart only the requested tunnel(s); leave the app and Ollama alone unless a tunnel's origin is unavailable.

## URLs and verification

Cloudflare Quick Tunnel URLs are temporary and can change whenever a tunnel is recreated. Do not rely on a previously reported URL as current: capture each URL from the newly started tunnel and verify it before sharing it.

For the Ollama endpoint, requests must include a bearer authorization header using the locally stored token. An unauthenticated `401 Unauthorized` response is expected and confirms the auth proxy is enforcing authentication; verify authenticated access without printing or exposing the token.

Last reported Ollama tunnel URL (historical; verify before use):

`https://yields-supreme-filme-rated.trycloudflare.com`

## Local secret handling

- The Ollama bearer token is stored locally at `C:\ollama\bin\ollama-access-token.txt`.
- The auth proxy script is `C:\ollama\bin\ollama-auth-proxy.mjs`.
- Never put the token in this document, command output, chat messages, source control, or a public URL report.
- Keep credentials in the existing local secret file and use them only when verifying authenticated access.

## Most recently verified app endpoint

The production app on `http://localhost:3001` was last verified with HTTP `200` after a restart on 2026-10-31. This is historical status, not a guarantee that the server is currently running.
