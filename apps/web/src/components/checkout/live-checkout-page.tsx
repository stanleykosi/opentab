'use client';

import type { UnifiedBalance } from '@opentab/shared';
import { LinkButton } from '@opentab/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserApiError,
  type CheckoutSnapshotResponse,
  type PaymentWorkflowResponse,
} from '../../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../../application/browser-application-service';
import {
  applyPaymentWorkflowToView,
  mapCheckoutResponseToView,
  mapValidatedPlanToQuote,
} from '../../application/live-view-mappers';
import type { CheckoutSnapshotView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import {
  CheckoutWorkflow,
  type LiveCheckoutActions,
  type LiveCheckoutPollResult,
} from './checkout-workflow';

type LiveCheckoutService = Pick<
  BrowserApplicationService,
  | 'beginGoogleSignIn'
  | 'bindCheckout'
  | 'checkWalletReadiness'
  | 'getCheckout'
  | 'getPaymentWorkflow'
  | 'getSponsorChallengeConfig'
  | 'evaluateWalletPreparation'
  | 'loadUnifiedBalance'
  | 'pollPaymentAttempt'
  | 'prepareCheckoutPayment'
  | 'prepareWalletAccount'
  | 'restoreSession'
  | 'signInWithEmail'
  | 'submitCheckoutPayment'
>;

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: CheckoutSnapshotView; sponsorSiteKey?: string }
  | { status: 'error'; message: string; reference?: string | undefined };

function isAuthRequired(error: unknown): boolean {
  return error instanceof BrowserApiError && error.code === 'AUTH_REQUIRED';
}

async function initialSnapshot(
  service: LiveCheckoutService,
  checkoutSessionId: string,
): Promise<{ checkout: CheckoutSnapshotResponse; workflow?: PaymentWorkflowResponse }> {
  const checkout = await service.getCheckout(checkoutSessionId);
  if (checkout.attempt === undefined) return { checkout };
  try {
    return {
      checkout,
      workflow: await service.getPaymentWorkflow(checkout.attempt.id),
    };
  } catch (error) {
    if (isAuthRequired(error)) return { checkout };
    throw error;
  }
}

