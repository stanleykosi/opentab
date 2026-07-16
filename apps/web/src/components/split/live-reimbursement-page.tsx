'use client';

import { Button, InlineAlert } from '@opentab/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrowserApiClient,
  BrowserApiError,
  type ContractOperationRecord,
  type SplitCapabilityResponse,
} from '../../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../../application/browser-application-service';
import type { SplitInvitationView, SplitView } from '../../client/view-models';
import { AuthPanel } from '../auth-panel';
import { ErrorState, PageSkeleton } from '../states';
import { TurnstileChallenge } from '../turnstile-challenge';
import { ReimbursementCheckout, type ReimbursementResult } from './reimbursement-checkout';

type LiveSplitService = Pick<
  BrowserApplicationService,
  | 'beginGoogleSignIn'
  | 'checkWalletReadiness'
  | 'evaluateWalletPreparation'
  | 'getContractOperation'
  | 'getSponsorChallengeConfig'
  | 'prepareContractOperation'
  | 'prepareWalletAccount'
  | 'restoreSession'
  | 'signInWithEmail'
  | 'submitContractOperation'
>;

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'auth'; readonly capability: SplitCapabilityResponse }
  | {
      readonly status: 'setup';
      readonly capability: SplitCapabilityResponse;
      readonly siteKey?: string;
      readonly stage: 'eligibility' | 'grant';
    }
  | { readonly status: 'ready'; readonly capability: SplitCapabilityResponse }
  | { readonly status: 'error'; readonly message: string; readonly reference?: string };

function isAuthRequired(error: unknown): boolean {
  return error instanceof BrowserApiError && error.code === 'AUTH_REQUIRED';
}

function durablePrepareKey(reference: string): string {
  const invitationId = reference.slice(0, reference.indexOf('.'));
  const storageKey = `opentab.split-payment.${invitationId}.prepare`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing !== null && existing.length >= 16 && existing.length <= 128) return existing;
  const created = `web.split-payment-prepare.${crypto.randomUUID()}`;
  window.sessionStorage.setItem(storageKey, created);
  return created;
}

function resultFromOperation(operation: ContractOperationRecord): ReimbursementResult {
  return {
    status:
      operation.status === 'confirmed'
        ? 'paid'
        : operation.status === 'failed' || operation.status === 'orphaned'
          ? 'failed'
          : operation.status === 'submission_started' || operation.status === 'submitted_unknown'
            ? 'submitted_unknown'
            : operation.status === 'confirming'
              ? 'confirming'
              : 'submitted',
  };
}

function invitationStatus(capability: SplitCapabilityResponse): SplitInvitationView['status'] {
  const status = capability.existingPayment?.status ?? capability.invitation.status;
  if (status === 'paid') return 'paid';
  if (status === 'expired') return 'expired';
  if (status === 'revoked') return 'revoked';
  if (status === 'confirming') return 'confirming';
  if (status === 'submission_started' || status === 'submitted_unknown') {
    return 'submitted_unknown';
  }
  return 'unpaid';
}

function view(
  reference: string,
  capability: SplitCapabilityResponse,
): {
  split: SplitView;
  invitation: SplitInvitationView;
} {
  const invitation = {
    id: capability.invitation.id,
    participantLabel: capability.invitation.participantLabel,
    amountBaseUnits: capability.invitation.amountBaseUnits,
    status: invitationStatus(capability),
    shareToken: reference,
    expiresAt: capability.invitation.expiresAt,
  } satisfies SplitInvitationView;
  return {
    invitation,
    split: {
      id: capability.split.id,
      orderId: capability.split.orderId,
      purchaserAlias: 'A friend',
      productTitle: 'a shared purchase',
      totalBaseUnits: capability.split.totalBaseUnits,
      confirmedBaseUnits: capability.split.confirmedBaseUnits,
      status: capability.split.status,
      invitations: [invitation],
      expiresAt: capability.split.expiresAt,
    },
  };
}

