'use client';

import {
  Button,
  CanonicalStatus,
  ExternalProofLink,
  InlineAlert,
  LinkButton,
  MoneyAmount,
  ProgressTimeline,
} from '@opentab/ui';
import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { checkoutMachine } from '../../client/checkout-machine';
import { useStateMachine } from '../../client/use-state-machine';
import type {
  CanonicalConfirmationView,
  CheckoutSnapshotView,
  PresentationMode,
} from '../../client/view-models';
import { AuthPanel } from '../auth-panel';
import { TurnstileChallenge } from '../turnstile-challenge';

export type LiveCheckoutPollResult =
  | { kind: 'pending'; snapshot: CheckoutSnapshotView }
  | { kind: 'provider_executed'; snapshot: CheckoutSnapshotView }
  | {
      kind: 'canonical';
      snapshot: CheckoutSnapshotView;
      proof: CanonicalConfirmationView;
    }
  | { kind: 'terminal'; message: string };

export interface LiveCheckoutActions {
  restoreAndBind(): Promise<boolean>;
  checkReadiness(): Promise<boolean>;
  checkSponsorEligibility(challengeToken: string): Promise<{ grantRequired: boolean }>;
  prepareAccount(challengeToken?: string): Promise<void>;
  loadBalance(snapshot: CheckoutSnapshotView): Promise<CheckoutSnapshotView>;
  preparePayment(snapshot: CheckoutSnapshotView): Promise<CheckoutSnapshotView>;
  submitPayment(snapshot: CheckoutSnapshotView): Promise<{
    snapshot: CheckoutSnapshotView;
    status: 'submitted' | 'submitted_unknown' | 'canonical';
  }>;
  pollPayment(snapshot: CheckoutSnapshotView): Promise<LiveCheckoutPollResult>;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'OpenTab could not complete this checkout step.';
}

function mayHaveSubmitted(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'submissionPossible' in error &&
    error.submissionPossible === true
  );
}

const canonicalDemoProof: CanonicalConfirmationView = {
  eventName: 'OrderPaid',
  canonical: true,
  confirmations: '8',
  requiredConfirmations: '2',
  transactionHash: '0x6d65d60f18fcfa3a2dc8b73d4b5ee2a7b32f628c3af4fc8f0f44de4d87ee8f31',
  blockNumber: '351204118',
  observedAt: '2026-07-10T10:34:38.000Z',
};

const paymentStages = [
  { id: 'approved', label: 'Payment approved' },
  { id: 'moving', label: 'Moving funds securely' },
  { id: 'confirming', label: 'Confirming your order' },
  { id: 'pass', label: 'Creating your pass' },
] as const;

function timelineFor(state: string) {
  const currentIndex =
    state === 'waiting_for_particle'
      ? 1
      : state === 'waiting_for_arbitrum' ||
          state === 'submitted_status_unknown' ||
          state === 'checking_status'
        ? 2
        : state === 'confirmed'
          ? 4
          : 0;
  return paymentStages.map((stage, index) => ({
    ...stage,
    detail:
      index === currentIndex && state !== 'confirmed'
        ? 'OpenTab will keep checking safely if you leave this page.'
        : undefined,
    status:
      index < currentIndex || state === 'confirmed'
        ? ('complete' as const)
        : index === currentIndex
          ? state === 'submitted_status_unknown'
            ? ('attention' as const)
            : ('current' as const)
          : ('upcoming' as const),
  }));
}

function decimalUsd(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(BigInt(whole))}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function CheckoutSummary({ snapshot }: { snapshot: CheckoutSnapshotView }) {
  const total = (
    BigInt(snapshot.product.unitPriceBaseUnits) * BigInt(snapshot.quantity)
  ).toString();
  return (
    <aside className="checkout-summary">
      <p className="eyebrow">Your order</p>
      <div className="checkout-summary__product">
        <Image alt="" height={96} src={snapshot.product.imagePath} width={96} />
        <div>
          <strong>{snapshot.product.title}</strong>
          <span>{snapshot.product.merchant.displayName}</span>
        </div>
      </div>
      <dl className="summary-ledger">
        <div>
          <dt>Quantity</dt>
          <dd>{snapshot.quantity}</dd>
        </div>
        <div>
          <dt>Order total</dt>
          <dd>
            <MoneyAmount baseUnits={total} />
          </dd>
        </div>
      </dl>
      <p className="summary-reference">
        Reference <span className="mono">{snapshot.supportReference}</span>
      </p>
    </aside>
  );
}

