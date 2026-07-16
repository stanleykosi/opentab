import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FrontendFeatureState, MerchantOrderView } from '../../client/view-models';
import { RefundFlow, WithdrawalFlow } from './finance-flows';

const features: FrontendFeatureState = {
  mode: 'live',
  environment: 'staging',
  payments: true,
  refunds: true,
  withdrawals: true,
  splits: true,
  judgeMode: false,
};

const order: MerchantOrderView = {
  id: `ord_${'0'.repeat(26)}`,
  productTitle: 'Sunday Table',
  customerAlias: '0x1111…1111',
  amountBaseUnits: '18000000',
  paidBaseUnits: '18000000',
  refundedBaseUnits: '0',
  refundableUntil: '2027-07-14T12:00:00.000Z',
  status: 'paid',
  createdAt: '2026-07-14T09:00:00.000Z',
  supportReference: '0000000000',
};

describe('merchant financial flows', () => {
  it('prepares and previews an exact refund before allowing submission', async () => {
    const actions = {
      prepare: vi.fn(async () => ({
        id: `cop_${'0'.repeat(26)}`,
        estimatedFeeUsd: '0.08',
        maximumTotalUsd: '18.08',
      })),
      submit: vi.fn(async () => ({ id: `cop_${'0'.repeat(26)}`, status: 'submitted' as const })),
      getStatus: vi.fn(),
    };
    render(<RefundFlow features={features} liveActions={actions} order={order} />);

    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));

    expect(await screen.findByText('$0.08')).toBeInTheDocument();
    expect(actions.prepare).toHaveBeenCalledWith('18000000');
    expect(actions.submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Confirm refund of/ }));
    await waitFor(() => expect(actions.submit).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: 'Confirming refund' })).toBeInTheDocument();
  });

  it('restores a submitted-unknown withdrawal without preparing or submitting a duplicate', async () => {
    const actions = {
      prepare: vi.fn(),
      submit: vi.fn(),
      getStatus: vi.fn(async () => ({
        id: `cop_${'1'.repeat(26)}`,
        status: 'confirming' as const,
      })),
    };
    render(
      <WithdrawalFlow
        dashboard={{
          merchant: {
            id: `mer_${'0'.repeat(26)}`,
            slug: 'daylight-room',
            displayName: 'Daylight Room',
            monogram: 'DR',
            supportContact: 'support@example.test',
            verified: true,
          },
          grossBaseUnits: '18000000',
          refundedBaseUnits: '0',
          pendingBaseUnits: '0',
          withdrawableBaseUnits: '18000000',
          withdrawnBaseUnits: '0',
          loyaltyMembers: '0',
          freshness: { state: 'fresh', checkedAt: '2026-07-14T09:00:00.000Z' },
          products: [],
          orders: [],
          salesSeries: [],
        }}
        features={features}
        initialResult={{
          id: `cop_${'1'.repeat(26)}`,
          amountBaseUnits: '18000000',
          status: 'submitted_unknown',
        }}
        liveActions={actions}
      />,
    );

    expect(screen.getByText('Do not withdraw again')).toBeInTheDocument();
    expect(actions.prepare).not.toHaveBeenCalled();
    expect(actions.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(actions.getStatus).toHaveBeenCalledTimes(1));
    expect(actions.submit).not.toHaveBeenCalled();
  });
});
