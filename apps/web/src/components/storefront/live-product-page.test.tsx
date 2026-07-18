import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  PublicProductRecordSchema,
  type PublicSessionApplicationService,
} from '../../application/public-session-api-client';
import { LiveProductPage } from './live-product-page';

const record = PublicProductRecordSchema.parse({
  merchant: {
    id: 'mer_00000000000000000000000000',
    ownerUserId: 'usr_00000000000000000000000000',
    slug: 'daylight-room',
    displayName: 'Daylight Room',
    supportContact: 'hello@daylight.example',
    payoutAddress: '0x1111111111111111111111111111111111111111',
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
    description: 'A long-table gathering with a confirmed digital pass.',
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
});

function service(
  checkoutEnabled: boolean,
): Pick<PublicSessionApplicationService, 'getPublicCheckoutContext' | 'getPublicProduct'> {
  return {
    getPublicProduct: vi.fn(async () => record),
    getPublicCheckoutContext: vi.fn(async () => ({
      checkoutEnabled,
      allowedMediaOrigins: ['https://opentab.example'],
    })),
  };
}

describe('LiveProductPage payment readiness', () => {
  it('keeps checkout paused until the dynamic public configuration is certified', async () => {
    render(
      <LiveProductPage
        merchantSlug="daylight-room"
        paymentsEnabled
        productSlug="sunday-table"
        service={service(false)}
      />,
    );

    expect(await screen.findByRole('button', { name: /Continue/ })).toBeDisabled();
    expect(screen.getByText(/temporarily paused while OpenTab verifies/i)).toBeVisible();
  });

  it('enables checkout only when deployment and dynamic readiness are both enabled', async () => {
    render(
      <LiveProductPage
        merchantSlug="daylight-room"
        paymentsEnabled
        productSlug="sunday-table"
        service={service(true)}
      />,
    );

    expect(await screen.findByRole('button', { name: /Continue/ })).toBeEnabled();
  });

  it('keeps checkout paused when the deployment payment flag is disabled', async () => {
    render(
      <LiveProductPage
        merchantSlug="daylight-room"
        paymentsEnabled={false}
        productSlug="sunday-table"
        service={service(true)}
      />,
    );

    expect(await screen.findByRole('button', { name: /Continue/ })).toBeDisabled();
  });
});