function liveActions(input: {
  service: LiveCheckoutService;
  checkoutSessionId: string;
  balance: { current: UnifiedBalance | undefined };
}): LiveCheckoutActions {
  const { service, checkoutSessionId, balance } = input;
  return {
    async restoreAndBind() {
      try {
        await service.restoreSession();
      } catch (error) {
        if (isAuthRequired(error)) return false;
        throw error;
      }
      await service.bindCheckout(checkoutSessionId);
      return true;
    },
    async checkReadiness() {
      await service.bindCheckout(checkoutSessionId);
      const readiness = await service.checkWalletReadiness();
      return readiness.ready && readiness.blockers.length === 0;
    },
    checkSponsorEligibility: (challengeToken) => service.evaluateWalletPreparation(challengeToken),
    async prepareAccount(challengeToken) {
      const readiness = await service.prepareWalletAccount(challengeToken);
      if (!readiness.ready || readiness.blockers.length > 0) {
        throw new BrowserApiError({
          code: 'UA_DELEGATION_REQUIRED',
          message: 'The account preparation is not confirmed yet. Try the readiness check again.',
          retryable: true,
          status: 0,
        });
      }
    },
    async loadBalance(snapshot) {
      const loaded = await service.loadUnifiedBalance();
      balance.current = loaded;
      return { ...snapshot, balanceUsd: loaded.totalUsd, state: 'ready_to_pay' };
    },
    async preparePayment(snapshot) {
      const available = balance.current ?? (await service.loadUnifiedBalance());
      balance.current = available;
      const prepared = await service.prepareCheckoutPayment(checkoutSessionId);
      return {
        ...snapshot,
        orderId: prepared.binding.orderId,
        supportReference: prepared.binding.orderId
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(-10)
          .toUpperCase(),
        providerOperationId: prepared.providerOperationId,
        quote: mapValidatedPlanToQuote(prepared.plan, available),
        state: 'preview_ready',
        submissionPossible: false,
        updatedAt: prepared.plan.validatedAt,
      };
    },
    async submitPayment(snapshot) {
      if (snapshot.orderId === undefined) {
        throw new BrowserApiError({
          code: 'OPERATION_PLAN_INVALID',
          message: 'The payment attempt reference is missing.',
          status: 0,
        });
      }
      const checkout = await service.getCheckout(checkoutSessionId);
      const attempt = checkout.attempt;
      if (attempt === undefined || attempt.orderId !== snapshot.orderId) {
        throw new BrowserApiError({
          code: 'OPERATION_PLAN_INVALID',
          message: 'The durable payment attempt no longer matches this preview.',
          status: 0,
        });
      }
      const result = await service.submitCheckoutPayment(attempt.id);
      const updated = applyPaymentWorkflowToView(snapshot, result.workflow);
      return {
        snapshot: updated,
        status:
          updated.canonicalConfirmation !== undefined
            ? 'canonical'
            : result.kind === 'submitted_unknown' || updated.state === 'submitted_status_unknown'
              ? 'submitted_unknown'
              : 'submitted',
      };
    },
    async pollPayment(snapshot): Promise<LiveCheckoutPollResult> {
      const checkout = await service.getCheckout(checkoutSessionId);
      if (checkout.attempt === undefined) {
        return { kind: 'terminal', message: 'The durable payment attempt was not found.' };
      }
      const result = await service.pollPaymentAttempt(checkout.attempt.id);
      const updated = applyPaymentWorkflowToView(snapshot, result.workflow);
      if (updated.canonicalConfirmation !== undefined) {
        return {
          kind: 'canonical',
          snapshot: updated,
          proof: updated.canonicalConfirmation,
        };
      }
      if (
        result.workflow.attempt.status === 'failed_confirmed' ||
        ['failed_confirmed', 'mismatch', 'orphaned'].includes(result.workflow.order.status)
      ) {
        return {
          kind: 'terminal',
          message: 'The authoritative settlement record did not create this order.',
        };
      }
      if (
        result.workflow.attempt.status === 'confirming' ||
        result.providerOperation?.status === 'succeeded'
      ) {
        return { kind: 'provider_executed', snapshot: updated };
      }
      return { kind: 'pending', snapshot: updated };
    },
  };
}

export function LiveCheckoutPage({
  checkoutSessionId,
  service = getBrowserApplicationService(),
}: {
  checkoutSessionId: string;
  service?: LiveCheckoutService;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const balance = useRef<UnifiedBalance | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void Promise.all([
      initialSnapshot(service, checkoutSessionId),
      service.getSponsorChallengeConfig(),
    ])
      .then(([{ checkout, workflow }, challenge]) => {
        if (!active) return;
        setState({
          status: 'ready',
          snapshot: mapCheckoutResponseToView(checkout, {
            origin: window.location.origin,
            ...(workflow === undefined ? {} : { workflow }),
          }),
          ...(challenge.siteKey === undefined ? {} : { sponsorSiteKey: challenge.siteKey }),
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'OpenTab could not restore this secure checkout.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [checkoutSessionId, service]);

  const actions = useMemo(
    () => liveActions({ service, checkoutSessionId, balance }),
    [checkoutSessionId, service],
  );
  const authActions = useMemo(
    () => ({
      google: () => service.beginGoogleSignIn(`/checkout/${checkoutSessionId}`),
      email: async (email: string) => {
        await service.signInWithEmail(email, `/checkout/${checkoutSessionId}`);
        await service.bindCheckout(checkoutSessionId);
      },
    }),
    [checkoutSessionId, service],
  );

  if (state.status === 'loading') return <PageSkeleton label="Restoring secure checkout" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        action={
          <LinkButton href="/" variant="secondary">
            Return home
          </LinkButton>
        }
        body={`${state.message} No new payment was submitted.`}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Checkout unavailable"
      />
    );
  }
  return (
    <CheckoutWorkflow
      authActions={authActions}
      initial={state.snapshot}
      liveActions={actions}
      mode="live"
      {...(state.sponsorSiteKey === undefined ? {} : { sponsorSiteKey: state.sponsorSiteKey })}
    />
  );
}
