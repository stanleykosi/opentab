import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserApiClient } from '../../application/browser-api-client';
import type { FrontendFeatureState } from '../../client/view-models';
import { LiveReceiptPage } from './live-receipt-page';

const id = '0'.repeat(26);
const now = '2026-07-14T09:00:00.000Z';
const features: FrontendFeatureState = {
  mode: 'live',
  environment: 'staging',
  payments: true,
  refunds: false,
  withdrawals: false,
  splits: true,
  judgeMode: false,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('live receipt', () => {
  it('shows a pass only from the authoritative paid order projection', async () => {
    const walletAddress = '0x1111111111111111111111111111111111111111';
    const merchantId = `mer_${id}`;
    const productId = `prd_${id}`;
    const orderId = `ord_${id}`;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === '/api/v1/auth/session/refresh') {
        return json({
          user: {
            id: `usr_${id}`,
            walletAddress,
            authMethod: 'google',
            status: 'active',
            merchantMemberships: [],
          },
          csrfToken: 'c'.repeat(32),
          expiresAt: '2026-07-14T12:00:00.000Z',
          requestId: 'req_receipt_session',
        });
      }
      if (path === `/api/v1/receipts/${orderId}`) {
        return json({
          order: {
            id: orderId,
            checkoutSessionId: `chk_${id}`,
            orderKey: `0x${'2'.repeat(64)}`,
            userId: `usr_${id}`,
            merchantId,
            productId,
            payer: walletAddress,
            recipient: walletAddress,
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
          merchant: {
            id: merchantId,
            ownerUserId: `usr_${id}`,
            slug: 'daylight-room',
            displayName: 'Daylight Room',
            supportContact: 'support@daylight.example',
            payoutAddress: walletAddress,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          product: {
            id: productId,
            merchantId,
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
            metadataHash: `0x${'4'.repeat(64)}`,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          receipt: { status: 'issued', tokenId: '1' },
          requestId: 'req_receipt_projection',
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(
      <LiveReceiptPage
        client={new BrowserApiClient({ fetcher })}
        features={features}
        orderId={orderId}
      />,
    );

    expect(await screen.findByText('Paid and confirmed')).toBeInTheDocument();
    expect(screen.getByText(/Monday, 2 August 2027/)).toBeInTheDocument();
    expect(
      screen.getByText(/does not include a confirmed loyalty award or current rewards balance/),
    ).toBeInTheDocument();
    expect(screen.queryByText('+180 points')).not.toBeInTheDocument();
    expect(screen.queryByText(/Daylight Room loyalty/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Receipt and pass for Sunday Table/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Split this purchase' })).toHaveAttribute(
      'href',
      `/receipt/${orderId}/split`,
    );
  });
});
