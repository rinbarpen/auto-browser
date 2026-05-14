import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  typedRoutes: false,
  serverExternalPackages: ['agent-browser', 'playwright-core', 'better-sqlite3', 'ws'],
};

export default nextConfig;
