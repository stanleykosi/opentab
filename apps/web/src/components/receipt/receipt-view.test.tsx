import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { demoReceipt } from '../../client/deterministic-data';
import type { FrontendFeatureState } from '../../client/view-models';
import { ReceiptPageView } from './receipt-view';

const features: FrontendFeatureState = {
  mode: 'deterministic',
  environment: 'local',
  payments: true,
  refunds: true,
  withdrawals: true,
  splits: true,
  judgeMode: true,
};

describe('ReceiptPageView', () => {
  it('renders the premium pass only for a canonically paid receipt', () => {
    render(<ReceiptPageView features={features} receipt={demoReceipt} />);
    expect(screen.getByText('Paid and confirmed')).toBeVisible();
    expect(screen.getByText('Non-transferable')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Split this purchase' })).toBeVisible();
  });

  it('keeps an unresolved payment in confirming state and warns against resubmission', () => {
    render(
      <ReceiptPageView
        features={features}
        receipt={{
          ...demoReceipt,
          status: 'confirming',
          passStatus: 'pending',
          confirmedAt: undefined,
          transactionHash: undefined,
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'We’re confirming your payment' })).toBeVisible();
    expect(screen.getByText(/Don’t submit another payment\./)).toBeVisible();
    expect(screen.queryByText('Non-transferable')).not.toBeInTheDocument();
  });
});
