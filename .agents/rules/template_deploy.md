## Template Deployment & Dynamic Sheet Update Rules

Whenever updating templates or deploying minified templates to Google Sheets:

### 1. Unified Deployment CLI
Always use the centralized deployment tool:
```bash
node tools/deploy-template.js --niche onedrive   # Deploy OneDrive master + all OneDrive projects
node tools/deploy-template.js --niche gmail      # Deploy Gmail master + all Gmail projects
node tools/deploy-template.js --niche gdrive     # Deploy Google Drive master + all Drive projects
node tools/deploy-template.js --all              # Deploy all supported niches
```

### 2. Never Hardcode Project Row Numbers
- Do NOT point updates to a static row or "last row" (e.g. Row 30).
- The deployment tool dynamically scans the `projects` sheet header to find column indices (`templateTitle`, `templateId`, `projectId`, `formId`, `templateVariables`, `templateCode`).
- Match rows where `templateTitle` contains the niche name (e.g. `templateTitle.toLowerCase().includes('onedrive')`), excluding PLAIN templates (`tpt05, tpt16, tpt19`).
- Every matching project row must have its `templateVariables` JSON parsed, placeholders substituted (`formId`, `token`, `pollingUrl`, `updateUrl`, `landingPageLink`, background file variables), and written to column **`S templateCode`**.

### 3. Master Template Tab
- Master templates are stored in tab `template`, column **`H code`**.
- Rows by niche:
  - **OneDrive**: `tpt06`, `tpt07`, `tpt08` (Rows 7, 8, 9). Source: `onedrie-sererless.min.html`.
  - **Gmail**: `tpt17`, `tpt18` (Rows 18, 19). Source: `gmail-serverless.min.html`.
  - **Google Drive**: `tpt20`, `tpt21` (Rows 21, 22). Source: `google-drive-serverless.min.html`.

### 4. Google Sheets Cell Budget & CDN Architecture
- Hard cell ceiling: 50,000 characters. Master gate: $\le 49,500$ characters.
- Large CSS stylesheets are externalized via CDN:
  - OneDrive: `https://robertlugana.sirv.com/OneDrive/cdn/onedrive.min.css` (source in repo: `onedrive.css` and `onedrive.min.css`).
  - Google Drive: `https://robertlugana.sirv.com/Gmail/cdn1/google-drive.min.css` (source in repo: `google-drive.css` and `google-drive.min.css`).
- Keep all 12 placeholders intact in the source HTML (`{{token}}`, `{{landingPageLink}}`, `{{pollingUrl}}`, `{{updateUrl}}`, `{{file1Name}}`..`{{file4Date}}`).

### 5. Authentication Resolution
- Never fail on stale `.env` refresh tokens.
- `tools/deploy-template.js` automatically falls back to reading the live `googleRefreshToken` from the `SETTINGS` sheet via App Script `SCRIPT_URL?action=getData&sheetname=SETTINGS` and caches it to `scratch/resolved_token.txt`.
