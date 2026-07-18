'use client';

import { MoneyAmount } from '@opentab/ui';
import { useEffect, useMemo, useState } from 'react';
import { BrowserApiClient, BrowserApiError } from '../../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../../application/browser-application-service';
import { mapMerchantDashboard } from '../../application/live-merchant-mappers';
import type { FrontendFeatureState, MerchantDashboardView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { type RecoverableFinancialFlow, WithdrawalFlow } from './finance-flows';

type State =
  | { status: 'loading' }
  | {
      status: 'ready';
      dashboard: MerchantDashboardView;
      initialWithdrawal?: RecoverableFinancialFlow;
      withdrawalOperation?: Awaited<ReturnType<BrowserApplicationService['getContractOperation']>>;
    }
  | { status: 'error'; message: string; reference?: string };

export function LiveBalancePage({
  client: providedClient,
  features,
  service = getBrowserApplicationService(),
}: {
  client?: BrowserApiClient;
  features: FrontendFeatureState;
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
      .then(() => Promise.all([client.getMerchantSummary(), client.getMerchantSettlement()]))
      .then(([summary, settlement]) => {
        if (!active) return;
        const dashboard = mapMerchantDashboard({
          summary: {
            ...summary,
            grossBaseUnits: settlement.grossBaseUnits,
            withdrawableBaseUnits: settlement.availableBaseUnits,
            withdrawnBaseUnits: settlement.withdrawnBaseUnits,
            observedAt: settlement.observedAt,
          },
          orders: { items: [], requestId: settlement.requestId },
          products: { items: [], requestId: settlement.requestId },
        });
        setState({
          status: 'ready',
          dashboard,
          ...(settlement.pendingWithdrawal === undefined ||
          settlement.withdrawalOperation === undefined
            ? {}
            : {
                initialWithdrawal: {
                  id: settlement.withdrawalOperation.id,
                  amountBaseUnits: settlement.pendingWithdrawal.amountBaseUnits,
                  status: financialResult(settlement.withdrawalOperation).status,
                },
                withdrawalOperation: settlement.withdrawalOperation,
              }),
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message: 'OpenTab could not load fresh settlement records. Withdrawals remain disabled.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [client]);

  if (state.status === 'loading') return <PageSkeleton label="Loading settlement balance" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Balance unavailable"
      />
    );
  }
  const { dashboard } = state;
  return (
    <div className="merchant-content merchant-content--narrow">
      <header className="merchant-page-head">
        <div>
          <p className="eyebrow">Settlement balance</p>
          <h1>Available and protected</h1>
          <p>Confirmed proceeds remain separate from refundable and pending liabilities.</p>
        </div>
      </header>
      <section className="balance-equation">
        <div>
          <span>Settled gross</span>
          <MoneyAmount baseUnits={dashboard.grossBaseUnits} />
        </div>
        <i aria-hidden="true">−</i>
        <div>
          <span>Confirmed refunds</span>
          <MoneyAmount baseUnits={dashboard.refundedBaseUnits} />
        </div>
        <i aria-hidden="true">−</i>
        <div>
          <span>Pending and reserved</span>
          <MoneyAmount baseUnits={dashboard.pendingBaseUnits} />
        </div>
        <i aria-hidden="true">=</i>
        <div className="balance-equation__result">
          <span>Available now</span>
          <MoneyAmount baseUnits={dashboard.withdrawableBaseUnits} />
        </div>
      </section>
      <WithdrawalFlow
        dashboard={dashboard}
        features={features}
        {...(state.initialWithdrawal === undefined
          ? {}
          : { initialResult: state.initialWithdrawal })}
        liveActions={{
          async prepare(amountBaseUnits) {
            const resumable =
              state.withdrawalOperation?.status === 'prepared' &&
              state.initialWithdrawal?.amountBaseUnits === amountBaseUnits
                ? state.withdrawalOperation
                : undefined;
            const operation =
              resumable ??
              (
                await client.prepareWithdrawal(
                  dashboard.merchant.id,
                  amountBaseUnits,
                  `web.withdrawal-prepare.${crypto.randomUUID()}`,
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
      <section className="order-ledger">
        <h2>Withdrawal history</h2>
        <p>No withdrawal is labeled complete until its settlement event is confirmed.</p>
        <dl className="summary-ledger">
          <div>
            <dt>Previously withdrawn</dt>
            <dd>
              <MoneyAmount baseUnits={dashboard.withdrawnBaseUnits} />
            </dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{dashboard.freshness.checkedAt}</dd>
          </div>
        </dl>
      </section>
    </div>
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
