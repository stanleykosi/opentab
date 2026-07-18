import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    expect(screen.getByText(/Sunday, 2 August 2026/)).toBeVisible();
    expect(screen.getByText(/points until A table-side treat/)).toBeVisible();
    expect(screen.getByText('Non-transferable')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Split this purchase' })).toBeVisible();
  });

  it('uses live schedule data and does not invent a loyalty reward label', () => {
    render(
      <ReceiptPageView
        features={{ ...features, mode: 'live', environment: 'production' }}
        receipt={{
          ...demoReceipt,
          product: { ...demoReceipt.product, startsAt: '2027-08-02T12:00:00.000Z' },
          loyalty: {
            ...demoReceipt.loyalty,
            rewardLabel: 'Reward details unavailable',
            rewardDetailsAvailable: false,
          },
        }}
      />,
    );

    expect(screen.getByText(/Monday, 2 August 2027/)).toBeVisible();
    expect(
      screen.getByText(/does not include a confirmed loyalty award or current rewards balance/),
    ).toBeVisible();
    expect(screen.queryByText('+180 points')).not.toBeInTheDocument();
    expect(screen.queryByText(/Daylight Room loyalty/)).not.toBeInTheDocument();
  });

  it('shares only non-sensitive pass text and never the authenticated receipt URL', async () => {
    const writeText = vi.fn(async () => undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'share');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });

    try {
      render(<ReceiptPageView features={features} receipt={demoReceipt} />);
      fireEvent.click(screen.getByRole('button', { name: 'Share pass details' }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('Sunday Table · Daylight Room'));
      expect(writeText.mock.calls[0]?.[0]).not.toContain('/receipt/');
      expect(writeText.mock.calls[0]?.[0]).not.toContain(demoReceipt.orderId);
    } finally {
      if (clipboardDescriptor === undefined)
        delete (navigator as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      if (shareDescriptor === undefined) delete (navigator as { share?: unknown }).share;
      else Object.defineProperty(navigator, 'share', shareDescriptor);
    }
  });

  it('omits unavailable location and support details instead of inventing them', () => {
    render(
      <ReceiptPageView
        features={features}
        receipt={{
          ...demoReceipt,
          product: {
            ...demoReceipt.product,
            location: undefined,
            merchant: { ...demoReceipt.product.merchant, supportContact: undefined },
          },
        }}
      />,
    );

    expect(screen.queryByText(demoReceipt.product.location ?? '')).not.toBeInTheDocument();
    expect(screen.queryByText(/Questions\? Contact/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /undefined/i })).not.toBeInTheDocument();
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
