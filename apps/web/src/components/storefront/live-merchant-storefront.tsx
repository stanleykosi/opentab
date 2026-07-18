'use client';

import { EmptyState } from '@opentab/ui';
import { useEffect, useMemo, useState } from 'react';
import { BrowserApiClient, BrowserApiError } from '../../application/browser-api-client';
import { mapMerchantProduct } from '../../application/live-merchant-mappers';
import type { MerchantDashboardView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { MerchantIdentity, ProductCard } from './storefront';

type State =
  | { status: 'loading' }
  | { status: 'ready'; dashboard: MerchantDashboardView }
  | { status: 'error'; message: string; reference?: string };

export function LiveMerchantStorefront({
  client: providedClient,
  merchantSlug,
}: {
  client?: BrowserApiClient;
  merchantSlug: string;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void client
      .getMerchantCatalog(merchantSlug)
      .then((catalog) => {
        if (!active) return;
        const monogram = catalog.merchant.displayName
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part.slice(0, 1).toUpperCase())
          .join('');
        const supportContact = catalog.merchant.supportContact?.trim();
        setState({
          status: 'ready',
          dashboard: {
            merchant: {
              id: catalog.merchant.id,
              slug: catalog.merchant.slug,
              displayName: catalog.merchant.displayName,
              monogram,
              ...(supportContact === undefined || supportContact.length === 0
                ? {}
                : { supportContact }),
              verified: catalog.merchant.status === 'active',
            },
            grossBaseUnits: '0',
            refundedBaseUnits: '0',
            pendingBaseUnits: '0',
            withdrawableBaseUnits: '0',
            withdrawnBaseUnits: '0',
            loyaltyMembers: '0',
            freshness: { state: 'fresh', checkedAt: catalog.observedAt },
            products: catalog.products.map((product) =>
              mapMerchantProduct(product, catalog.merchant.slug),
            ),
            orders: [],
            salesSeries: [],
          },
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof BrowserApiError && error.status === 404
              ? 'This merchant storefront is not available.'
              : 'OpenTab could not load this storefront.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [client, merchantSlug]);

  if (state.status === 'loading') return <PageSkeleton label="Loading merchant storefront" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Storefront unavailable"
      />
    );
  }
  const activeProducts = state.dashboard.products.filter((product) => product.status === 'active');
  return (
    <div className="storefront-page">
      <MerchantIdentity dashboard={state.dashboard} />
      <section>
        <div className="section-heading">
          <p className="eyebrow">Open tabs</p>
          <h2>Current offers</h2>
        </div>
        {activeProducts.length === 0 ? (
          <EmptyState
            body="This merchant does not have an active offer right now. Check back after they publish their next offer."
            title="No offers available"
          />
        ) : (
          <div className="product-grid">
            {activeProducts.map((product) => (
              <ProductCard dashboardProduct={product} key={product.id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
