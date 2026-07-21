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
}

module.exports = nextConfig
