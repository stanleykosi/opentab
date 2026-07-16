'use client';

import { useEffect, useMemo, useState } from 'react';
import { BrowserApiClient, BrowserApiError } from '../../application/browser-api-client';
import type { BrowserApplicationService } from '../../application/browser-application-service';
import { ErrorState, PageSkeleton } from '../states';
import { useBoundOperation } from '../use-bound-operation';
import { ProductForm } from './product-form';

type State =
  | { status: 'loading' }
  | { status: 'ready'; merchantId: string; merchantSlug: string }
  | { status: 'error'; message: string; reference?: string };

export function LiveProductForm({
  client: providedClient,
  service,
}: {
  client?: BrowserApiClient;
  service?: BrowserApplicationService;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const operation = useBoundOperation(service);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void client
      .restoreSession()
      .then(() => client.getMerchantProfile())
      .then(({ merchant }) => {
        if (active) {
          setState({ status: 'ready', merchantId: merchant.id, merchantSlug: merchant.slug });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof BrowserApiError && error.status === 404
              ? 'Create and activate a merchant profile before adding products.'
              : 'OpenTab could not verify this merchant session.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [client]);

  if (state.status === 'loading') return <PageSkeleton label="Loading product editor" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Product editor unavailable"
      />
    );
  }
  return (
    <ProductForm
      createProduct={async (input) => {
        const created = await client.createMerchantProduct(
          {
            merchantId: state.merchantId,
            ...input,
          },
          `web.product-create.${crypto.randomUUID()}`,
        );
        const preview = await operation.prepare(created.operation);
        if (preview === undefined) {
          throw new BrowserApiError({
            code: 'RESPONSE_INVALID',
            message: 'The exact product approval could not be prepared.',
            status: 0,
          });
        }
        return {
          id: created.product.id,
          slug: created.product.slug,
          status: created.product.status,
          operationId: created.operation.id,
          estimatedFeeUsd: preview.estimatedFeeUsd,
          maximumTotalUsd: preview.maximumTotalUsd,
        };
      }}
      merchantSlug={state.merchantSlug}
      mode="live"
      submitProduct={async (operationId) => {
        if (operation.operation?.id !== operationId) {
          throw new BrowserApiError({
            code: 'PAYMENT_PREVIEW_RELOAD_REQUIRED',
            message: 'The product approval changed. Reopen the product to recover safely.',
            retryable: true,
            status: 0,
          });
        }
        const result = await operation.submit();
        if (result === undefined) {
          throw new BrowserApiError({
            code: 'PAYMENT_PREVIEW_RELOAD_REQUIRED',
            message: 'The exact product approval is no longer held in this tab.',
            retryable: true,
            status: 0,
          });
        }
        return {
          id: result.operation.aggregateId,
          slug: '',
          status: result.operation.status,
        };
      }}
    />
  );
}
