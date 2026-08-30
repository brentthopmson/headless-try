/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    serverComponentsExternalPackages: [
      'puppeteer-core',
      '@sparticuz/chromium-min',
      'puppeteer-extra',
      'puppeteer-extra-plugin-stealth',
      'puppeteer-extra-plugin',
      'clone-deep',
      'merge-deep'
    ]
  },
  async rewrites() {
    // The WebFixx-Hoo Apps Script triggers stages via the /api/<stage> convention,
    // but the engine exposes the handlers under /campaign/<stage>. Map them at the
    // server layer so the calls resolve without needing a re-export route file
    // (a re-export broke `next build`). Runtime-only, build-safe.
    return [
      { source: '/api/pipeline-orchestrator', destination: '/campaign/pipeline-orchestrator' },
      { source: '/api/execute-campaign', destination: '/campaign/execute-campaign' },
      { source: '/api/validate-campaign', destination: '/campaign/validate-campaign' },
      { source: '/api/enrich-campaign', destination: '/campaign/enrich-campaign' },
      { source: '/api/personalize-campaign', destination: '/campaign/personalize-campaign' },
      { source: '/api/interact-campaign', destination: '/campaign/interact-campaign' },
      { source: '/api/reset-campaign', destination: '/campaign/reset-campaign' },
      { source: '/api/mail-merge', destination: '/campaign/mail-merge' },
    ];
  },
}

module.exports = nextConfig
