# syntax=docker/dockerfile:1

# FULL Chromium is installed via apt (not @sparticuz/chromium-min "chrome-headless-shell").
# The stripped headless shell never fires domcontentloaded on modern heavy JS pages
# (login.live.com/login.srf), leaving rows stuck in WAITINGEMAIL/PROCESSING. Full
# Chromium renders them like a real browser (this is what the Nixpacks deployment used).

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

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates \
     chromium \
     fonts-liberation \
     libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
     libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
     libgbm1 libasound2 libatspi2.0-0 libcairo2 libcairo-gobject2 \
     libpango-1.0-0 libpangocairo-1.0-0 libxcursor1 libx11-xcb1 \
  && rm -rf /var/lib/apt/lists/* \
  && test -x /usr/bin/chromium \
  && echo "Full Chromium verified at /usr/bin/chromium"

# App (non-standalone build: full node_modules + next start)
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/next.config.js /app/postcss.config.js /app/jsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public

EXPOSE 3000

CMD ["npm", "run", "start"]
