import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserApiClient } from '../../application/browser-api-client';
import type { BrowserApplicationService } from '../../application/browser-application-service';
import { LiveReimbursementPage } from './live-reimbursement-page';

const suffix = '0'.repeat(26);
const now = '2026-07-14T09:00:00.000Z';
const future = '2027-07-14T09:00:00.000Z';
const owner = '0x1111111111111111111111111111111111111111';
const digest = `0x${'2'.repeat(64)}`;
const operationId = `cop_${suffix}`;
const reference = `spi_${suffix}.${'a'.repeat(43)}`;

function operation(status: 'submitted_unknown' | 'confirmed') {
  return {
    id: operationId,
    kind: 'split_reimbursement',
    aggregateType: 'split_payment',
    aggregateId: `spp_${suffix}`,
    binding: { ownerAddress: owner },
    template: {
      kind: 'split_reimbursement',
      ownerAddress: owner,
      chainId: '42161',
      calls: [{ to: '0x3333333333333333333333333333333333333333', data: '0x12', valueWei: '0' }],
      bindingDigest: digest,
      expiresAt: future,
    },
    bindingDigest: digest,
    status,
    providerOperationId: 'particle-split-operation-1',
    ...(status === 'confirmed'
      ? {
          transactionHash: `0x${'4'.repeat(64)}`,
          canonicalEventName: 'SplitReimbursed',
        }
      : {}),
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

describe('live reimbursement recovery', () => {
  it('restores a submitted-unknown bound operation and never offers duplicate approval', async () => {
    const capability = {
      split: {
        id: `spl_${suffix}`,
        orderId: `ord_${suffix}`,
        creatorUserId: `usr_${'1'.repeat(26)}`,
        beneficiary: '0x2222222222222222222222222222222222222222',
        totalBaseUnits: '9000000',
        confirmedBaseUnits: '0',
        status: 'active',
        invitations: [
          {
            id: `spi_${suffix}`,
            participantLabel: 'Alex',
            amountBaseUnits: '9000000',
            status: 'submitted_unknown',
            expiresAt: future,
          },
        ],
        expiresAt: future,
      },
      invitation: {
        id: `spi_${suffix}`,
        participantLabel: 'Alex',
        amountBaseUnits: '9000000',
        status: 'submitted_unknown',
        expiresAt: future,
      },
      existingPayment: {
        id: `spp_${suffix}`,
        splitId: `spl_${suffix}`,
        invitationId: `spi_${suffix}`,
        amountBaseUnits: '9000000',
        status: 'submitted_unknown',
        providerOperationId: 'particle-split-operation-1',
        createdAt: now,
        updatedAt: now,
      },
      operation: operation('submitted_unknown'),
      requestId: 'req_split_capability',
    };
    const fetcher = vi.fn<typeof fetch>(async () => json(capability));
    const service = {
      restoreSession: vi.fn(async () => ({
        user: {
          id: `usr_${suffix}`,
          walletAddress: owner,
          authMethod: 'google',
          status: 'active',
          merchantMemberships: [],
        },
      })),
      getContractOperation: vi.fn(async () => operation('confirmed')),
      prepareContractOperation: vi.fn(),
      submitContractOperation: vi.fn(),
    } as unknown as BrowserApplicationService;

    render(
      <LiveReimbursementPage
        client={new BrowserApiClient({ fetcher })}
        reference={reference}
        service={service}
      />,
    );

    expect(await screen.findByText('Don’t pay again')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm reimbursement/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Confirmed reimbursement')).toBeInTheDocument();
    expect(service.prepareContractOperation).not.toHaveBeenCalled();
    expect(service.submitContractOperation).not.toHaveBeenCalled();
  });
});
