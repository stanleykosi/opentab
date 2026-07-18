'use client';

import { LinkButton } from '@opentab/ui';
import { useEffect, useMemo, useState } from 'react';
import { BrowserApiClient, BrowserApiError } from '../../application/browser-api-client';
import { mapMerchantDashboard } from '../../application/live-merchant-mappers';
import type { MerchantDashboardView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { MerchantDashboard, MerchantOrders, MerchantProducts } from './dashboard';

type View = 'dashboard' | 'orders' | 'products';
type State =
  | { status: 'loading' }
  | { status: 'ready'; dashboard: MerchantDashboardView }
  | { status: 'error'; message: string; reference?: string; merchantMissing?: boolean };

export function LiveMerchantConsole({
  client: providedClient,
  view,
}: {
  client?: BrowserApiClient;
  view: View;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.getMerchantSummary(),
      client.listMerchantOrders(),
      client.listMerchantProducts(),
    ])
      .then(([summary, orders, products]) => {
        if (active)
          setState({
            status: 'ready',
            dashboard: mapMerchantDashboard({ summary, orders, products }),
          });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof BrowserApiError && error.status === 404
              ? 'Create and activate a merchant profile before opening the merchant console.'
              : error instanceof BrowserApiError && error.code === 'AUTH_REQUIRED'
                ? 'Sign in with the merchant account that owns this storefront.'
                : 'OpenTab could not load the merchant records. No financial action was started.',
          ...(error instanceof BrowserApiError && error.status === 404
            ? { merchantMissing: true }
            : {}),
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [client]);

  if (state.status === 'loading') return <PageSkeleton label="Loading merchant records" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        {...(state.merchantMissing
          ? {
              action: <LinkButton href="/merchant/onboarding">Create merchant profile</LinkButton>,
            }
          : {})}
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Merchant console unavailable"
      />
    );
  }
  if (view === 'orders') return <MerchantOrders dashboard={state.dashboard} />;
  if (view === 'products') return <MerchantProducts dashboard={state.dashboard} />;
  return <MerchantDashboard dashboard={state.dashboard} />;
}
