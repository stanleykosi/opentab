import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserApiClient } from '../../application/browser-api-client';
import { LiveSplitBuilder } from './live-split-builder';

const suffix = '0'.repeat(26);
const now = '2026-07-14T09:00:00.000Z';
const future = '2027-07-14T09:00:00.000Z';
const orderId = `ord_${suffix}`;
const merchantId = `mer_${suffix}`;
const productId = `prd_${suffix}`;
const wallet = '0x1111111111111111111111111111111111111111';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fixtureFetcher() {
  let creates = 0;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path === '/api/v1/auth/session/refresh') {
      return json({
        user: {
          id: `usr_${suffix}`,
          walletAddress: wallet,
          authMethod: 'google',
          status: 'active',
          merchantMemberships: [],
        },
        csrfToken: 'c'.repeat(32),
        expiresAt: future,
        requestId: 'req_split_session',
      });
    }
    if (path === `/api/v1/receipts/${orderId}`) {
      return json({
        order: {
          id: orderId,
          checkoutSessionId: `chk_${suffix}`,
          orderKey: `0x${'2'.repeat(64)}`,
          userId: `usr_${suffix}`,
          merchantId,
          productId,
          payer: wallet,
          recipient: wallet,
          quantity: '1',
          amountBaseUnits: '18000000',
          paidAmountBaseUnits: '18000000',
          refundedAmountBaseUnits: '0',
          status: 'paid',
          confirmedAt: now,
          refundableUntil: future,
          createdAt: now,
          updatedAt: now,
        },
        merchant: {
          id: merchantId,
          ownerUserId: `usr_${suffix}`,
          slug: 'daylight-room',
          displayName: 'Daylight Room',
          payoutAddress: wallet,
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
          startsAt: future,
          refundWindowSeconds: '86400',
          loyaltyPoints: '180',
          metadataHash: `0x${'3'.repeat(64)}`,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        receipt: { status: 'issued', tokenId: '1' },
        requestId: 'req_split_receipt',
      });
    }
    if (path === `/api/v1/orders/${orderId}/splits`) {
      creates += 1;
      return json(
        {
          splitId: `spl_${suffix}`,
          invitations: [
            {
              invitationId: `spi_${suffix}`,
              participantLabel: 'Alex',
              amountBaseUnits: '9000000',
              capabilityReference: `spi_${suffix}.${'a'.repeat(43)}`,
              expiresAt: future,
            },
            {
              invitationId: `spi_${'1'.repeat(26)}`,
              participantLabel: 'Jo',
              amountBaseUnits: '9000000',
              capabilityReference: `spi_${'1'.repeat(26)}.${'b'.repeat(43)}`,
              expiresAt: future,
            },
          ],
          requestId: 'req_split_create',
        },
        201,
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  return { fetcher, creates: () => creates };
}

describe('live split builder recovery', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('restores private capabilities after refresh without creating another split', async () => {
    const fixture = fixtureFetcher();
    const client = new BrowserApiClient({ fetcher: fixture.fetcher });
    const first = render(<LiveSplitBuilder client={client} orderId={orderId} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create private links' }));
    expect(
      await screen.findByRole('heading', { name: 'Your private links are ready' }),
    ).toBeInTheDocument();
    expect(fixture.creates()).toBe(1);
    first.unmount();

    render(
      <LiveSplitBuilder
        client={new BrowserApiClient({ fetcher: fixture.fetcher })}
        orderId={orderId}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Your private links are ready' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(fixture.creates()).toBe(1));
    expect(screen.getByRole('button', { name: "Copy Alex's link" })).toBeInTheDocument();
  });
});
