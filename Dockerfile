# syntax=docker/dockerfile:1

# Chromium for puppeteer is installed + verified at BUILD time instead of on
# first request. At runtime `chromium.executablePath(remoteExecutablePath)`
# short-circuits on an existing /tmp/chromium (see index.js existsSync check),
# so no download / write happens after boot -- eliminating the concurrent
# extraction race that produced `spawn ETXTBSY`.

FROM node:20-slim AS deps

WORKDIR /app

ENV NODE_ENV=production

# Runtime libraries for the @sparticuz/chromium-min headless shell
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates \
     libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
     libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
     libgbm1 libasound2 libatspi2.0-0 libcairo2 libcairo-gobject2 \
     libpango-1.0-0 libpangocairo-1.0-0 libxcursor1 libx11-xcb1 \
     fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Download the Chromium pack, extract it, and brotli-inflate to
# /tmp/chromium (binary) + /tmp/fonts, then verify the binary runs.
# URL matches `remoteExecutablePath` in src/utils/utils.js.
RUN node -e "require('@sparticuz/chromium-min').executablePath('https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar').then(p=>console.log('Chromium installed at '+p)).catch(e=>{console.error(e);process.exit(1)})" \
  && test -x /tmp/chromium \
  && /tmp/chromium --no-sandbox --version

FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Tell utils.js the browser is pre-installed so it never deletes /tmp/chromium
# (which would force a runtime re-download + re-extract on first request).
ENV CHROMIUM_PREINSTALLED=true
ENV FONTCONFIG_PATH=/tmp/fonts

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates \
     libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
     libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
     libgbm1 libasound2 libatspi2.0-0 libcairo2 libcairo-gobject2 \
     libpango-1.0-0 libpangocairo-1.0-0 libxcursor1 libx11-xcb1 \
     fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# Pre-installed browser binary + fonts (baked at build time, copied across stages)
COPY --from=deps /tmp/chromium /tmp/chromium
COPY --from=deps /tmp/fonts /tmp/fonts

# App (non-standalone build: full node_modules + next start)
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/next.config.js /app/postcss.config.js /app/jsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public

EXPOSE 3000

CMD ["npm", "run", "start"]