export function LiveReimbursementPage({
  client: providedClient,
  reference,
  service = getBrowserApplicationService(),
}: {
  client?: BrowserApiClient;
  reference: string;
  service?: LiveSplitService;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [challengeToken, setChallengeToken] = useState<string>();
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState<string>();
  const receiveChallenge = useCallback((token: string | undefined) => {
    setChallengeToken(token);
  }, []);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const publicCapability = await client.getSplitByCapability(reference);
      if (
        ['expired', 'revoked', 'paid'].includes(publicCapability.invitation.status) ||
        ['expired', 'revoked', 'complete'].includes(publicCapability.split.status)
      ) {
        setState({ status: 'ready', capability: publicCapability });
        return;
      }
      try {
        await service.restoreSession();
      } catch (error) {
        if (isAuthRequired(error)) {
          setState({ status: 'auth', capability: publicCapability });
          return;
        }
        throw error;
      }
      const capability = await client.getSplitByCapability(reference);
      if (capability.operation !== undefined && capability.operation.status !== 'prepared') {
        setState({ status: 'ready', capability });
        return;
      }
      const readiness = await service.checkWalletReadiness();
      if (readiness.ready && readiness.blockers.length === 0) {
        setState({ status: 'ready', capability });
        return;
      }
      const challenge = await service.getSponsorChallengeConfig();
      setState({
        status: 'setup',
        capability,
        ...(challenge.siteKey === undefined ? {} : { siteKey: challenge.siteKey }),
        stage: 'eligibility',
      });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'This private reimbursement could not be restored.',
        ...(error instanceof BrowserApiError && error.requestId !== undefined
          ? { reference: error.requestId }
          : {}),
      });
    }
  }, [client, reference, service]);

  useEffect(() => {
    void load();
  }, [load]);

  const prepareAccount = async () => {
    if (state.status !== 'setup' || challengeToken === undefined) return;
    setSetupPending(true);
    setSetupError(undefined);
    try {
      if (state.stage === 'eligibility') {
        const eligibility = await service.evaluateWalletPreparation(challengeToken);
        if (eligibility.grantRequired) {
          setChallengeToken(undefined);
          setState({ ...state, stage: 'grant' });
          return;
        }
        const readiness = await service.prepareWalletAccount();
        if (!readiness.ready || readiness.blockers.length > 0) {
          throw new Error('Account preparation is not canonically confirmed yet.');
        }
      } else {
        const readiness = await service.prepareWalletAccount(challengeToken);
        if (!readiness.ready || readiness.blockers.length > 0) {
          throw new Error('Account preparation is not canonically confirmed yet.');
        }
      }
      setState({ status: 'ready', capability: state.capability });
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Account preparation failed.');
    } finally {
      setSetupPending(false);
    }
  };

  if (state.status === 'loading') return <PageSkeleton label="Restoring reimbursement" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="This split link cannot be used"
      />
    );
  }
  if (state.status === 'auth') {
    return (
      <AuthPanel
        body="Your embedded account will reimburse only this private, exact request."
        deterministic={false}
        onAuthenticated={() => void load()}
        onEmailSignIn={async (email) => {
          await service.signInWithEmail(email, `/split/${encodeURIComponent(reference)}`);
        }}
        onGoogleSignIn={() => service.beginGoogleSignIn(`/split/${encodeURIComponent(reference)}`)}
        title="Sign in to reimburse your friend"
      />
    );
  }
  if (state.status === 'setup') {
    return (
      <section className="reimbursement-card">
        <p className="eyebrow">One-time account setup</p>
        <h1>Prepare your secure payment account</h1>
        <p>Your address stays the same. Reimbursement approval remains a separate exact step.</p>
        {state.siteKey === undefined ? (
          <InlineAlert title="Account setup unavailable" tone="danger">
            <p>The protected setup challenge is not configured. No grant was requested.</p>
          </InlineAlert>
        ) : (
          <TurnstileChallenge
            key={state.stage}
            onToken={receiveChallenge}
            siteKey={state.siteKey}
          />
        )}
        {state.stage === 'grant' ? (
          <InlineAlert title="Fresh approval required" tone="info">
            <p>Complete this new challenge for the single bounded setup grant.</p>
          </InlineAlert>
        ) : null}
        {setupError === undefined ? null : (
          <InlineAlert title="Account setup did not continue" tone="warning">
            <p>{setupError}</p>
          </InlineAlert>
        )}
        <Button
          disabled={state.siteKey === undefined || challengeToken === undefined}
          loading={setupPending}
          onClick={() => void prepareAccount()}
          size="large"
        >
          {state.stage === 'eligibility' ? 'Check setup eligibility' : 'Prepare account'}
        </Button>
      </section>
    );
  }

  const mapped = view(reference, state.capability);
  let activeOperation = state.capability.operation;
  return (
    <ReimbursementCheckout
      actions={{
        async prepare() {
          let operation = activeOperation;
          if (operation === undefined) {
            const response = await client.prepareSplitPayment(
              state.capability.split.id,
              reference,
              durablePrepareKey(reference),
            );
            operation = response.operation;
            activeOperation = operation;
            setState({
              status: 'ready',
              capability: {
                ...state.capability,
                existingPayment: response.payment,
                operation,
              },
            });
          }
          if (operation.status !== 'prepared') {
            throw new BrowserApiError({
              code: 'PAYMENT_ALREADY_SUBMITTED',
              message: 'This reimbursement already crossed the submission boundary.',
              submissionPossible: true,
              status: 0,
            });
          }
          const prepared = await service.prepareContractOperation(operation);
          return {
            estimatedFeeUsd: prepared.plan.quote.estimatedFeeUsd,
            maximumTotalUsd: prepared.plan.quote.totalUsd,
          };
        },
        async submit() {
          if (activeOperation === undefined) {
            throw new BrowserApiError({
              code: 'PAYMENT_PREVIEW_RELOAD_REQUIRED',
              message: 'Refresh this invitation to recover its exact operation.',
              retryable: true,
              status: 0,
            });
          }
          const result = await service.submitContractOperation(activeOperation.id);
          activeOperation = result.operation;
          return resultFromOperation(result.operation);
        },
        async getStatus() {
          if (activeOperation === undefined) {
            throw new BrowserApiError({
              code: 'PAYMENT_PREVIEW_RELOAD_REQUIRED',
              message: 'Refresh this invitation to recover its durable status.',
              retryable: true,
              status: 0,
            });
          }
          activeOperation = await service.getContractOperation(activeOperation.id);
          return resultFromOperation(activeOperation);
        },
      }}
      invitation={mapped.invitation}
      split={mapped.split}
    />
  );
}
