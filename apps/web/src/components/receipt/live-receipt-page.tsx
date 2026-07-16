'use client';

import { useEffect, useMemo, useState } from 'react';
import { BrowserApiClient, BrowserApiError } from '../../application/browser-api-client';
import { mapOrderSnapshotToReceipt } from '../../application/live-merchant-mappers';
import type { FrontendFeatureState, ReceiptView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { ReceiptPageView } from './receipt-view';

type State =
  | { status: 'loading' }
  | { status: 'ready'; receipt: ReceiptView }
  | { status: 'error'; message: string; reference?: string };

function isSettled(receipt: ReceiptView): boolean {
  return ['paid', 'partially_refunded', 'refunded', 'investigation'].includes(receipt.status);
}

export function LiveReceiptPage({
  client: providedClient,
  features,
  orderId,
}: {
  client?: BrowserApiClient;
  features: FrontendFeatureState;
  orderId: string;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshPending = false;
    const scheduleRefresh = () => {
      refreshPending = true;
      timer = setTimeout(
        () => {
          timer = undefined;
          if (document.visibilityState === 'visible') void load(true);
          else scheduleRefresh();
        },
        document.visibilityState === 'visible' ? 5_000 : 30_000,
      );
    };
    const load = async (refresh: boolean) => {
      refreshPending = false;
      try {
        if (!refresh) await client.restoreSession();
        const snapshot = await client.getReceipt(orderId);
        if (!active) return;
        const receipt = mapOrderSnapshotToReceipt(snapshot, window.location.origin);
        setState({ status: 'ready', receipt });
        if (!isSettled(receipt)) scheduleRefresh();
      } catch (error) {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof BrowserApiError && error.code === 'AUTH_REQUIRED'
              ? 'Sign in with the account that made this purchase.'
              : error instanceof BrowserApiError && error.status === 404
                ? 'This receipt is not available to the signed-in account.'
                : 'OpenTab could not load the authoritative receipt. No payment was submitted.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      }
    };
    const resumeWhenVisible = () => {
      if (!active || !refreshPending || document.visibilityState !== 'visible') return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      void load(true);
    };
    document.addEventListener('visibilitychange', resumeWhenVisible);
    void load(false);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', resumeWhenVisible);
    };
  }, [client, orderId]);

  if (state.status === 'loading') return <PageSkeleton label="Loading receipt" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Receipt unavailable"
      />
    );
  }
  return <ReceiptPageView features={features} receipt={state.receipt} />;
}
