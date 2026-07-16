'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BrowserApiClient,
  BrowserApiError,
  type ContractOperationRecord,
} from '../../application/browser-api-client';
import type { BrowserApplicationService } from '../../application/browser-application-service';
import { mapMerchantProduct } from '../../application/live-merchant-mappers';
import type { MerchantProductView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { useBoundOperation } from '../use-bound-operation';
import { ProductDetail, type ProductEditInput } from './details';

type State =
  | { status: 'loading' }
  | {
      status: 'ready';
      product: MerchantProductView;
      chainSyncStatus:
        | 'not_required'
        | 'pending'
        | 'submitted'
        | 'confirmed'
        | 'mismatch'
        | 'failed';
      latestOperation?: ContractOperationRecord;
      merchantSlug: string;
      optimisticVersion: string;
    }
  | { status: 'error'; message: string; reference?: string };

export function LiveProductDetail({
  client: providedClient,
  productId,
  service,
}: {
  client?: BrowserApiClient;
  productId: string;
  service?: BrowserApplicationService;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const operation = useBoundOperation(service);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.restoreSession(),
      client.getMerchantProfile(),
      client.getMerchantProduct(productId),
    ])
      .then(([, profile, record]) => {
        if (active) {
          if (record.operation !== undefined) operation.adopt(record.operation);
          setState({
            status: 'ready',
            product: mapMerchantProduct(record.product, profile.merchant.slug),
            merchantSlug: profile.merchant.slug,
            chainSyncStatus: record.chainSyncStatus,
            optimisticVersion: record.optimisticVersion,
            ...(record.operation === undefined ? {} : { latestOperation: record.operation }),
          });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof BrowserApiError && error.status === 404
              ? 'This product is not available to this merchant.'
              : 'OpenTab could not load this product. No product action was submitted.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [client, operation.adopt, productId]);

  if (state.status === 'loading') return <PageSkeleton label="Loading product" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Product unavailable"
      />
    );
  }
  return (
    <ProductDetail
      changeStatus={async (action) => {
        const result = await client.changeMerchantProductStatus(
          productId,
          action,
          `web.product-status.${crypto.randomUUID()}`,
        );
        setState((current) =>
          current.status !== 'ready' ? current : { ...current, latestOperation: result.operation },
        );
        await operation.prepare(result.operation);
      }}
      chainSyncStatus={state.chainSyncStatus}
      operation={operation}
      product={state.product}
      resumeOperation={async () => {
        if (state.latestOperation === undefined) return;
        await operation.prepare(state.latestOperation);
      }}
      shareOrigin={window.location.origin}
      updateProduct={async (input: ProductEditInput) => {
        const result = await client.updateMerchantProduct(
          productId,
          { expectedVersion: state.optimisticVersion, ...input },
          `web.product-update.${crypto.randomUUID()}`,
        );
        setState((current) =>
          current.status !== 'ready'
            ? current
            : {
                ...current,
                product: mapMerchantProduct(result.product, current.merchantSlug),
                optimisticVersion: result.optimisticVersion,
                latestOperation: result.operation,
              },
        );
        await operation.prepare(result.operation);
      }}
    />
  );
}
