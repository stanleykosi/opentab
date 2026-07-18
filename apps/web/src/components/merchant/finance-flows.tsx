'use client';

import {
  Button,
  CanonicalStatus,
  decimalToBaseUnits,
  InlineAlert,
  MoneyAmount,
  ProgressTimeline,
  TextField,
} from '@opentab/ui';
import { useEffect, useMemo, useState } from 'react';
import type {
  FrontendFeatureState,
  MerchantDashboardView,
  MerchantOrderView,
} from '../../client/view-models';

type MoneyWorkflowState =
  | 'idle'
  | 'preparing'
  | 'review'
  | 'submitting'
  | 'submitted_unknown'
  | 'confirming'
  | 'confirmed'
  | 'failed';

export interface FinancialFlowResult {
  id: string;
  status: 'prepared' | 'submitted' | 'submitted_unknown' | 'confirming' | 'confirmed' | 'failed';
}

export interface RecoverableFinancialFlow extends FinancialFlowResult {
  amountBaseUnits: string;
}

export interface FinancialFlowPreview {
  id: string;
  estimatedFeeUsd: string;
  maximumTotalUsd: string;
}

export interface FinancialFlowActions {
  prepare(amountBaseUnits: string): Promise<FinancialFlowPreview>;
  submit(id: string): Promise<FinancialFlowResult>;
  getStatus(id: string): Promise<FinancialFlowResult>;
}

function workflowState(status: FinancialFlowResult['status']): MoneyWorkflowState {
  return status === 'prepared'
    ? 'idle'
    : status === 'submitted'
      ? 'confirming'
      : status === 'submitted_unknown'
        ? 'submitted_unknown'
        : status;
}

