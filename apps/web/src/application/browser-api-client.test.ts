import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordedPublicJudgeProof } from '../components/judge/public-judge-proof.test-fixture';
import { BrowserApiClient } from './browser-api-client';

const user = {
  id: 'usr_00000000000000000000000000',
  walletAddress: '0x1111111111111111111111111111111111111111',
  authMethod: 'google',
  status: 'active',
  merchantMemberships: [],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('browser API client session handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an invalid idempotency key before dispatching a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new BrowserApiClient({ fetcher });

    await expect(
      client.createCheckoutSession(
        { productId: `prd_${'0'.repeat(26)}`, quantity: '1' },
        'too-short',
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('binds the native browser fetch receiver before restoring a session', async () => {
    const guardedFetch = vi.fn<typeof fetch>(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(
        json({
          user,
          csrfToken: 'c'.repeat(32),
          expiresAt: '2026-07-14T02:00:00.000Z',
          requestId: 'req_bound_fetch_test',
        }),
      );
    });
    vi.stubGlobal('fetch', guardedFetch);

    await expect(new BrowserApiClient().restoreSession()).resolves.toMatchObject({ user });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('rotates a session without requiring a stale CSRF value', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        user,
        csrfToken: 'c'.repeat(32),
        expiresAt: '2026-07-14T02:00:00.000Z',
        requestId: 'req_refresh_test',
      }),
    );
    const client = new BrowserApiClient({ fetcher });
    await client.restoreSession();
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.has('X-CSRF-Token')).toBe(false);
    expect(client.getCsrfTokenForTests()).toBe('c'.repeat(32));
  });

  it('requires the in-memory CSRF value for logout and never returns it to storage', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          user,
          csrfToken: 'c'.repeat(32),
          expiresAt: '2026-07-14T02:00:00.000Z',
          requestId: 'req_refresh_test',
        }),
      )
      .mockResolvedValueOnce(json({ revoked: true, requestId: 'req_logout_test' }));
    const client = new BrowserApiClient({ fetcher });
    await client.restoreSession();
    await client.logoutSession();
    const headers = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(headers.get('X-CSRF-Token')).toBe('c'.repeat(32));
    expect(client.getCsrfTokenForTests()).toBeUndefined();
  });

  it('loads public product data over the concrete merchant/product HTTP route', async () => {
    const zeroId = '0'.repeat(26);
    const digest = `0x${'1'.repeat(64)}`;
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        merchant: {
          id: `mer_${zeroId}`,
          ownerUserId: `usr_${zeroId}`,
          slug: 'http-merchant',
          displayName: 'HTTP Merchant',
          supportContact: 'support@example.com',
          payoutAddress: '0x1111111111111111111111111111111111111111',
          status: 'active',
          createdAt: '2026-07-14T01:00:00.000Z',
          updatedAt: '2026-07-14T01:00:00.000Z',
        },
        product: {
          id: `prd_${zeroId}`,
          merchantId: `mer_${zeroId}`,
          version: '1',
          slug: 'live-offer',
          title: 'Live HTTP Offer',
          description: 'Returned by the public product endpoint.',
          unitPriceBaseUnits: '18000000',
          sold: '0',
          maxPerOrder: '4',
          startsAt: '2027-07-14T01:00:00.000Z',
          refundWindowSeconds: '86400',
          loyaltyPoints: '180',
          metadataHash: digest,
          status: 'active',
          createdAt: '2026-07-14T01:00:00.000Z',
          updatedAt: '2026-07-14T01:00:00.000Z',
        },
        availabilityObservedAt: '2026-07-14T01:00:00.000Z',
        projectionStale: false,
        requestId: 'req_public_product_test',
      }),
    );
    const client = new BrowserApiClient({ fetcher });

    await expect(client.getPublicProduct('http-merchant', 'live-offer')).resolves.toMatchObject({
      product: { title: 'Live HTTP Offer' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/merchants/http-merchant/products/live-offer',
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'same-origin' }),
    );
  });

  it('sends Judge capabilities only in the dedicated header and never in the URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ proof: recordedPublicJudgeProof, requestId: 'req_judge_test' }),
    );
    const client = new BrowserApiClient({ fetcher });
    const capability = 'private_judge_capability_1234567890';

    await client.getJudgeProof(`ord_${'0'.repeat(26)}`, capability);
    await client.getJudgeProof(`ord_${'0'.repeat(26)}`);

    const [protectedUrl, protectedInit] = fetcher.mock.calls[0] ?? [];
    const [publicUrl, publicInit] = fetcher.mock.calls[1] ?? [];
    expect(protectedUrl).toBe(`/api/v1/judge/orders/ord_${'0'.repeat(26)}/proof`);
    expect(String(protectedUrl)).not.toContain(capability);
    expect(new Headers(protectedInit?.headers).get('X-OpenTab-Judge-Token')).toBe(capability);
    expect(publicUrl).toBe(`/api/v1/judge/orders/ord_${'0'.repeat(26)}/proof`);
    expect(new Headers(publicInit?.headers).has('X-OpenTab-Judge-Token')).toBe(false);
  });

  it('sends separate single-use challenge tokens for sponsor eligibility and grant', async () => {
    const eligibilityToken = 'turnstile_eligibility_token_123456';
    const grantToken = 'turnstile_grant_token_123456789012';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          user,
          csrfToken: 'c'.repeat(32),
          expiresAt: '2026-07-14T02:00:00.000Z',
          requestId: 'req_refresh_sponsor_test',
        }),
      )
      .mockResolvedValueOnce(
        json({
          eligible: true,
          recipient: user.walletAddress,
          targetWei: '100',
          confirmedBalanceWei: '0',
          pendingAmountWei: '0',
          deficitWei: '100',
          reason: 'eligible',
          observedAt: '2026-07-14T01:00:00.000Z',
          requestId: 'req_eligibility_test',
        }),
      )
      .mockResolvedValueOnce(
        json({
          grant: {
            id: 'grant_0000000000000000',
            userId: user.id,
            recipient: user.walletAddress,
            amountWei: '100',
            status: 'created',
            createdAt: '2026-07-14T01:00:00.000Z',
          },
          requestId: 'req_grant_test',
        }),
      );
    const client = new BrowserApiClient({ fetcher });
    await client.restoreSession();

    await client.evaluateBootstrapEligibility(eligibilityToken, 'eligibility-key-1');
    await client.requestBootstrapGrant(grantToken, 'grant-key-0000001');

    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      challengeToken: eligibilityToken,
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      challengeToken: grantToken,
    });
    expect(eligibilityToken).not.toBe(grantToken);
  });
});
