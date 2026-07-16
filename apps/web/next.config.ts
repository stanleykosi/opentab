import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

const MAGIC_IFRAME_ORIGIN = 'https://auth.magic.link';
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const PARTICLE_RPC_ORIGIN = 'https://universal-rpc-proxy.particle.network';

function browserRpcOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return 'https://arb1.arbitrum.io';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function buildMediaRemotePatterns(value: string | undefined) {
  if (value === undefined || value.trim() === '') return [];
  const patterns: { protocol: 'https'; hostname: string; port: string; pathname: '/**' }[] = [];
  for (const entry of value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    try {
      const url = new URL(entry);
      if (
        url.protocol !== 'https:' ||
        url.origin !== entry ||
        url.username !== '' ||
        url.password !== ''
      ) {
        continue;
      }
      patterns.push({
        protocol: 'https',
        hostname: url.hostname,
        port: url.port,
        pathname: '/**',
      });
    } catch {
      // Environment validation reports malformed entries; the build policy fails closed here.
    }
  }
  return patterns;
}

/**
 * Static production policy for the parent document. Magic runs in its verified
 * auth iframe and Particle talks only to the SDK's pinned RPC hosts. Next's
 * bootstrap currently needs inline scripts until nonce middleware is adopted;
 * eval and broad network wildcards remain disallowed.
 */
export function buildSecurityHeaders(input: {
  readonly production: boolean;
  readonly publicRpcUrl?: string | undefined;
  readonly turnstileEnabled?: boolean | undefined;
}): readonly SecurityHeader[] {
  const common: SecurityHeader[] = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
  if (!input.production) return common;

  const rpcOrigin = browserRpcOrigin(input.publicRpcUrl);
  const connectSources = [
    "'self'",
    MAGIC_IFRAME_ORIGIN,
    PARTICLE_RPC_ORIGIN,
    ...(input.turnstileEnabled === true ? [TURNSTILE_ORIGIN] : []),
    ...(rpcOrigin === undefined ? [] : [rpcOrigin]),
  ];
  const scriptSources = ["'self'", "'unsafe-inline'"];
  const frameSources = [MAGIC_IFRAME_ORIGIN];
  if (input.turnstileEnabled === true) {
    scriptSources.push(TURNSTILE_ORIGIN);
    frameSources.push(TURNSTILE_ORIGIN);
  }
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSources.join(' ')}`,
    `frame-src ${frameSources.join(' ')}`,
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');

  return [
    ...common,
    { key: 'Content-Security-Policy', value: contentSecurityPolicy },
    {
      key: 'Strict-Transport-Security',
      value: 'max-age=63072000; includeSubDomains; preload',
    },
  ];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  experimental: {
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    },
  },
  outputFileTracingRoot: repositoryRoot,
  images: {
    remotePatterns: buildMediaRemotePatterns(process.env.PRODUCT_MEDIA_ALLOWED_ORIGINS),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          ...buildSecurityHeaders({
            production: process.env.NODE_ENV === 'production',
            publicRpcUrl: process.env.NEXT_PUBLIC_ARBITRUM_PUBLIC_RPC_URL,
            turnstileEnabled: process.env.BOOTSTRAP_SPONSOR_ENABLED === 'true',
          }),
        ],
      },
    ];
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // These packages are used only by Node route-handler composition. Keeping
  // them as runtime dependencies avoids webpack traversing Magic Admin's
  // optional charset loader and viem's full chain-definition index. The
  // browser boundary still dynamically imports only integrations/browser.
  serverExternalPackages: ['@magic-sdk/admin', 'viem'],
  transpilePackages: [
    '@opentab/config',
    '@opentab/db',
    '@opentab/integrations',
    '@opentab/observability',
    '@opentab/shared',
    '@opentab/ui',
  ],
  turbopack: {
    root: repositoryRoot,
  },
  typedRoutes: true,
};

export default nextConfig;
