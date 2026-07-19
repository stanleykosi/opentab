import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DefaultPublicSessionApplicationService,
  PublicSessionApiClient,
} from './public-session-api-client';

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

describe('lightweight public/session API boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('binds the native browser fetch receiver before restoring a session', async () => {
    const guardedFetch = vi.fn<typeof fetch>(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(
        json({
          user,
          csrfToken: 'c'.repeat(32),
          expiresAt: '2026-07-16T02:00:00.000Z',
          requestId: 'req_public_bound_fetch_test',
        }),
      );
    });
    vi.stubGlobal('fetch', guardedFetch);

    await expect(new PublicSessionApiClient().restoreSession()).resolves.toMatchObject({ user });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps provider code deferred while preserving session CSRF and logout ordering', async () => {
    const csrfToken = 'c'.repeat(32);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          user,
          csrfToken,
          expiresAt: '2026-07-16T02:00:00.000Z',
          requestId: 'req_public_session_refresh',
        }),
      )
      .mockResolvedValueOnce(json({ revoked: true, requestId: 'req_public_session_logout' }));
    const logoutProviderSession = vi.fn(async () => undefined);
    const loadProviderSession = vi.fn(async () => ({ logoutProviderSession }));
    const client = new PublicSessionApiClient({ fetcher });
    const service = new DefaultPublicSessionApplicationService({
      api: client,
      loadProviderSession,
    });

    await service.restoreSession();
    expect(loadProviderSession).not.toHaveBeenCalled();
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('X-CSRF-Token')).toBe(false);

    await service.logout();
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe(csrfToken);
    expect(loadProviderSession).toHaveBeenCalledTimes(1);
    expect(logoutProviderSession).toHaveBeenCalledTimes(1);
    expect(client.getCsrfTokenForTests()).toBeUndefined();
  });

  it('fails closed on an unexpected public-product response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        merchant: {
          id: 'mer_00000000000000000000000000',
          ownerUserId: user.id,
          slug: 'daylight-room',
          displayName: 'Daylight Room',
          payoutAddress: user.walletAddress,
          status: 'active',
          createdAt: '2026-07-16T01:00:00.000Z',
          updatedAt: '2026-07-16T01:00:00.000Z',
        },
        product: {
          id: 'prd_00000000000000000000000000',
          merchantId: 'mer_00000000000000000000000000',
          version: '1',
          slug: 'sunday-table',
          title: 'Sunday Table',
          description: 'A long-table gathering.',
          unitPriceBaseUnits: '18000000',
          sold: '0',
          maxPerOrder: '4',
          startsAt: '2027-07-16T01:00:00.000Z',
          refundWindowSeconds: '86400',
          loyaltyPoints: '180',
          metadataHash: `0x${'1'.repeat(64)}`,
          status: 'active',
          createdAt: '2026-07-16T01:00:00.000Z',
          updatedAt: '2026-07-16T01:00:00.000Z',
        },
        availabilityObservedAt: '2026-07-16T01:00:00.000Z',
        projectionStale: false,
        requestId: 'req_public_product',
        unexpectedProviderPayload: true,
      }),
    );

    await expect(
      new PublicSessionApiClient({ fetcher }).getPublicProduct('daylight-room', 'sunday-table'),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'RESPONSE_INVALID',
        status: 200,
      }),
    );
  });

  it('rejects unsafe route segments before issuing a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new PublicSessionApiClient({ fetcher });

    expect(() => client.getPublicProduct('../merchant', 'offer')).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
