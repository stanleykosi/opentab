'use client';

import { Button, CanonicalStatus, InlineAlert, MoneyAmount, ProgressTimeline } from '@opentab/ui';
import { useEffect, useState } from 'react';
import type { SplitInvitationView, SplitView } from '../../client/view-models';

type ReimbursementState =
  | 'ready'
  | 'preparing'
  | 'preview'
  | 'approving'
  | 'confirming'
  | 'submitted_unknown'
  | 'paid'
  | 'expired'
  | 'revoked';

export interface ReimbursementResult {
  readonly status: 'submitted' | 'submitted_unknown' | 'confirming' | 'paid' | 'failed';
}

export interface ReimbursementActions {
  prepare(): Promise<{ estimatedFeeUsd: string; maximumTotalUsd: string }>;
  submit(): Promise<ReimbursementResult>;
  getStatus(): Promise<ReimbursementResult>;
}

function decimalBaseUnits(value: bigint): string {
  const padded = value.toString().padStart(7, '0');
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return fraction.length === 0 ? padded.slice(0, -6) : `${padded.slice(0, -6)}.${fraction}`;
}

export function ReimbursementCheckout({
  actions,
  invitation,
  split,
}: {
  actions?: ReimbursementActions;
  invitation: SplitInvitationView;
  split: SplitView;
}) {
  const initial: ReimbursementState =
    invitation.status === 'paid'
      ? 'paid'
      : invitation.status === 'expired'
        ? 'expired'
        : invitation.status === 'revoked'
          ? 'revoked'
          : invitation.status === 'submitted_unknown'
            ? 'submitted_unknown'
            : invitation.status === 'confirming'
              ? 'confirming'
              : 'ready';
  const [state, setState] = useState<ReimbursementState>(initial);
  const [preview, setPreview] = useState<{
    estimatedFeeUsd: string;
    maximumTotalUsd: string;
  }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (actions === undefined && state === 'approving') {
      const timeout = window.setTimeout(() => setState('confirming'), 700);
      return () => window.clearTimeout(timeout);
    }
    if (actions === undefined && state === 'confirming') {
      const timeout = window.setTimeout(() => setState('paid'), 1100);
      return () => window.clearTimeout(timeout);
    }
  }, [actions, state]);

  const prepare = async () => {
    setError(undefined);
    if (actions === undefined) {
      setPreview({
        estimatedFeeUsd: '0.09',
        maximumTotalUsd: decimalBaseUnits(BigInt(invitation.amountBaseUnits) + 90_000n),
      });
      setState('preview');
      return;
    }
    setState('preparing');
    try {
      setPreview(await actions.prepare());
      setState('preview');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Reimbursement could not be prepared.');
      setState('ready');
    }
  };

  const submit = async () => {
    if (actions === undefined) {
      setState('approving');
      return;
    }
    setState('approving');
    setError(undefined);
    try {
      const result = await actions.submit();
      setState(
        result.status === 'paid'
          ? 'paid'
          : result.status === 'submitted_unknown'
            ? 'submitted_unknown'
            : result.status === 'failed'
              ? 'ready'
              : 'confirming',
      );
    } catch (caught) {
      const possible =
        typeof caught === 'object' &&
        caught !== null &&
        'submissionPossible' in caught &&
        caught.submissionPossible === true;
      setError(caught instanceof Error ? caught.message : 'Reimbursement could not be submitted.');
      setState(possible ? 'submitted_unknown' : 'preview');
    }
  };

  const check = async () => {
    if (actions === undefined) {
      setState('confirming');
      return;
    }
    try {
      const result = await actions.getStatus();
      setState(
        result.status === 'paid'
          ? 'paid'
          : result.status === 'failed'
            ? 'ready'
            : result.status === 'submitted_unknown'
              ? 'submitted_unknown'
              : 'confirming',
      );
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Status is temporarily unavailable.');
    }
  };

  return (
    <section className="reimbursement-card">
      <p className="eyebrow">Private reimbursement request</p>
      <h1>
        {split.purchaserAlias} asked you to cover part of {split.productTitle}
      </h1>
      <div className="reimbursement-amount">
        <span>Your exact share</span>
        <MoneyAmount baseUnits={invitation.amountBaseUnits} />
      </div>
      <p>This repays your friend. It does not change the merchant order.</p>
      {error === undefined ? null : (
        <InlineAlert title="Reimbursement did not continue" tone="danger">
          <p>{error}</p>
        </InlineAlert>
      )}
      {state === 'ready' ? (
        <>
          <InlineAlert title="Sign in before payment" tone="info">
            <p>
              OpenTab will check your available balance and show the payment cost before approval.
            </p>
          </InlineAlert>
          <Button onClick={() => void prepare()} size="large">
            Review exact reimbursement
          </Button>
        </>
      ) : null}
      {state === 'preparing' ? (
        <>
          <h2>Preparing exact reimbursement</h2>
          <div className="working-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <p>OpenTab is verifying the destination, amount, calls, and payment cost.</p>
        </>
      ) : null}
      {state === 'preview' ? (
        <>
          <dl className="payment-ledger">
            <div>
              <dt>Reimbursement</dt>
              <dd>
                <MoneyAmount baseUnits={invitation.amountBaseUnits} />
              </dd>
            </div>
            <div>
              <dt>Estimated payment cost</dt>
              <dd>${preview?.estimatedFeeUsd ?? '—'}</dd>
            </div>
            <div className="payment-ledger__total">
              <dt>Maximum total</dt>
              <dd>${preview?.maximumTotalUsd ?? '—'}</dd>
            </div>
          </dl>
          <Button onClick={() => void submit()} size="large">
            Confirm reimbursement of <MoneyAmount baseUnits={invitation.amountBaseUnits} />
          </Button>
        </>
      ) : null}
      {state === 'approving' ? (
        <>
          <h2>Approving reimbursement</h2>
          <div className="working-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <p>Keep this page open. Do not approve a second request.</p>
        </>
      ) : null}
      {state === 'confirming' || state === 'submitted_unknown' ? (
        <>
          <h2>
            {state === 'submitted_unknown'
              ? 'We’re confirming your reimbursement'
              : 'Confirming your reimbursement'}
          </h2>
          {state === 'submitted_unknown' ? (
            <InlineAlert title="Don’t pay again" tone="warning">
              <p>
                It may have moved. OpenTab is checking the saved operation before showing a result.
              </p>
            </InlineAlert>
          ) : null}
          <ProgressTimeline
            items={[
              { id: 'approved', label: 'Payment approved', status: 'complete' },
              { id: 'move', label: 'Moving funds securely', status: 'complete' },
              {
                id: 'confirm',
                label: 'Confirming reimbursement',
                status: state === 'submitted_unknown' ? 'attention' : 'current',
              },
            ]}
          />
          {state === 'submitted_unknown' ? (
            <Button onClick={() => void check()} variant="secondary">
              Check status
            </Button>
          ) : null}
        </>
      ) : null}
      {state === 'paid' ? (
        <>
          <CanonicalStatus label="Confirmed reimbursement" tone="confirmed" />
          <h2>Your reimbursement is complete</h2>
          <p>The reimbursement is complete from confirmed settlement evidence.</p>
        </>
      ) : null}
      {state === 'expired' || state === 'revoked' ? (
        <InlineAlert
          title={state === 'expired' ? 'This link expired' : 'This link was revoked'}
          tone="danger"
        >
          <p>
            No payment can be started from this invitation. Ask {split.purchaserAlias} for a new
            link.
          </p>
        </InlineAlert>
      ) : null}
      <p className="privacy-note">
        This page does not reveal the purchaser’s email, original balance, or private payment
        details.
      </p>
    </section>
  );
}
