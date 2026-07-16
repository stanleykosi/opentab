import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserApiClient } from '../../application/browser-api-client';
import { resetBrowserApplicationServiceForTests } from '../../application/browser-application-service';
import { LiveAccountOverview } from './live-account-page';

const id = '0'.repeat(26);
const now = '2026-07-14T09:00:00.000Z';
const user = {
  id: `usr_${id}`,
  walletAddress: '0x1111111111111111111111111111111111111111',
  authMethod: 'google',
  status: 'active',
  merchantMemberships: [],
};
const product = {
  id: `prd_${id}`,
  merchantId: `mer_${id}`,
  version: '1',
  slug: 'sunday-table',
  title: 'Sunday Table',
  description: 'A shared lunch.',
  unitPriceBaseUnits: '18000000',
  sold: '1',
  maxPerOrder: '4',
  startsAt: '2027-08-02T12:00:00.000Z',
  refundWindowSeconds: '86400',
  loyaltyPoints: '180',
  metadataHash: `0x${'1'.repeat(64)}`,
  status: 'active',
  createdAt: now,
  updatedAt: now,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('live account overview', () => {
  it('renders authenticated orders and exact loyalty points from server responses', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === '/api/v1/auth/session/refresh') {
        return json({
          user,
          csrfToken: 'c'.repeat(32),
          expiresAt: '2026-07-14T12:00:00.000Z',
          requestId: 'req_account_session',
        });
      }
      if (path === '/api/v1/account/orders?limit=25') {
        return json({
          items: [
            {
              order: {
                id: `ord_${id}`,
                checkoutSessionId: `chk_${id}`,
                orderKey: `0x${'2'.repeat(64)}`,
                userId: user.id,
                merchantId: product.merchantId,
                productId: product.id,
                payer: user.walletAddress,
                recipient: user.walletAddress,
                quantity: '1',
                amountBaseUnits: '18000000',
                paidAmountBaseUnits: '18000000',
                refundedAmountBaseUnits: '0',
                status: 'paid',
                transactionHash: `0x${'3'.repeat(64)}`,
                confirmedAt: now,
                refundableUntil: '2026-07-15T09:00:00.000Z',
                createdAt: now,
                updatedAt: now,
              },
              merchantDisplayName: 'Daylight Room',
              merchantSlug: 'daylight-room',
              product,
            },
          ],
          requestId: 'req_account_orders',
        });
      }
      if (path === '/api/v1/loyalty/status') {
        return json({
          programs: [
            {
              id: 'loyalty-program-1',
              merchantId: product.merchantId,
              name: 'Daylight Regulars',
              thresholdPoints: '1000',
              enabled: true,
              version: '1',
              updatedAt: now,
            },
          ],
          balances: [{ programId: 'loyalty-program-1', points: '180' }],
          observedAt: now,
          requestId: 'req_account_loyalty',
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    resetBrowserApplicationServiceForTests();

    render(<LiveAccountOverview client={new BrowserApiClient({ fetcher })} />);

    expect(
      await screen.findByRole('heading', { name: 'Passes, orders, and progress' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Sunday Table')).toHaveLength(2);
    expect(screen.getByText('Daylight Regulars', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('180')).toBeInTheDocument();
    expect(screen.getByText('paid')).toBeInTheDocument();
  });
});