function baseUnitsToInput(value: string): string {
  const normalized = value.padStart(7, '0');
  const whole = normalized.slice(0, -6);
  const fraction = normalized.slice(-6).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function maskedPayoutAddress(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function RefundFlow({
  features,
  initialResult,
  liveActions,
  order,
}: {
  features: FrontendFeatureState;
  initialResult?: RecoverableFinancialFlow;
  liveActions?: FinancialFlowActions;
  order: MerchantOrderView;
}) {
  const paidBaseUnits = order.paidBaseUnits ?? order.amountBaseUnits;
  const refundedBaseUnits = order.refundedBaseUnits ?? '0';
  const refundableBaseUnits = (
    BigInt(paidBaseUnits) > BigInt(refundedBaseUnits)
      ? BigInt(paidBaseUnits) - BigInt(refundedBaseUnits)
      : 0n
  ).toString();
  const [amount, setAmount] = useState(
    initialResult === undefined
      ? (BigInt(refundableBaseUnits) / 1000000n).toString()
      : baseUnitsToInput(initialResult.amountBaseUnits),
  );
  const [state, setState] = useState<MoneyWorkflowState>(
    initialResult === undefined ? 'idle' : workflowState(initialResult.status),
  );
  const [reference, setReference] = useState<string | undefined>(initialResult?.id);
  const [preview, setPreview] = useState<FinancialFlowPreview>();
  const [error, setError] = useState<string>();
  const [observedNow, setObservedNow] = useState<number>();
  useEffect(() => setObservedNow(Date.now()), []);
  const amountBaseUnits = useMemo(() => {
    try {
      return decimalToBaseUnits(amount);
    } catch {
      return undefined;
    }
  }, [amount]);
  const valid =
    amountBaseUnits !== undefined &&
    BigInt(amountBaseUnits) > 0n &&
    BigInt(amountBaseUnits) <= BigInt(refundableBaseUnits);
  const refundWindowOpen =
    order.refundableUntil === undefined ||
    (observedNow !== undefined && new Date(order.refundableUntil).getTime() >= observedNow);
  const refundableOrder =
    ['paid', 'partially_refunded'].includes(order.status) &&
    BigInt(refundableBaseUnits) > 0n &&
    refundWindowOpen;
  const enabled =
    features.refunds &&
    refundableOrder &&
    (features.mode === 'deterministic' || (features.mode === 'live' && liveActions !== undefined));

  const prepare = async () => {
    if (amountBaseUnits === undefined) return;
    if (features.mode !== 'live') {
      setState('review');
      return;
    }
    if (liveActions === undefined) return;
    setState('preparing');
    setError(undefined);
    try {
      const result = await liveActions.prepare(amountBaseUnits);
      setReference(result.id);
      setPreview(result);
      setState('review');
    } catch (caught) {
      setError(safeMessage(caught, 'The refund could not be prepared.'));
      setState('failed');
    }
  };

  const submit = async () => {
    if (amountBaseUnits === undefined) return;
    if (features.mode !== 'live') {
      setState('submitting');
      window.setTimeout(() => setState('confirming'), 600);
      window.setTimeout(() => setState('confirmed'), 1500);
      return;
    }
    if (liveActions === undefined || reference === undefined) return;
    setState('submitting');
    setError(undefined);
    try {
      const result = await liveActions.submit(reference);
      setState(workflowState(result.status));
    } catch (caught) {
      const possiblySubmitted =
        typeof caught === 'object' &&
        caught !== null &&
        'submissionPossible' in caught &&
        caught.submissionPossible === true;
      setError(safeMessage(caught, 'The refund could not be submitted.'));
      setState(possiblySubmitted ? 'submitted_unknown' : 'failed');
    }
  };

  const checkStatus = async () => {
    if (liveActions === undefined || reference === undefined) return;
    try {
      const result = await liveActions.getStatus(reference);
      setState(workflowState(result.status));
      setError(undefined);
    } catch (caught) {
      setError(safeMessage(caught, 'Refund status is temporarily unavailable.'));
    }
  };

  if (state === 'confirmed' && amountBaseUnits) {
    const full = amountBaseUnits === refundableBaseUnits;
    return (
      <section className="money-flow">
        <CanonicalStatus label={full ? 'Refunded' : 'Partially refunded'} tone="refunded" />
        <h2>Refund confirmed</h2>
        <p>
          The confirmed refund event records <MoneyAmount baseUnits={amountBaseUnits} /> returned.
          The original receipt remains visible with its updated status.
        </p>
      </section>
    );
  }
  if (state === 'submitted_unknown' || state === 'confirming' || state === 'submitting') {
    return (
      <section className="money-flow">
        <h2>
          {state === 'submitted_unknown'
            ? 'We’re confirming the refund'
            : state === 'submitting'
              ? 'Submitting refund'
              : 'Confirming refund'}
        </h2>
        {state === 'submitted_unknown' ? (
          <InlineAlert title="Do not issue another refund" tone="warning">
            <p>The refund may have moved. OpenTab is reconciling it before updating the order.</p>
          </InlineAlert>
        ) : null}
        <ProgressTimeline
          label="Refund progress"
          items={[
            { id: 'approved', label: 'Refund approved', status: 'complete' },
            {
              id: 'submit',
              label: 'Submitting refund',
              status: state === 'submitting' ? 'current' : 'complete',
            },
            {
              id: 'confirm',
              label: 'Confirming refund event',
              status:
                state === 'confirming'
                  ? 'current'
                  : state === 'submitted_unknown'
                    ? 'attention'
                    : 'upcoming',
            },
          ]}
        />
        {error === undefined ? null : (
          <InlineAlert title="Refund status unavailable" tone="warning">
            <p>{error}</p>
          </InlineAlert>
        )}
        {state === 'submitted_unknown' || (state === 'confirming' && features.mode === 'live') ? (
          <Button
            disabled={reference === undefined}
            onClick={() => void checkStatus()}
            variant="secondary"
          >
            Check status
          </Button>
        ) : null}
      </section>
    );
  }
  return (
    <section className="money-flow">
      <p className="eyebrow">Refund</p>
      <h2>Return funds from this order</h2>
      <p>
        Available refundable amount: <MoneyAmount baseUnits={refundableBaseUnits} />. The contract
        remains the final accounting guard.
      </p>
      {!features.refunds ? (
        <InlineAlert title="Refunds are currently disabled" tone="warning">
          <p>No refund can be prepared until the operator enables this feature.</p>
        </InlineAlert>
      ) : null}
      {features.refunds && !refundableOrder ? (
        <InlineAlert title="This order is not refundable" tone="warning">
          <p>
            The remaining amount is zero, the refund window closed, or the order is not in a
            confirmed refundable state.
          </p>
        </InlineAlert>
      ) : null}
      {features.mode === 'live' && liveActions === undefined ? (
        <InlineAlert title="Secure refund submission is being prepared" tone="info">
          <p>
            Refund review is visible, but submission stays disabled until the server provides an
            exact bound contract call. OpenTab will never construct refund calldata in this page.
          </p>
        </InlineAlert>
      ) : null}
      <TextField
        description="Exact USDC amount, up to the remaining refundable balance."
        disabled={!enabled || state === 'review'}
        inputMode="decimal"
        label="Refund amount"
        onChange={(event) => setAmount(event.currentTarget.value)}
        value={amount}
        {...(amountBaseUnits !== undefined && !valid
          ? { error: 'Amount exceeds the refundable balance or is zero.' }
          : {})}
      />
      {state === 'review' && amountBaseUnits ? (
        <>
          <InlineAlert title="Confirm exact refund" tone="warning">
            <p>
              Refund <MoneyAmount baseUnits={amountBaseUnits} /> to this order’s payer. This cannot
              be undone after confirmed execution.
            </p>
          </InlineAlert>
          {preview === undefined ? null : (
            <dl className="payment-ledger">
              <div>
                <dt>Estimated payment cost</dt>
                <dd>${preview.estimatedFeeUsd}</dd>
              </div>
              <div className="payment-ledger__total">
                <dt>Maximum total</dt>
                <dd>${preview.maximumTotalUsd}</dd>
              </div>
            </dl>
          )}
        </>
      ) : null}
      {state === 'failed' && error !== undefined ? (
        <InlineAlert title="Refund not submitted" tone="danger">
          <p>{error}</p>
        </InlineAlert>
      ) : null}
      <div className="page-actions">
        {state === 'review' ? (
          <>
            <Button onClick={() => void submit()}>
              Confirm refund of <MoneyAmount baseUnits={amountBaseUnits ?? '0'} />
            </Button>
            <Button onClick={() => setState('idle')} variant="quiet">
              Back
            </Button>
          </>
        ) : (
          <Button
            disabled={!enabled || !valid}
            loading={state === 'preparing'}
            loadingLabel="Preparing exact refund"
            onClick={() => void prepare()}
            variant="secondary"
          >
            Review refund
          </Button>
        )}
      </div>
    </section>
  );
}

export function WithdrawalFlow({
  dashboard,
  features,
  initialResult,
  liveActions,
}: {
  dashboard: MerchantDashboardView;
  features: FrontendFeatureState;
  initialResult?: RecoverableFinancialFlow;
  liveActions?: FinancialFlowActions;
}) {
  const initialAmount = (BigInt(dashboard.withdrawableBaseUnits) / 1000000n).toString();
  const [amount, setAmount] = useState(
    initialResult === undefined ? initialAmount : baseUnitsToInput(initialResult.amountBaseUnits),
  );
  const [state, setState] = useState<MoneyWorkflowState>(
    initialResult === undefined ? 'idle' : workflowState(initialResult.status),
  );
  const [reference, setReference] = useState<string | undefined>(initialResult?.id);
  const [preview, setPreview] = useState<FinancialFlowPreview>();
  const [error, setError] = useState<string>();
  const amountBaseUnits = useMemo(() => {
    try {
      return decimalToBaseUnits(amount);
    } catch {
      return undefined;
    }
  }, [amount]);
  const fresh = dashboard.freshness.state === 'fresh';
  const valid =
    amountBaseUnits !== undefined &&
    BigInt(amountBaseUnits) > 0n &&
    BigInt(amountBaseUnits) <= BigInt(dashboard.withdrawableBaseUnits);
  const enabled =
    features.withdrawals &&
    fresh &&
    (features.mode === 'deterministic' || (features.mode === 'live' && liveActions !== undefined));
  const payoutAddress = maskedPayoutAddress(dashboard.payoutAddress);

  const prepare = async () => {
    if (amountBaseUnits === undefined) return;
    if (features.mode !== 'live') {
      setState('review');
      return;
    }
    if (liveActions === undefined) return;
    setState('preparing');
    setError(undefined);
    try {
      const result = await liveActions.prepare(amountBaseUnits);
      setReference(result.id);
      setPreview(result);
      setState('review');
    } catch (caught) {
      setError(safeMessage(caught, 'The withdrawal could not be prepared.'));
      setState('failed');
    }
  };

  const submit = async () => {
    if (amountBaseUnits === undefined) return;
    if (features.mode !== 'live') {
      setState('submitting');
      window.setTimeout(() => setState('confirming'), 600);
      window.setTimeout(() => setState('confirmed'), 1500);
      return;
    }
    if (liveActions === undefined || reference === undefined) return;
    setState('submitting');
    setError(undefined);
    try {
      const result = await liveActions.submit(reference);
      setState(workflowState(result.status));
    } catch (caught) {
      const possiblySubmitted =
        typeof caught === 'object' &&
        caught !== null &&
        'submissionPossible' in caught &&
        caught.submissionPossible === true;
      setError(safeMessage(caught, 'The withdrawal could not be submitted.'));
      setState(possiblySubmitted ? 'submitted_unknown' : 'failed');
    }
  };

  const checkStatus = async () => {
    if (liveActions === undefined || reference === undefined) return;
    try {
      const result = await liveActions.getStatus(reference);
      setState(workflowState(result.status));
      setError(undefined);
    } catch (caught) {
      setError(safeMessage(caught, 'Withdrawal status is temporarily unavailable.'));
    }
  };

  if (state === 'confirmed' && amountBaseUnits)
    return (
      <section className="money-flow">
        <CanonicalStatus label="Withdrawal confirmed" tone="confirmed" />
        <h2>Funds sent</h2>
        <p>
          The confirmed withdrawal event records <MoneyAmount baseUnits={amountBaseUnits} /> sent to
          {payoutAddress === undefined
            ? ' the configured merchant payout destination.'
            : ` merchant payout ${payoutAddress}.`}
        </p>
      </section>
    );
  if (['submitting', 'submitted_unknown', 'confirming'].includes(state))
    return (
      <section className="money-flow">
        <h2>
          {state === 'submitted_unknown'
            ? 'We’re confirming the withdrawal'
            : state === 'submitting'
              ? 'Submitting withdrawal'
              : 'Confirming withdrawal'}
        </h2>
        {state === 'submitted_unknown' ? (
          <InlineAlert title="Do not withdraw again" tone="warning">
            <p>
              This withdrawal may have moved. Available balance remains locked while OpenTab
              reconciles it.
            </p>
          </InlineAlert>
        ) : null}
        <ProgressTimeline
          label="Withdrawal progress"
          items={[
            { id: 'approved', label: 'Withdrawal approved', status: 'complete' },
            {
              id: 'sent',
              label: 'Sending available funds',
              status: state === 'submitting' ? 'current' : 'complete',
            },
            {
              id: 'confirm',
              label: 'Confirming withdrawal event',
              status:
                state === 'confirming'
                  ? 'current'
                  : state === 'submitted_unknown'
                    ? 'attention'
                    : 'upcoming',
            },
          ]}
        />
        {error === undefined ? null : (
          <InlineAlert title="Withdrawal status unavailable" tone="warning">
            <p>{error}</p>
          </InlineAlert>
        )}
        {state === 'submitted_unknown' || (state === 'confirming' && features.mode === 'live') ? (
          <Button
            disabled={reference === undefined}
            onClick={() => void checkStatus()}
            variant="secondary"
          >
            Check status
          </Button>
        ) : null}
      </section>
    );
  return (
    <section className="money-flow">
      <p className="eyebrow">Withdraw available balance</p>
      <h2>Send confirmed proceeds</h2>
      {!features.withdrawals ? (
        <InlineAlert title="Withdrawals are currently disabled" tone="warning">
          <p>
            Your confirmed balance remains recorded. No withdrawal can start while the feature is
            off.
          </p>
        </InlineAlert>
      ) : null}
      {!fresh ? (
        <InlineAlert title="Fresh settlement data required" tone="warning">
          <p>Withdrawal stays disabled until the indexed balance agrees with confirmed records.</p>
        </InlineAlert>
      ) : null}
      {features.mode === 'live' && liveActions === undefined ? (
        <InlineAlert title="Secure withdrawal submission is being prepared" tone="info">
          <p>
            Withdrawal review stays disabled until the server provides an exact bound contract call.
            This page never guesses contract calldata.
          </p>
        </InlineAlert>
      ) : null}
      <TextField
        description="Cannot exceed the currently withdrawable balance."
        disabled={state === 'review' || !enabled}
        inputMode="decimal"
        label="Withdrawal amount"
        onChange={(event) => setAmount(event.currentTarget.value)}
        value={amount}
        {...(amountBaseUnits !== undefined && !valid
          ? { error: 'Amount exceeds the available balance or is zero.' }
          : {})}
      />
      <dl className="destination-lock">
        <div>
          <dt>Destination</dt>
          <dd>
            {payoutAddress === undefined
              ? 'Configured merchant payout destination'
              : `Merchant payout ${payoutAddress}`}
          </dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>
            <MoneyAmount baseUnits={dashboard.withdrawableBaseUnits} />
          </dd>
        </div>
      </dl>
      {state === 'review' && amountBaseUnits ? (
        <>
          <InlineAlert title="Confirm withdrawal" tone="warning">
            <p>
              Send <MoneyAmount baseUnits={amountBaseUnits} /> to the locked payout destination.
            </p>
          </InlineAlert>
          {preview === undefined ? null : (
            <dl className="payment-ledger">
              <div>
                <dt>Estimated payment cost</dt>
                <dd>${preview.estimatedFeeUsd}</dd>
              </div>
              <div className="payment-ledger__total">
                <dt>Maximum total</dt>
                <dd>${preview.maximumTotalUsd}</dd>
              </div>
            </dl>
          )}
        </>
      ) : null}
      {state === 'failed' && error !== undefined ? (
        <InlineAlert title="Withdrawal not submitted" tone="danger">
          <p>{error}</p>
        </InlineAlert>
      ) : null}
      <div className="page-actions">
        {state === 'review' ? (
          <>
            <Button onClick={() => void submit()}>Confirm withdrawal</Button>
            <Button onClick={() => setState('idle')} variant="quiet">
              Back
            </Button>
          </>
        ) : (
          <Button
            disabled={!enabled || !valid}
            loading={state === 'preparing'}
            loadingLabel="Preparing exact withdrawal"
            onClick={() => void prepare()}
          >
            Review withdrawal
          </Button>
        )}
      </div>
    </section>
  );
}
