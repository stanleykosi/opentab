'use client';

import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import {
  BrowserApiClient,
  BrowserApiError,
  type SplitCreateResponse,
  SplitCreateResponseSchema,
} from '../../application/browser-api-client';
import type { SplitView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { SplitBuilder, type SplitCreationInput, type SplitCreationResult } from './split-builder';

interface ReadyState {
  readonly status: 'ready';
  readonly beneficiary: string;
  readonly split: SplitView;
  readonly cached?: SplitCreateResponse;
  readonly revocation: RevocationRecovery;
}

const RevocationRecoverySchema = z
  .object({
    status: z.enum(['active', 'revoking', 'revoked']),
    operationIds: z.array(z.string().regex(/^cop_[0-9A-HJKMNP-TV-Z]{26}$/)).max(50),
  })
  .strict();
type RevocationRecovery = z.infer<typeof RevocationRecoverySchema>;

type State =
  | { readonly status: 'loading' }
  | ReadyState
  | { readonly status: 'error'; readonly message: string; readonly reference?: string };

function storageKey(orderId: string, suffix: 'idempotency' | 'result' | 'revocation'): string {
  return `opentab.split.${orderId}.${suffix}`;
}

function readRevocation(orderId: string): RevocationRecovery {
  const raw = window.sessionStorage.getItem(storageKey(orderId, 'revocation'));
  if (raw !== null) {
    try {
      const parsed = RevocationRecoverySchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Invalid local recovery data is discarded below.
    }
    window.sessionStorage.removeItem(storageKey(orderId, 'revocation'));
  }
  return { status: 'active', operationIds: [] };
}

function writeRevocation(orderId: string, value: RevocationRecovery): void {
  window.sessionStorage.setItem(storageKey(orderId, 'revocation'), JSON.stringify(value));
}

function readCachedResult(orderId: string): SplitCreateResponse | undefined {
  const value = window.sessionStorage.getItem(storageKey(orderId, 'result'));
  if (value === null) return undefined;
  try {
    const parsed = SplitCreateResponseSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    // Invalid local recovery data is discarded and never trusted as payment state.
  }
  window.sessionStorage.removeItem(storageKey(orderId, 'result'));
  return undefined;
}

function durableIdempotencyKey(orderId: string): string {
  const key = storageKey(orderId, 'idempotency');
  const existing = window.sessionStorage.getItem(key);
  if (existing !== null && existing.length >= 16 && existing.length <= 128) return existing;
  const created = `web.split-create.${crypto.randomUUID()}`;
  window.sessionStorage.setItem(key, created);
  return created;
}

function creationResult(value: SplitCreateResponse): SplitCreationResult {
  return { splitId: value.splitId, invitations: value.invitations };
}

export function LiveSplitBuilder({
  client: providedClient,
  orderId,
}: {
  client?: BrowserApiClient;
  orderId: string;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void client
      .restoreSession()
      .then(async (session) => {
        const receipt = await client.getReceipt(orderId);
        if (!['paid', 'partially_refunded'].includes(receipt.order.status)) {
          throw new BrowserApiError({
            code: 'PAYMENT_NOT_CANONICAL',
            message: 'Only a confirmed purchase can be split.',
            status: 0,
          });
        }
        const netPaid =
          BigInt(receipt.order.paidAmountBaseUnits) - BigInt(receipt.order.refundedAmountBaseUnits);
        if (netPaid <= 0n) {
          throw new BrowserApiError({
            code: 'VALIDATION_FAILED',
            message: 'This purchase has no remaining confirmed amount to split.',
            status: 0,
          });
        }
        const cached = readCachedResult(orderId);
        const revocation = readRevocation(orderId);
        if (!active) return;
        setState({
          status: 'ready',
          beneficiary: session.user.walletAddress,
          split: {
            id: cached?.splitId ?? `pending-${orderId}`,
            orderId,
            purchaserAlias: 'You',
            productTitle: receipt.product.title,
            totalBaseUnits: netPaid.toString(),
            confirmedBaseUnits: '0',
            status: 'active',
            invitations:
              cached?.invitations.map((invitation) => ({
                id: invitation.invitationId,
                participantLabel: invitation.participantLabel,
                amountBaseUnits: invitation.amountBaseUnits,
                status: 'unpaid',
                shareToken: invitation.capabilityReference,
                expiresAt: invitation.expiresAt,
              })) ?? [],
            expiresAt:
              cached?.invitations[0]?.expiresAt ??
              new Date(Date.now() + 7 * 86_400_000).toISOString(),
          },
          ...(cached === undefined ? {} : { cached }),
          revocation,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'OpenTab could not verify this purchase for splitting.',
          ...(error instanceof BrowserApiError && error.requestId !== undefined
            ? { reference: error.requestId }
            : {}),
        });
      });
    return () => {
      active = false;
    };
  }, [client, orderId]);

  if (state.status === 'loading') return <PageSkeleton label="Loading confirmed purchase" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Split unavailable"
      />
    );
  }

  return (
    <SplitBuilder
      createSplit={async (input: SplitCreationInput) => {
        const response = await client.createSplit(
          orderId,
          {
            beneficiary: state.beneficiary,
            totalBaseUnits: input.totalBaseUnits,
            expiresAt: input.expiresAt,
            participants: input.participants,
          },
          durableIdempotencyKey(orderId),
        );
        window.sessionStorage.setItem(storageKey(orderId, 'result'), JSON.stringify(response));
        return creationResult(response);
      }}
      initial={state.split}
      {...(state.cached === undefined ? {} : { initialCreated: creationResult(state.cached) })}
      initialRevocationStatus={state.revocation.status}
      checkRevocation={async () => {
        const recovery = readRevocation(orderId);
        if (recovery.status === 'revoked') return { status: 'revoked' as const };
        if (recovery.status !== 'revoking') {
          throw new BrowserApiError({
            code: 'RESPONSE_INVALID',
            message: 'No durable revocation operation is available to check.',
            status: 0,
          });
        }
        const operations = await Promise.all(
          recovery.operationIds.map((operationId) => client.getContractOperation(operationId)),
        );
        if (operations.some((operation) => ['failed', 'orphaned'].includes(operation.status))) {
          throw new BrowserApiError({
            code: 'PAYMENT_FAILED_CONFIRMED',
            message: 'A payment-key revocation failed confirmation. Operator review is required.',
            status: 0,
          });
        }
        if (operations.every((operation) => operation.status === 'confirmed')) {
          const confirmed = { status: 'revoked' as const, operationIds: recovery.operationIds };
          writeRevocation(orderId, confirmed);
          return { status: 'revoked' as const };
        }
        return { status: 'revoking' as const };
      }}
      revokeSplit={async (splitId) => {
        const response = await client.revokeSplit(
          splitId,
          'Revoked by the purchaser from the private split page.',
          `web.split-revoke.${crypto.randomUUID()}`,
        );
        const recovery = {
          status: response.status,
          operationIds:
            response.status === 'revoking'
              ? response.operations.map((operation) => operation.id)
              : [],
        } satisfies RevocationRecovery;
        writeRevocation(orderId, recovery);
        return { status: response.status };
      }}
      shareOrigin={window.location.origin}
    />
  );
}
