import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserApiClient } from '../../application/browser-api-client';
import type { BrowserApplicationService } from '../../application/browser-application-service';
import { LiveProductDetail } from './live-product-detail';

vi.mock('./qr-card', () => ({
  QrShareCard: () => <section aria-label="Checkout QR" />,
}));

const suffix = '0'.repeat(26);
const now = '2026-07-14T09:00:00.000Z';
const future = '2027-07-14T09:00:00.000Z';
const owner = '0x1111111111111111111111111111111111111111';
const digest = `0x${'2'.repeat(64)}`;
const merchantId = `mer_${suffix}`;
const productId = `prd_${suffix}`;
const operationId = `cop_${suffix}`;

const merchant = {
  id: merchantId,
  ownerUserId: `usr_${suffix}`,
  slug: 'daylight-room',
  displayName: 'Daylight Room',
  supportContact: 'support@example.test',
  payoutAddress: owner,
  status: 'active',
  createdAt: now,
  updatedAt: now,
};

const product = {
  id: productId,
  merchantId,
  onchainProductId: '1',
  version: '1',
  slug: 'sunday-table',
  title: 'Sunday Table',
  description: 'A shared lunch.',
  unitPriceBaseUnits: '18000000',
  maxSupply: '18',
  sold: '0',
  maxPerOrder: '4',
  startsAt: '2027-08-02T12:00:00.000Z',
  refundWindowSeconds: '86400',
  loyaltyPoints: '180',
  metadataHash: digest,
  status: 'publishing',
  createdAt: now,
  updatedAt: now,
};

function operation(status = 'prepared') {
  return {
    id: operationId,
    kind: 'product_mutation',
    aggregateType: 'product',
    aggregateId: productId,
    binding: { ownerAddress: owner, action: 'set_product_active' },
    template: {
      kind: 'product_mutation',
      ownerAddress: owner,
      chainId: '42161',
      calls: [{ to: '0x3333333333333333333333333333333333333333', data: '0x12', valueWei: '0' }],
      bindingDigest: digest,
      expiresAt: future,
    },
    bindingDigest: digest,
    status,
    ...(status === 'prepared' ? {} : { providerOperationId: 'particle-operation-product-1' }),
    expiresAt: future,
    createdAt: now,
    updatedAt: now,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('live product detail', () => {
  it('prepares a persisted status operation before showing the embedded-account approval', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === '/api/v1/auth/session/refresh') {
        return json({
          user: {
            id: `usr_${suffix}`,
            walletAddress: owner,
            authMethod: 'google',
            status: 'active',
            merchantMemberships: [{ merchantId, role: 'owner' }],
          },
          csrfToken: 'c'.repeat(32),
          expiresAt: future,
          requestId: 'req_product_session',
        });
      }
      if (path === '/api/v1/merchant/profile') {
        return json({
          merchant,
          version: '1',
          chainSyncStatus: 'confirmed',
          requestId: 'req_product_profile',
        });
      }
      if (path === `/api/v1/merchant/products/${productId}`) {
        return json({
          product,
          optimisticVersion: '1',
          chainSyncStatus: 'confirmed',
          requestId: 'req_product_detail',
        });
      }
      if (path === `/api/v1/merchant/products/${productId}/publish`) {
        return json({
          id: productId,
          status: 'publishing',
          operation: operation(),
          requestId: 'req_product_publish',
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const service = {
      prepareContractOperation: vi.fn(async (record) => ({
        operation: record,
        providerOperationId: 'particle-operation-product-1',
        plan: {
          quote: { estimatedFeeUsd: '0.07', totalUsd: '0.07' },
          expiresAt: future,
        },
      })),
      submitContractOperation: vi.fn(async () => ({
        kind: 'submitted',
        operation: operation('submitted'),
      })),
      getContractOperation: vi.fn(async () => operation('confirming')),
    } as unknown as BrowserApplicationService;

    render(
      <LiveProductDetail
        client={new BrowserApiClient({ fetcher })}
        productId={productId}
        service={service}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Activate sales' }));
    expect(await screen.findAllByText('$0.07')).toHaveLength(2);
    expect(service.prepareContractOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: operationId, kind: 'product_mutation' }),
    );
    expect(service.submitContractOperation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Approve product change' }));
    await waitFor(() => expect(service.submitContractOperation).toHaveBeenCalledWith(operationId));
  });
});
