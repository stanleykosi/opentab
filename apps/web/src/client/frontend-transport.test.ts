import { describe, expect, it, vi } from 'vitest';
import { createHttpFrontendTransport, type FrontendTransportError } from './frontend-transport';

describe('frontend HTTP transport security', () => {
  it('adds explicit idempotency and CSRF headers to checkout creation', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            accepted: true,
            requestId: 'req_test_transport',
            resourceId: 'chk_test_transport',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const transport = createHttpFrontendTransport({
      fetcher,
      getCsrfToken: () => 'csrf-test-value',
    });
    await transport.startCheckout(
      { productId: 'prd_sunday_table', quantity: '1' },
      'checkout-idempotency-test',
    );
    const init = fetcher.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toBe('checkout-idempotency-test');
    expect(headers.get('X-CSRF-Token')).toBe('csrf-test-value');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBe(JSON.stringify({ productId: 'prd_sunday_table', quantity: '1' }));
  });

  it('fails closed before a mutation when CSRF state is missing', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = createHttpFrontendTransport({ fetcher, getCsrfToken: () => undefined });
    await expect(
      transport.createProduct(
        {
          title: 'Sunday Table',
          slug: 'sunday-table',
          description: 'Demo',
          unitPriceBaseUnits: '18000000',
          inventory: '20',
          maxPerOrder: '4',
          refundWindowSeconds: '172800',
          loyaltyPoints: '180',
        },
        'product-idempotency-test',
      ),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_UNAVAILABLE',
    } satisfies Partial<FrontendTransportError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an invalid server payload instead of guessing its shape', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ state: 'paid' }), { status: 200 }),
    );
    const transport = createHttpFrontendTransport({ fetcher });
    await expect(transport.getCheckout('chk_safe_reference')).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
    } satisfies Partial<FrontendTransportError>);
  });

  it('uses the final public product, receipt, and split-link route inventory', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const transport = createHttpFrontendTransport({ fetcher });

    await expect(transport.getPublicProduct('merchant-one', 'offer-one')).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
    });
    await expect(transport.getReceipt('ord_reference')).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
    });
    await expect(transport.getSplit('private_reference')).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
    });

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/merchants/merchant-one/products/offer-one',
      '/api/v1/receipts/ord_reference',
      '/api/v1/split-links/private_reference',
    ]);
  });
});
