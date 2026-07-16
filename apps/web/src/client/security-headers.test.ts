import { describe, expect, it } from 'vitest';
import { buildMediaRemotePatterns, buildSecurityHeaders } from '../../next.config';

function headerMap(production: boolean, publicRpcUrl?: string, turnstileEnabled = false) {
  return new Map(
    buildSecurityHeaders({
      production,
      ...(publicRpcUrl === undefined ? {} : { publicRpcUrl }),
      turnstileEnabled,
    }).map(({ key, value }) => [key, value]),
  );
}

describe('web security headers', () => {
  it('pins production browser connections to verified Magic, Particle, and configured RPC origins', () => {
    const headers = headerMap(true, 'https://rpc.example/arbitrum/public', true);
    const policy = headers.get('Content-Security-Policy') ?? '';

    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain('frame-src https://auth.magic.link');
    expect(policy).toContain('https://universal-rpc-proxy.particle.network');
    expect(policy).not.toContain('https://universal-rpc-staging.particle.network');
    expect(policy).not.toContain('https://universal-rpc.particle.network');
    expect(policy).toContain('https://rpc.example');
    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    expect(policy).toContain('frame-src https://auth.magic.link https://challenges.cloudflare.com');
    expect(policy).not.toContain('connect-src *');
    expect(policy).not.toContain('script-src *');
    expect(policy).not.toContain("'unsafe-eval'");
    expect(headers.get('Strict-Transport-Security')).toContain('includeSubDomains');
  });

  it('omits Turnstile origins while bootstrap sponsorship is disabled', () => {
    const policy = headerMap(true, 'https://rpc.example/arbitrum/public').get(
      'Content-Security-Policy',
    );

    expect(policy).not.toContain('https://challenges.cloudflare.com');
    expect(policy).toContain('frame-src https://auth.magic.link');
  });

  it('keeps local HTTP development free of production-only CSP and HSTS', () => {
    const headers = headerMap(false);

    expect(headers.has('Content-Security-Policy')).toBe(false);
    expect(headers.has('Strict-Transport-Security')).toBe(false);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('does not place credential-bearing RPC URLs in a response header', () => {
    const policy = headerMap(true, 'https://user:secret@rpc.example/path').get(
      'Content-Security-Policy',
    );

    expect(policy).not.toContain('user');
    expect(policy).not.toContain('secret');
    expect(policy).not.toContain('rpc.example');
  });

  it('creates image patterns only from exact credential-free HTTPS origins', () => {
    expect(
      buildMediaRemotePatterns(
        'https://media.example,https://cdn.example:8443,https://user:secret@bad.example,http://plain.example/path',
      ),
    ).toEqual([
      { protocol: 'https', hostname: 'media.example', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'cdn.example', port: '8443', pathname: '/**' },
    ]);
  });
});
