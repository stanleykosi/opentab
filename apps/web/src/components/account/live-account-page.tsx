'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BrowserApiClient,
  BrowserApiError,
  type CustomerOrderListResponse,
} from '../../application/browser-api-client';
import { mapCustomerOrder } from '../../application/live-merchant-mappers';
import type { CustomerOrderView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { LiveAccountOrdersView, LiveAccountOverviewView } from './account-view';

type OverviewState =
  | { status: 'loading' }
  | {
      status: 'ready';
      orders: readonly CustomerOrderView[];
      walletAddress: string;
      loyalty?: { points: string; label: string };
    }
  | { status: 'error'; message: string; reference?: string };

type OrdersState =
  | { status: 'loading' }
  | {
      status: 'ready';
      orders: readonly CustomerOrderView[];
      nextCursor?: string;
      loadingMore: boolean;
      loadError?: string;
    }
  | { status: 'error'; message: string; reference?: string };

function errorState(error: unknown, resource: string) {
  if (error instanceof BrowserApiError) {
    return {
      status: 'error' as const,
      message: error.code === 'AUTH_REQUIRED' ? `Sign in to view your ${resource}.` : error.message,
      ...(error.requestId === undefined ? {} : { reference: error.requestId }),
    };
  }
  return {
    status: 'error' as const,
    message: `OpenTab could not load your ${resource}. No account action was started.`,
  };
}

function loyaltySummary(
  response: Awaited<ReturnType<BrowserApiClient['getLoyaltyStatus']>>,
): { points: string; label: string } | undefined {
  const first = response.balances[0];
  if (first === undefined) return undefined;
  const program = response.programs.find((entry) => entry.id === first.programId);
  return { points: first.points, label: program?.name ?? 'Loyalty rewards' };
}

export function LiveAccountOverview({ client: providedClient }: { client?: BrowserApiClient }) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<OverviewState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void client
      .restoreSession()
      .then(async (session) => {
        const [orders, loyalty] = await Promise.all([
          client.listCustomerOrders(),
          client.getLoyaltyStatus().catch((error: unknown) => {
            if (error instanceof BrowserApiError && error.code === 'FEATURE_DISABLED') {
              return undefined;
            }
            throw error;
          }),
        ]);
        if (!active) return;
        const summary = loyalty === undefined ? undefined : loyaltySummary(loyalty);
        setState({
          status: 'ready',
          orders: orders.items.map(mapCustomerOrder),
          walletAddress: session.user.walletAddress,
          ...(summary === undefined ? {} : { loyalty: summary }),
        });
      })
      .catch((error: unknown) => {
        if (active) setState(errorState(error, 'account'));
      });
    return () => {
      active = false;
    };
  }, [client]);

  if (state.status === 'loading') return <PageSkeleton label="Loading your account" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Account unavailable"
      />
    );
  }
  return (
    <LiveAccountOverviewView
      loyalty={state.loyalty}
      orders={state.orders}
      walletAddress={state.walletAddress}
    />
  );
}

export function LiveAccountOrders({ client: providedClient }: { client?: BrowserApiClient }) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<OrdersState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void client
      .restoreSession()
      .then(() => client.listCustomerOrders())
      .then((response) => {
        if (!active) return;
        setState({
          status: 'ready',
          orders: response.items.map(mapCustomerOrder),
          loadingMore: false,
          ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        });
      })
      .catch((error: unknown) => {
        if (active) setState(errorState(error, 'orders'));
      });
    return () => {
      active = false;
    };
  }, [client]);

  const loadMore = async () => {
    if (state.status !== 'ready' || state.nextCursor === undefined || state.loadingMore) return;
    const previous = state;
    setState({
      status: 'ready',
      orders: state.orders,
      nextCursor: state.nextCursor,
      loadingMore: true,
    });
    try {
      const response: CustomerOrderListResponse = await client.listCustomerOrders(state.nextCursor);
      setState({
        status: 'ready',
        orders: [...state.orders, ...response.items.map(mapCustomerOrder)],
        loadingMore: false,
        ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
      });
    } catch (error) {
      setState({
        ...previous,
        loadError:
          error instanceof BrowserApiError ? error.message : 'More orders could not be loaded.',
      });
    }
  };

  if (state.status === 'loading') return <PageSkeleton label="Loading your orders" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Order history unavailable"
      />
    );
  }
  return (
    <LiveAccountOrdersView
      hasMore={state.nextCursor !== undefined}
      {...(state.loadError === undefined ? {} : { loadError: state.loadError })}
      loadingMore={state.loadingMore}
      onLoadMore={() => void loadMore()}
      orders={state.orders}
    />
  );
}
