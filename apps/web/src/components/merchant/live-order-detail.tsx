'use client';

import { useEffect, useMemo, useState } from 'react';
import { BrowserApiClient, BrowserApiError } from '../../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../../application/browser-application-service';
import { mapOrderSnapshotToMerchantOrder } from '../../application/live-merchant-mappers';
import type { FrontendFeatureState, MerchantOrderView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { OrderDetail } from './details';
import type { RecoverableFinancialFlow } from './finance-flows';

type State =
  | { status: 'loading' }
  | {
      status: 'ready';
      order: MerchantOrderView;
      initialRefund?: RecoverableFinancialFlow;
      refundOperation?: Awaited<ReturnType<BrowserApplicationService['getContractOperation']>>;
    }
  | { status: 'error'; message: string; reference?: string };

export function LiveOrderDetail({
  client: providedClient,
  features,
  orderId,
  service = getBrowserApplicationService(),
}: {
  client?: BrowserApiClient;
  features: FrontendFeatureState;
  orderId: string;
  service?: Pick<
    BrowserApplicationService,
    'getContractOperation' | 'prepareContractOperation' | 'submitContractOperation'
  >;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void client
      .restoreSession()
      .then(() => client.getOrder(orderId))
      .then((record) => {
        if (active) {
          setState({
            status: 'ready',
            order: mapOrderSnapshotToMerchantOrder(record),
            ...(record.pendingRefund === undefined || record.refundOperation === undefined
              ? {}
              : {
                  initialRefund: {
                    id: record.refundOperation.id,
                    amountBaseUnits: record.pendingRefund.amountBaseUnits,
                    status: financialResult(record.refundOperation).status,
                  },
                  refundOperation: record.refundOperation,
                }),
          });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof BrowserApiError && error.status === 404
              ? 'This order is not available to the signed-in merchant.'
              : 'OpenTab could not load the authoritative order record.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [client, orderId]);

  if (state.status === 'loading') return <PageSkeleton label="Loading order" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Order unavailable"
      />
    );
  }
  return (
    <OrderDetail
      features={features}
      {...(state.initialRefund === undefined ? {} : { initialRefund: state.initialRefund })}
      order={state.order}
      refundActions={{
        async prepare(amountBaseUnits) {
          const resumable =
            state.refundOperation?.status === 'prepared' &&
            state.initialRefund?.amountBaseUnits === amountBaseUnits
              ? state.refundOperation
              : undefined;
          const operation =
            resumable ??
            (
              await client.prepareRefund(
                orderId,
                amountBaseUnits,
                `web.refund-prepare.${crypto.randomUUID()}`,
              )
            ).operation;
          const prepared = await service.prepareContractOperation(operation);
          return {
            id: prepared.operation.id,
            estimatedFeeUsd: prepared.plan.quote.estimatedFeeUsd,
            maximumTotalUsd: prepared.plan.quote.totalUsd,
          };
        },
        async submit(id) {
          const result = await service.submitContractOperation(id);
          return financialResult(result.operation);
        },
        async getStatus(id) {
          return financialResult(await service.getContractOperation(id));
        },
      }}
    />
  );
}

function financialResult(
  operation: Awaited<ReturnType<BrowserApplicationService['getContractOperation']>>,
) {
  return {
    id: operation.id,
    status:
      operation.status === 'confirmed'
        ? ('confirmed' as const)
        : operation.status === 'failed' || operation.status === 'orphaned'
          ? ('failed' as const)
          : operation.status === 'submitted_unknown' || operation.status === 'submission_started'
            ? ('submitted_unknown' as const)
            : operation.status === 'prepared'
              ? ('prepared' as const)
              : operation.status === 'confirming'
                ? ('confirming' as const)
                : ('submitted' as const),
  };
}
