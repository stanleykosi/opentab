import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { demoDashboard, demoProduct } from '../client/deterministic-data';
import { LiveAccountOrdersView, LiveAccountOverviewView } from './account/account-view';
import { MerchantOrders, MerchantProducts } from './merchant/dashboard';
import { OrderDetail } from './merchant/details';
import { ProductPageView } from './storefront/storefront';

const features = {
  mode: 'live' as const,
  environment: 'production',
  payments: true,
  refunds: false,
  withdrawals: false,
  splits: false,
  judgeMode: false,
};

describe('canonical production journey copy', () => {
  it('directs an empty account back to a merchant checkout link or QR without inventing a marketplace', () => {
    render(
      <LiveAccountOverviewView
        loyalty={undefined}
        orders={[]}
        walletAddress="0x1111111111111111111111111111111111111111"
      />,
    );

    expect(screen.getByText(/merchant checkout link or scan their QR code/i)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Return to OpenTab' })).toHaveAttribute('href', '/');
    expect(screen.queryByText(/explore/i)).not.toBeInTheDocument();
  });

  it('uses the same truthful empty guidance on the order ledger', () => {
    render(
      <LiveAccountOrdersView
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => undefined}
        orders={[]}
      />,
    );

    expect(screen.getByText(/merchant checkout link or scan their QR code/i)).toBeVisible();
  });

  it('omits unrecorded product facts and renders non-email support as plain text', () => {
    render(
      <ProductPageView
        mode="live"
        paymentsEnabled={false}
        product={{
          ...demoProduct,
          category: undefined,
          location: undefined,
          merchant: { ...demoProduct.merchant, supportContact: '+234 800 000 0000' },
        }}
      />,
    );

    expect(screen.queryByText('Where')).not.toBeInTheDocument();
    expect(screen.queryByText('Event pass')).not.toBeInTheDocument();
    expect(screen.getByText('+234 800 000 0000')).toBeVisible();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('does not show inert merchant filter controls', () => {
    const { rerender } = render(<MerchantProducts dashboard={demoDashboard} />);
    expect(screen.queryByRole('button', { name: 'Apply filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();

    rerender(<MerchantOrders dashboard={demoDashboard} />);
    expect(screen.queryByRole('button', { name: 'Apply filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('hides Judge Mode evidence when that feature is disabled', () => {
    const order = demoDashboard.orders[0];
    if (order === undefined) throw new Error('The order fixture is missing.');
    render(<OrderDetail features={features} order={order} />);

    expect(screen.queryByRole('link', { name: 'Open order evidence' })).not.toBeInTheDocument();
    expect(screen.queryByText('Technical proof')).not.toBeInTheDocument();
  });
});
