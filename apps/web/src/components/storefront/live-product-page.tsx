'use client';

import { useEffect, useState } from 'react';
import { mapPublicProductToView } from '../../application/live-view-mappers';
import {
  BrowserApiError,
  getPublicSessionApplicationService,
  type PublicProductRecord,
  type PublicSessionApplicationService,
} from '../../application/public-session-api-client';
import { ErrorState, PageSkeleton } from '../states';
import { ProductPageView } from './storefront';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; record: PublicProductRecord; allowedMediaOrigins: readonly string[] }
  | { status: 'error'; message: string; reference?: string };

export function LiveProductPage({
  merchantSlug,
  paymentsEnabled,
  productSlug,
  service = getPublicSessionApplicationService(),
}: {
  merchantSlug: string;
  paymentsEnabled: boolean;
  productSlug: string;
  service?: Pick<PublicSessionApplicationService, 'getPublicMediaOrigins' | 'getPublicProduct'>;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void Promise.all([
      service.getPublicProduct(merchantSlug, productSlug),
      service.getPublicMediaOrigins(),
    ])
      .then(([record, allowedMediaOrigins]) => {
        if (active) setState({ status: 'ready', record, allowedMediaOrigins });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof BrowserApiError && error.status === 404
              ? 'This offer is no longer available.'
              : error instanceof Error
                ? error.message
                : 'OpenTab could not load this offer.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [merchantSlug, productSlug, service]);

  if (state.status === 'loading') return <PageSkeleton label="Loading verified offer" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={`${state.message} No checkout or payment was started.`}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Offer unavailable"
      />
    );
  }
  return (
    <ProductPageView
      mode="live"
      paymentsEnabled={paymentsEnabled}
      product={mapPublicProductToView(state.record, {
        origin: window.location.origin,
        allowedMediaOrigins: state.allowedMediaOrigins,
      })}
    />
  );
}