export function CheckoutWorkflow({
  authActions,
  initial,
  liveActions,
  mode,
  sponsorSiteKey,
}: {
  authActions?: {
    google: () => Promise<void>;
    email: (email: string) => Promise<void>;
  };
  initial: CheckoutSnapshotView;
  liveActions?: LiveCheckoutActions;
  mode: PresentationMode;
  sponsorSiteKey?: string;
}) {
  const [state, send] = useStateMachine(checkoutMachine, initial);
  const stateValue = String(state.value);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const accountChallenge = useRef<string | undefined>(undefined);
  const [sponsorStage, setSponsorStage] = useState<'eligibility' | 'grant'>('eligibility');
  const [sponsorToken, setSponsorToken] = useState<string>();
  const [sponsorChecking, setSponsorChecking] = useState(false);
  const [sponsorError, setSponsorError] = useState<string>();
  const receiveSponsorToken = useCallback((token: string | undefined) => {
    setSponsorToken(token);
    if (token !== undefined) setSponsorError(undefined);
  }, []);

  const continueSponsorPreparation = async () => {
    if (mode !== 'live' || liveActions === undefined) {
      send({ type: 'PREPARE_ACCOUNT' });
      return;
    }
    if (sponsorToken === undefined) return;
    if (sponsorStage === 'grant') {
      accountChallenge.current = sponsorToken;
      setSponsorToken(undefined);
      send({ type: 'PREPARE_ACCOUNT' });
      return;
    }
    setSponsorChecking(true);
    setSponsorError(undefined);
    try {
      const { grantRequired } = await liveActions.checkSponsorEligibility(sponsorToken);
      setSponsorToken(undefined);
      if (grantRequired) {
        setSponsorStage('grant');
      } else {
        accountChallenge.current = undefined;
        send({ type: 'PREPARE_ACCOUNT' });
      }
    } catch (error) {
      setSponsorToken(undefined);
      setSponsorError(safeErrorMessage(error));
    } finally {
      setSponsorChecking(false);
    }
  };

  useEffect(() => {
    if (stateValue) headingRef.current?.focus({ preventScroll: true });
  }, [stateValue]);

  useEffect(() => {
    if (mode !== 'deterministic') return;
    const automated: Partial<Record<string, { event: Parameters<typeof send>[0]; delay: number }>> =
      {
        creating_session: {
          event: { type: 'SESSION_CREATED' },
          delay: 320,
        },
        checking_readiness: {
          event: { type: 'READINESS_REQUIRED' },
          delay: 420,
        },
        preparing_account: {
          event: { type: 'ACCOUNT_READY' },
          delay: 760,
        },
        loading_balance: { event: { type: 'BALANCE_LOADED' }, delay: 420 },
        preparing_payment: {
          event: { type: 'PREVIEW_READY' },
          delay: 560,
        },
        signing_root_hash: {
          event: { type: 'SIGNATURE_APPROVED' },
          delay: 520,
        },
        submitting_particle: {
          event: { type: 'SUBMISSION_REGISTERED' },
          delay: 620,
        },
        waiting_for_particle: {
          event: { type: 'PROVIDER_EXECUTED' },
          delay: 820,
        },
        waiting_for_arbitrum: {
          event: { type: 'CANONICAL_CONFIRMED', proof: canonicalDemoProof },
          delay: 900,
        },
        checking_status: {
          event: { type: 'STATUS_STILL_UNKNOWN' },
          delay: 700,
        },
      };
    const next = automated[stateValue];
    if (!next) return;
    const timeout = window.setTimeout(() => send(next.event), next.delay);
    return () => window.clearTimeout(timeout);
  }, [mode, send, stateValue]);

  useEffect(() => {
    if (mode !== 'live' || liveActions === undefined) return;
    let cancelled = false;
    const visibilityController = new AbortController();
    const waitUntilVisible = () => {
      if (document.visibilityState === 'visible' || cancelled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const signal = visibilityController.signal;
        const finish = () => {
          if (!signal.aborted && document.visibilityState !== 'visible') return;
          document.removeEventListener('visibilitychange', finish);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        document.addEventListener('visibilitychange', finish);
        signal.addEventListener('abort', finish, { once: true });
      });
    };
    const sendIfActive = (event: Parameters<typeof send>[0]) => {
      if (!cancelled) send(event);
    };
    const fail = (error: unknown) => {
      if (cancelled) return;
      if (
        mayHaveSubmitted(error) ||
        [
          'submitting_particle',
          'waiting_for_particle',
          'waiting_for_arbitrum',
          'submitted_status_unknown',
          'checking_status',
        ].includes(stateValue)
      ) {
        send({ type: 'TIMEOUT_AFTER_POSSIBLE_SUBMISSION' });
      } else {
        send({ type: 'FAIL_PRE_SUBMISSION', message: safeErrorMessage(error) });
      }
    };
    const pollUntilTransition = async () => {
      while (!cancelled) {
        await waitUntilVisible();
        if (cancelled) return;
        const result = await liveActions.pollPayment(state.context.snapshot);
        if (cancelled) return;
        if (result.kind === 'canonical') {
          send({ type: 'CANONICAL_CONFIRMED', proof: result.proof });
          return;
        }
        if (result.kind === 'terminal') {
          send({ type: 'FAIL_CONFIRMED', message: result.message });
          return;
        }
        if (result.kind === 'provider_executed' && stateValue === 'waiting_for_particle') {
          send({ type: 'PROVIDER_EXECUTED', snapshot: result.snapshot });
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2_500));
      }
    };
    const run = async () => {
      switch (stateValue) {
        case 'creating_session': {
          const authenticated = await liveActions.restoreAndBind();
          sendIfActive({ type: 'SESSION_CREATED' });
          if (authenticated) sendIfActive({ type: 'AUTHENTICATED' });
          return;
        }
        case 'checking_readiness':
          sendIfActive({
            type: (await liveActions.checkReadiness()) ? 'READINESS_READY' : 'READINESS_REQUIRED',
          });
          return;
        case 'preparing_account':
          await liveActions.prepareAccount(accountChallenge.current);
          accountChallenge.current = undefined;
          sendIfActive({ type: 'ACCOUNT_READY' });
          return;
        case 'loading_balance':
          sendIfActive({
            type: 'BALANCE_LOADED',
            snapshot: await liveActions.loadBalance(state.context.snapshot),
          });
          return;
        case 'preparing_payment':
          sendIfActive({
            type: 'PREVIEW_READY',
            snapshot: await liveActions.preparePayment(state.context.snapshot),
          });
          return;
        case 'signing_root_hash': {
          const result = await liveActions.submitPayment(state.context.snapshot);
          sendIfActive({ type: 'SIGNATURE_APPROVED' });
          if (result.status === 'submitted_unknown') {
            sendIfActive({ type: 'TIMEOUT_AFTER_POSSIBLE_SUBMISSION' });
          } else {
            sendIfActive({ type: 'SUBMISSION_REGISTERED', snapshot: result.snapshot });
            if (result.status === 'canonical' && result.snapshot.canonicalConfirmation) {
              sendIfActive({
                type: 'CANONICAL_CONFIRMED',
                proof: result.snapshot.canonicalConfirmation,
              });
            }
          }
          return;
        }
        case 'waiting_for_particle':
        case 'waiting_for_arbitrum':
        case 'submitted_status_unknown':
          await pollUntilTransition();
          return;
        case 'checking_status': {
          const result = await liveActions.pollPayment(state.context.snapshot);
          if (result.kind === 'canonical') {
            sendIfActive({ type: 'CANONICAL_CONFIRMED', proof: result.proof });
          } else if (result.kind === 'terminal') {
            sendIfActive({ type: 'FAIL_CONFIRMED', message: result.message });
          } else {
            sendIfActive({ type: 'STATUS_STILL_UNKNOWN' });
          }
          return;
        }
        default:
          return;
      }
    };
    void run().catch(fail);
    return () => {
      cancelled = true;
      visibilityController.abort();
    };
  }, [liveActions, mode, send, state.context.snapshot, stateValue]);

  const snapshot = state.context.snapshot;
  const totalBaseUnits = (
    BigInt(snapshot.product.unitPriceBaseUnits) * BigInt(snapshot.quantity)
  ).toString();
  const isProcessing = [
    'waiting_for_particle',
    'waiting_for_arbitrum',
    'submitted_status_unknown',
    'checking_status',
  ].includes(stateValue);

  return (
    <div className="checkout-layout">
      <CheckoutSummary snapshot={snapshot} />
      <section aria-live="off" className="checkout-step">
        <span aria-live="polite" className="sr-status">
          Checkout stage: {stateValue.replaceAll('_', ' ')}
        </span>
        {stateValue === 'product_ready' ? (
          <>
            <p className="eyebrow">Secure checkout</p>
            <h1 ref={headingRef} tabIndex={-1}>
              Ready when you are
            </h1>
            <p>
              We’ll verify your sign-in, available balance, and exact payment details before asking
              you to approve anything.
            </p>
            <Button onClick={() => send({ type: 'CONTINUE' })} size="large">
              Continue
            </Button>
          </>
        ) : null}

        {[
          'creating_session',
          'checking_readiness',
          'preparing_account',
          'loading_balance',
          'preparing_payment',
          'signing_root_hash',
          'submitting_particle',
        ].includes(stateValue) ? (
          <>
            <p className="eyebrow">In progress</p>
            <h1 ref={headingRef} tabIndex={-1}>
              {stateValue === 'creating_session'
                ? 'Starting secure checkout'
                : stateValue === 'checking_readiness'
                  ? 'Checking your account'
                  : stateValue === 'preparing_account'
                    ? 'Preparing your account'
                    : stateValue === 'loading_balance'
                      ? 'Checking your available balance'
                      : stateValue === 'preparing_payment'
                        ? 'Finding the best payment route'
                        : stateValue === 'signing_root_hash'
                          ? 'Approving payment'
                          : 'Submitting your payment'}
            </h1>
            <div className="working-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <p>
              {stateValue === 'preparing_account'
                ? 'This is the one-time setup you approved. Your address stays the same.'
                : 'Keep this page open for the quickest update. It is safe to return using the same link.'}
            </p>
          </>
        ) : null}

        {stateValue === 'authenticating' ? (
          <div ref={headingRef as never} tabIndex={-1}>
            <AuthPanel
              deterministic={mode === 'deterministic'}
              onAuthenticated={() => send({ type: 'AUTHENTICATED' })}
              {...(authActions === undefined
                ? {}
                : {
                    onGoogleSignIn: authActions.google,
                    onEmailSignIn: authActions.email,
                  })}
            />
          </div>
        ) : null}

        {stateValue === 'sponsor_required' ? (
          <>
            <p className="eyebrow">One-time setup</p>
            <h1 ref={headingRef} tabIndex={-1}>
              Prepare your account for one-tap payments
            </h1>
            <p>
              This one-time setup lets OpenTab use your existing account across supported networks.
              Your address stays the same and you stay in control.
            </p>
            <InlineAlert title="OpenTab covers the setup cost" tone="info">
              <p>You will not need to acquire a separate destination fee balance.</p>
            </InlineAlert>
            {mode === 'live' ? (
              sponsorSiteKey === undefined ? (
                <InlineAlert title="Account setup temporarily unavailable" tone="warning">
                  <p>
                    No payment was started. Return with this checkout link after protected setup is
                    restored.
                  </p>
                </InlineAlert>
              ) : (
                <TurnstileChallenge
                  key={sponsorStage}
                  onToken={receiveSponsorToken}
                  siteKey={sponsorSiteKey}
                />
              )
            ) : null}
            {sponsorStage === 'grant' ? (
              <InlineAlert title="One more security check" tone="info">
                <p>
                  Your account needs a small setup grant. Complete this fresh check to approve that
                  single grant request.
                </p>
              </InlineAlert>
            ) : null}
            {sponsorError === undefined ? null : (
              <InlineAlert title="Account setup could not continue" tone="warning">
                <p>{sponsorError}</p>
              </InlineAlert>
            )}
            <details className="disclosure">
              <summary>What permission am I approving?</summary>
              <p>
                You approve a verified account capability for this checkout system. Payment is still
                a separate approval with an exact total.
              </p>
            </details>
            <div className="page-actions">
              <Button
                disabled={
                  mode === 'live' && (sponsorSiteKey === undefined || sponsorToken === undefined)
                }
                loading={sponsorChecking}
                loadingLabel="Checking eligibility"
                onClick={() => void continueSponsorPreparation()}
                size="large"
              >
                {mode === 'live' && sponsorStage === 'eligibility'
                  ? 'Check setup eligibility'
                  : 'Prepare account'}
              </Button>
              <Button onClick={() => send({ type: 'CANCEL' })} variant="quiet">
                Leave checkout
              </Button>
            </div>
          </>
        ) : null}

        {stateValue === 'ready_to_pay' ? (
          <>
            <p className="eyebrow">Balance ready</p>
            <h1 ref={headingRef} tabIndex={-1}>
              Available to pay
            </h1>
            <div className="balance-hero">
              <span>Combined balance</span>
              <strong>{decimalUsd(snapshot.balanceUsd ?? '0')}</strong>
              <small>Updated just now</small>
            </div>
            <p>OpenTab combines supported balances so you don’t need to move funds yourself.</p>
            <details className="disclosure">
              <summary>How this payment works</summary>
              <p>
                Supported balances are used automatically. The merchant receives the exact
                settlement amount only if the order succeeds.
              </p>
              {snapshot.quote?.sources.map((source) => (
                <p className="source-row" key={source.id}>
                  <span>
                    {source.label} · {source.symbol}
                  </span>
                  <strong>{decimalUsd(source.amountUsd)}</strong>
                </p>
              ))}
            </details>
            <Button onClick={() => send({ type: 'PREPARE_PAYMENT' })} size="large">
              Review payment
            </Button>
          </>
        ) : null}

        {stateValue === 'preview_ready' && snapshot.quote ? (
          <>
            <p className="eyebrow">Review and approve</p>
            <h1 ref={headingRef} tabIndex={-1}>
              Payment details
            </h1>
            <dl className="payment-ledger">
              <div>
                <dt>
                  {snapshot.product.title} × {snapshot.quantity}
                </dt>
                <dd>
                  <MoneyAmount baseUnits={totalBaseUnits} />
                </dd>
              </div>
              <div>
                <dt>Estimated payment cost</dt>
                <dd>{decimalUsd(snapshot.quote.estimatedFeeUsd)}</dd>
              </div>
              <div className="payment-ledger__total">
                <dt>Maximum total</dt>
                <dd>{decimalUsd(snapshot.quote.maximumTotalUsd)}</dd>
              </div>
              <div>
                <dt>Available to pay</dt>
                <dd>{decimalUsd(snapshot.quote.availableUsd)}</dd>
              </div>
            </dl>
            <p className="quote-expiry">
              Payment details are held for this approval. {snapshot.quote.slippageLabel}.
            </p>
            <details className="disclosure">
              <summary>Payment sources and settlement</summary>
              {snapshot.quote.sources.map((source) => (
                <p className="source-row" key={source.id}>
                  <span>
                    {source.label} · {source.symbol}
                  </span>
                  <strong>{decimalUsd(source.amountUsd)}</strong>
                </p>
              ))}
              <p>
                The exact merchant contract and destination are bound by the server and cannot be
                changed from this screen.
              </p>
            </details>
            <p className="policy-copy">{snapshot.product.refundTerms}</p>
            <div className="page-actions page-actions--stack">
              <Button
                disabled={state.context.repeatPaymentBlocked}
                onClick={() => send({ type: 'CONFIRM_PAYMENT' })}
                size="large"
              >
                Confirm and pay <MoneyAmount baseUnits={totalBaseUnits} />
              </Button>
              <Button onClick={() => send({ type: 'CANCEL' })} variant="quiet">
                Cancel
              </Button>
            </div>
          </>
        ) : null}

        {isProcessing ? (
          <>
            <p className="eyebrow">Order {snapshot.supportReference}</p>
            <h1 ref={headingRef} tabIndex={-1}>
              {stateValue === 'submitted_status_unknown' || stateValue === 'checking_status'
                ? 'We’re confirming your payment'
                : stateValue === 'waiting_for_particle'
                  ? 'Your payment is on its way'
                  : 'Confirming your order'}
            </h1>
            {stateValue === 'submitted_status_unknown' ? (
              <InlineAlert title="Don’t pay again" tone="warning">
                <p>
                  The payment may have moved. OpenTab is checking the final result using your saved
                  reference.
                </p>
              </InlineAlert>
            ) : (
              <p>Your approval was saved. Do not submit another payment for this order.</p>
            )}
            <ProgressTimeline items={timelineFor(stateValue)} />
            <div className="page-actions">
              {stateValue === 'submitted_status_unknown' ? (
                <Button onClick={() => send({ type: 'CHECK_STATUS' })} variant="secondary">
                  Check status
                </Button>
              ) : null}
              <LinkButton href="/account/orders" variant="quiet">
                Leave and return later
              </LinkButton>
            </div>
            <p className="support-copy">
              Support reference: <span className="mono">{snapshot.supportReference}</span>
            </p>
          </>
        ) : null}

        {stateValue === 'retryable_failure' ? (
          <>
            <p className="eyebrow">No payment submitted</p>
            <h1 ref={headingRef} tabIndex={-1}>
              This step needs another try
            </h1>
            <InlineAlert title="Your funds did not move" tone="danger">
              <p>
                {state.context.lastError?.message ??
                  'OpenTab could not complete the reversible checkout step.'}
              </p>
            </InlineAlert>
            <div className="page-actions">
              <Button onClick={() => send({ type: 'RETRY_SAFE' })}>Try again</Button>
              <Button onClick={() => send({ type: 'CANCEL' })} variant="quiet">
                Leave checkout
              </Button>
            </div>
          </>
        ) : null}

        {stateValue === 'terminal_failure' ? (
          <>
            <p className="eyebrow">Final result</p>
            <h1 ref={headingRef} tabIndex={-1}>
              The order could not be completed
            </h1>
            <InlineAlert title="Payment status verified" tone="danger">
              <p>
                {state.context.lastError?.message ??
                  'The final execution did not create this order.'}{' '}
                OpenTab will not retry it automatically.
              </p>
            </InlineAlert>
            <LinkButton
              href={`/c/${snapshot.product.merchant.slug}/${snapshot.product.slug}`}
              variant="secondary"
            >
              Return to the offer
            </LinkButton>
          </>
        ) : null}

        {stateValue === 'expired' ? (
          <>
            <p className="eyebrow">Checkout expired</p>
            <h1 ref={headingRef} tabIndex={-1}>
              Update payment details
            </h1>
            <p>
              This saved approval can no longer be resumed in this tab. Nothing was submitted for
              this attempt; start again from the verified offer.
            </p>
            <LinkButton href={`/c/${snapshot.product.merchant.slug}/${snapshot.product.slug}`}>
              Return to the offer
            </LinkButton>
          </>
        ) : null}

        {stateValue === 'cancelled' ? (
          <>
            <p className="eyebrow">Checkout closed</p>
            <h1 ref={headingRef} tabIndex={-1}>
              Nothing was submitted
            </h1>
            <p>You left before the payment boundary.</p>
            <LinkButton href={`/c/${snapshot.product.merchant.slug}/${snapshot.product.slug}`}>
              Return to the offer
            </LinkButton>
          </>
        ) : null}

        {stateValue === 'confirmed' ? (
          <>
            <CanonicalStatus label="Confirmed order" tone="confirmed" />
            <p className="eyebrow success-eyebrow">Order complete</p>
            <h1 ref={headingRef} tabIndex={-1}>
              You’re in
            </h1>
            <p>Your order is confirmed and your pass is ready.</p>
            <ProgressTimeline items={timelineFor('confirmed')} />
            <div className="page-actions">
              {snapshot.orderId === undefined ? null : (
                <LinkButton href={`/receipt/${snapshot.orderId}`} size="large">
                  View receipt and pass
                </LinkButton>
              )}
            </div>
            {snapshot.canonicalConfirmation ? (
              <details className="disclosure">
                <summary>Payment proof</summary>
                <p>
                  Confirmed on Arbitrum from verified <span className="mono">OrderPaid</span>{' '}
                  evidence after {snapshot.canonicalConfirmation.confirmations} confirmations.
                </p>
                <ExternalProofLink
                  href={`https://arbiscan.io/tx/${snapshot.canonicalConfirmation.transactionHash}`}
                  label="View public payment proof"
                />
              </details>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
