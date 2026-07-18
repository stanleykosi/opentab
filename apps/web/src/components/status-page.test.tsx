import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PublicSessionApplicationService } from '../application/public-session-api-client';
import type { FrontendFeatureState } from '../client/view-models';
import { StatusPage } from './status-page';

const liveFeatures: FrontendFeatureState = {
  mode: 'live',
  environment: 'production',
  payments: false,
  refunds: false,
  withdrawals: false,
  splits: true,
  judgeMode: false,
};

function service(
  checkoutEnabled: boolean,
): Pick<PublicSessionApplicationService, 'getPublicCheckoutContext'> {
  return {
    getPublicCheckoutContext: async () => ({ checkoutEnabled, allowedMediaOrigins: [] }),
  };
}

describe('StatusPage', () => {
  it('reports configured feature availability without claiming synthetic system health', () => {
    render(<StatusPage features={liveFeatures} service={service(false)} />);

    expect(screen.getByText('Some product features paused')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Checkout is currently paused' })).toBeVisible();
    const checkout = screen.getByText('Checkout').closest('div');
    expect(checkout).not.toBeNull();
    expect(within(checkout as HTMLElement).getByText('Paused')).toBeVisible();
    expect(screen.getByText(/reports whether OpenTab capabilities are ready to use/)).toBeVisible();
    expect(screen.queryByText(/All product systems available/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No incidents in the last 30 days/)).not.toBeInTheDocument();
  });

  it('requires the centrally certified checkout gate even when deployment payments are enabled', async () => {
    render(<StatusPage features={{ ...liveFeatures, payments: true }} service={service(false)} />);

    expect(
      await screen.findByRole('heading', { name: 'Checkout is currently paused' }),
    ).toBeVisible();
    const checkout = screen.getByText('Checkout').closest('div');
    expect(checkout).not.toBeNull();
    expect(within(checkout as HTMLElement).getByText('Paused')).toBeVisible();
  });

  it('reports checkout enabled only after the public certification gate is ready', async () => {
    render(<StatusPage features={{ ...liveFeatures, payments: true }} service={service(true)} />);

    expect(await screen.findByRole('heading', { name: 'Checkout is enabled' })).toBeVisible();
  });

  it('preserves fully enabled deterministic presentation fixtures', () => {
    render(
      <StatusPage
        features={{
          ...liveFeatures,
          mode: 'deterministic',
          environment: 'local',
          payments: true,
          refunds: true,
          withdrawals: true,
        }}
      />,
    );

    expect(screen.getByText('Configured product features enabled')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Checkout is enabled' })).toBeVisible();
    expect(screen.getByText(/6 of 6 customer and merchant capabilities are enabled/)).toBeVisible();
  });
});
