import type { ArbitrumReadPort } from '@opentab/application';
import { describe, expect, it } from 'vitest';
import {
  assertPlatformFeeParity,
  deriveApplicationSecret,
  deriveLiveParticlePublicGates,
  judgeEvidenceProvenance,
  parseApiServerEnvironment,
  resolveApplicationReleaseId,
  trustedNetworkSubject,
} from './composition.js';

const releaseA = 'a'.repeat(40);
const releaseB = 'b'.repeat(40);

describe('backend production boundary helpers', () => {
  it('derives independent application secrets from one protected root', () => {
    const root = 'root-secret-material-that-is-at-least-32-bytes';
    const session = deriveApplicationSecret(root, 'session-token-hash');
    const csrf = deriveApplicationSecret(root, 'csrf-token-hash');
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(session).not.toBe(csrf);
    expect(deriveApplicationSecret(undefined, 'session-token-hash')).toBeUndefined();
  });

  it('reports invalid environment field names without exposing secret values', () => {
    const secretValue = 'do-not-return-this-secret-value';
    let observed: unknown;
    try {
      parseApiServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        OPENTAB_SECRET_ROOT: secretValue,
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      code: 'CONFIGURATION_INVALID',
      message: expect.stringContaining('OPENTAB_SECRET_ROOT'),
    });
    expect((observed as Error).message).not.toContain(secretValue);
  });

  it('keeps core APIs online while malformed payment configuration fails closed', () => {
    const config = parseApiServerEnvironment({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      NEXT_PUBLIC_APP_ORIGIN: 'http://localhost:3000',
      PROVIDER_MODE: 'live',
      APPLICATION_RELEASE_ID: releaseA,
      PAYMENTS_ENABLED: 'true',
      PARTICLE_LIVE_ENABLED: 'true',
      NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: 'pk_live_opentab',
      MAGIC_SECRET_KEY: 'sk_live_opentab',
      NEXT_PUBLIC_PARTICLE_PROJECT_ID: 'particle-project',
      NEXT_PUBLIC_PARTICLE_CLIENT_KEY: 'particle-client-key',
      NEXT_PUBLIC_PARTICLE_APP_UUID: 'particle-app',
      ARBITRUM_RPC_URL: 'https://arb1.arbitrum.io/rpc',
      DATABASE_URL: 'postgresql://runtime:secret@localhost:5432/opentab',
      REDIS_URL: 'redis://default:secret@localhost:6379',
      OPENTAB_SECRET_ROOT: 'root-secret-material-that-is-at-least-32-bytes',
      PLATFORM_FEE_BPS: 'not-an-integer',
      ORDER_SIGNER_MODE: 'private-key',
      ORDER_SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      ORDER_SIGNER_ADDRESS: '0x1111111111111111111111111111111111111111',
    });

    expect(config).toMatchObject({
      PAYMENTS_ENABLED: false,
      PARTICLE_LIVE_ENABLED: false,
      MERCHANT_MUTATIONS_ENABLED: true,
      PLATFORM_FEE_BPS: 0,
      ORDER_SIGNER_MODE: 'disabled',
    });
  });

  it('resolves a portable release ID on non-Vercel hosts', () => {
    expect(resolveApplicationReleaseId({ APPLICATION_RELEASE_ID: releaseA }, false)).toBe(releaseA);
  });

  it('accepts the exact Vercel commit only as a fallback', () => {
    expect(resolveApplicationReleaseId({ VERCEL_GIT_COMMIT_SHA: releaseA }, false)).toBe(releaseA);
    expect(
      resolveApplicationReleaseId(
        { APPLICATION_RELEASE_ID: releaseA, VERCEL_GIT_COMMIT_SHA: releaseA },
        false,
      ),
    ).toBe(releaseA);
  });

  it('fails closed when portable and Vercel release IDs differ', () => {
    expect(() =>
      resolveApplicationReleaseId(
        { APPLICATION_RELEASE_ID: releaseA, VERCEL_GIT_COMMIT_SHA: releaseB },
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });

  it('rejects missing, malformed, and truncated live release IDs', () => {
    for (const env of [
      {},
      { APPLICATION_RELEASE_ID: releaseA.slice(0, 39) },
      { APPLICATION_RELEASE_ID: `${releaseA}0` },
      { APPLICATION_RELEASE_ID: ` ${releaseA}` },
      { APPLICATION_RELEASE_ID: releaseA.toUpperCase() },
      { VERCEL_GIT_COMMIT_SHA: `${releaseA}0` },
    ]) {
      expect(() => resolveApplicationReleaseId(env, false)).toThrow(
        expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
      );
    }
  });

  it('preserves the local deterministic release label without deployment metadata', () => {
    expect(resolveApplicationReleaseId({}, true)).toBe('local-deterministic');
  });

  it('accepts one trusted Vercel IP and rejects spoofable or multi-hop input', () => {
    expect(
      trustedNetworkSubject(
        new Request('https://opentab.example', {
          headers: { 'x-vercel-forwarded-for': '2001:db8::1' },
        }),
        'production',
      ),
    ).toBe('2001:db8::1');
    expect(() =>
      trustedNetworkSubject(
        new Request('https://opentab.example', {
          headers: { 'x-forwarded-for': '198.51.100.10' },
        }),
        'production',
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    for (const value of ['198.51.100.1, 203.0.113.2', 'not-an-ip', `1${'0'.repeat(64)}`]) {
      expect(() =>
        trustedNetworkSubject(
          new Request('https://opentab.example', {
            headers: { 'x-vercel-forwarded-for': value },
          }),
          'production',
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
  });

  it('allows a validated local fallback only in local/test', () => {
    expect(trustedNetworkSubject(new Request('http://localhost'), 'test')).toBe('127.0.0.1');
    expect(
      trustedNetworkSubject(
        new Request('http://localhost', { headers: { 'x-forwarded-for': '127.0.0.2' } }),
        'local',
      ),
    ).toBe('127.0.0.2');
  });

  it('fails closed when the signed fee diverges from the contract fee', async () => {
    const chain = { readPlatformFeeBps: async () => '100' } as ArbitrumReadPort;
    await expect(assertPlatformFeeParity(chain, 100)).resolves.toBeUndefined();
    await expect(assertPlatformFeeParity(chain, 0)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    await expect(assertPlatformFeeParity({} as ArbitrumReadPort, 100)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
  });

  it('labels deterministic and pre-production Judge evidence without live provenance', () => {
    expect(judgeEvidenceProvenance('local', true)).toBe('deterministic');
    expect(judgeEvidenceProvenance('preview', false)).toBe('staging');
    expect(judgeEvidenceProvenance('staging', false)).toBe('staging');
    expect(judgeEvidenceProvenance('demo-mainnet', false)).toBe('recorded_live');
    expect(judgeEvidenceProvenance('production', false)).toBe('recorded_live');
  });

  it('keeps customer checkout closed until the live Particle profile is certified', () => {
    expect(
      deriveLiveParticlePublicGates({
        particleLiveEnabled: true,
        profileStage: 'canary_ready',
        hasSourceTokenProfile: true,
      }),
    ).toEqual({ particleReady: true, customerCheckoutReady: false });

    expect(
      deriveLiveParticlePublicGates({
        particleLiveEnabled: true,
        profileStage: 'certified',
        hasSourceTokenProfile: true,
      }),
    ).toEqual({ particleReady: true, customerCheckoutReady: true });
  });

  it('does not expose Particle before a source policy exists', () => {
    for (const input of [
      {
        particleLiveEnabled: false,
        profileStage: 'certified' as const,
        hasSourceTokenProfile: true,
      },
      {
        particleLiveEnabled: true,
        profileStage: 'bootstrap' as const,
        hasSourceTokenProfile: false,
      },
      {
        particleLiveEnabled: true,
        profileStage: 'canary_ready' as const,
        hasSourceTokenProfile: false,
      },
    ]) {
      expect(deriveLiveParticlePublicGates(input)).toEqual({
        particleReady: false,
        customerCheckoutReady: false,
      });
    }
  });
});
