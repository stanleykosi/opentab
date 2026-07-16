import { EvmAddressSchema } from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { MagicAdminIdentityVerifier } from '../src/magic-admin.js';

const didToken = 'deterministic.did.token.without.secret.material';
const audience = 'magic-client-id';
const address = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const otherAddress = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const now = new Date('2026-07-14T12:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1_000);

function claim(overrides: Record<string, unknown> = {}) {
  return {
    iat: nowSeconds - 30,
    ext: nowSeconds + 300,
    iss: 'did:ethr:magic:issuer',
    sub: 'subject',
    aud: audience,
    nbf: nowSeconds - 30,
    tid: 'token-id',
    add: 'encrypted-proof-material',
    ...overrides,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    issuer: 'did:ethr:magic:issuer',
    publicAddress: address,
    email: 'customer@example.test',
    oauthProvider: 'google',
    phoneNumber: null,
    username: null,
    wallets: [{ network: 'ethereum', publicAddress: address, walletType: 'magic' }],
    ...overrides,
  };
}

function client(input: { claim?: unknown; metadata?: unknown; publicAddress?: string } = {}) {
  const tokenClaim = input.claim ?? claim();
  return {
    clientId: audience,
    token: {
      validate: vi.fn(),
      decode: vi.fn(() => ['proof', tokenClaim] as const),
      getPublicAddress: vi.fn(() => input.publicAddress ?? address),
      getIssuer: vi.fn(() => 'did:ethr:magic:issuer'),
    },
    users: { getMetadataByToken: vi.fn(async () => input.metadata ?? metadata()) },
  };
}

function verifier(fake = client()) {
  return new MagicAdminIdentityVerifier(fake, {
    expectedAudience: audience,
    expectedApplicationId: audience,
    environment: 'test',
    now: () => now,
  });
}

describe('Magic Admin identity verification', () => {
  it('validates the installed DID surface and binds issuer, audience, app, and EOA', async () => {
    const fake = client();
    const result = await verifier(fake).verifyDidToken({
      didToken,
      expectedAudience: audience,
      expectedApplicationId: audience,
    });

    expect(result).toMatchObject({
      walletAddress: address,
      audience,
      applicationId: audience,
      authMethod: 'google',
    });
    expect(fake.token.validate).toHaveBeenCalledWith(didToken);
    expect(fake.users.getMetadataByToken).toHaveBeenCalledWith(didToken);
    expect(JSON.stringify(result)).not.toContain(didToken);
  });

  it('requires application ID to name the same cryptographically checked client ID', () => {
    expect(
      () =>
        new MagicAdminIdentityVerifier(client(), {
          expectedAudience: audience,
          expectedApplicationId: 'unproven-dashboard-id',
          environment: 'production',
        }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });

  it('rejects expired, future, or overlong proofs', async () => {
    const expired = verifier(client({ claim: claim({ ext: nowSeconds - 1 }) }));
    await expect(
      expired.verifyDidToken({
        didToken,
        expectedAudience: audience,
        expectedApplicationId: audience,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });

    const overlong = verifier(
      client({ claim: claim({ iat: nowSeconds - 1, ext: nowSeconds + 86_401 }) }),
    );
    await expect(
      overlong.verifyDidToken({
        didToken,
        expectedAudience: audience,
        expectedApplicationId: audience,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_DID_INVALID' });
  });

  it('rejects any EOA mismatch and unsupported OAuth provider', async () => {
    await expect(
      verifier(client({ publicAddress: otherAddress })).verifyDidToken({
        didToken,
        expectedAudience: audience,
        expectedApplicationId: audience,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ADDRESS_MISMATCH' });

    await expect(
      verifier(client({ metadata: metadata({ oauthProvider: 'github' }) })).verifyDidToken({
        didToken,
        expectedAudience: audience,
        expectedApplicationId: audience,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_DID_INVALID' });
  });

  it('never copies the DID token into safe diagnostic fields', async () => {
    const failing = verifier(client({ claim: claim({ aud: 'wrong-audience', add: didToken }) }));
    const error = await failing
      .verifyDidToken({
        didToken,
        expectedAudience: audience,
        expectedApplicationId: audience,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTH_DID_INVALID' });
    expect(JSON.stringify((error as { safeDetails?: unknown }).safeDetails) ?? '').not.toContain(
      didToken,
    );
  });
});
