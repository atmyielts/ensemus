import path from 'node:path';
import type { NextConfig } from 'next';

const release = process.env.ENSEMUS_RELEASE;

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  transpilePackages: [
    '@ensemus/application',
    '@ensemus/auth',
    '@ensemus/commercial',
    '@ensemus/config',
    '@ensemus/connectors',
    '@ensemus/contracts',
    '@ensemus/database',
    '@ensemus/domain',
    '@ensemus/policy',
    '@ensemus/secrets',
    '@ensemus/storage',
    '@ensemus/telemetry',
  ],
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  // Artifacts are uploaded through Server Actions. The service enforces the same limit.
  experimental: { serverActions: { bodySizeLimit: '26mb' } },
  // Nothing may be fetched from an outside host at runtime (ADR-021).
  images: { unoptimized: true },
  ...(release ? { deploymentId: release } : {}),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
