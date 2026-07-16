'use client';

import {
  Button,
  CanonicalStatus,
  CopyButton,
  decimalToBaseUnits,
  InlineAlert,
  MoneyAmount,
  ProgressMeter,
  SelectField,
  TextField,
} from '@opentab/ui';
import { useEffect, useMemo, useState } from 'react';
import type { SplitView } from '../../client/view-models';

interface DraftParticipant {
  id: string;
  label: string;
  amount: string;
}

export interface SplitCreationInput {
  readonly totalBaseUnits: string;
  readonly expiresAt: string;
  readonly participants: readonly { label: string; amountBaseUnits: string }[];
}

export interface SplitCreationResult {
  readonly splitId: string;
  readonly invitations: readonly {
    invitationId: string;
    participantLabel: string;
    amountBaseUnits: string;
    capabilityReference: string;
    expiresAt: string;
  }[];
}

export interface SplitRevocationResult {
  readonly status: 'revoking' | 'revoked';
}

function baseUnitsToDecimal(value: string): string {
  const padded = value.padStart(7, '0');
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return fraction.length === 0 ? padded.slice(0, -6) : `${padded.slice(0, -6)}.${fraction}`;
}

function initialParticipants(totalBaseUnits: string): readonly DraftParticipant[] {
  const total = BigInt(totalBaseUnits);
  const first = total / 2n;
  return [
    { id: 'draft-1', label: 'Alex', amount: baseUnitsToDecimal(first.toString()) },
    { id: 'draft-2', label: 'Jo', amount: baseUnitsToDecimal((total - first).toString()) },
  ];
}

export function SplitBuilder({
  createSplit,
  initial,
  initialCreated,
  initialRevocationStatus = 'active',
  checkRevocation,
  revokeSplit,
  shareOrigin = 'https://opentab.example',
}: {
  initial: SplitView;
  initialCreated?: SplitCreationResult;
  initialRevocationStatus?: 'active' | 'revoking' | 'revoked';
  shareOrigin?: string;
  createSplit?: (input: SplitCreationInput) => Promise<SplitCreationResult>;
  revokeSplit?: (splitId: string) => Promise<SplitRevocationResult>;
  checkRevocation?: () => Promise<SplitRevocationResult>;
}) {
  const [participants, setParticipants] = useState<readonly DraftParticipant[]>(() =>
    initialParticipants(initial.totalBaseUnits),
  );
  const [expiryDays, setExpiryDays] = useState('7');
  const [created, setCreated] = useState<SplitCreationResult | undefined>(initialCreated);
  const [pending, setPending] = useState<'create' | 'revoke'>();
  const [revocationStatus, setRevocationStatus] = useState(initialRevocationStatus);
  const [error, setError] = useState<string>();
  const allocated = useMemo(() => {
    try {
      return participants
        .reduce((sum, participant) => sum + BigInt(decimalToBaseUnits(participant.amount)), 0n)
        .toString();
    } catch {
      return undefined;
    }
  }, [participants]);
  const exact = allocated === initial.totalBaseUnits;

  useEffect(() => {
    if (revocationStatus !== 'revoking' || checkRevocation === undefined) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void checkRevocation()
        .then((result) => setRevocationStatus(result.status))
        .catch((caught: unknown) =>
          setError(caught instanceof Error ? caught.message : 'Revocation status is unavailable.'),
        );
    };
    const interval = window.setInterval(check, 5_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
    };
  }, [checkRevocation, revocationStatus]);

  if (created !== undefined) {
    return (
      <div className="split-layout">
        <header className="page-heading">
          <CanonicalStatus label="Split active" tone="confirmed" />
          <p className="eyebrow">{initial.productTitle}</p>
          <h1>Your private links are ready</h1>
          <p>
            Each link is for one participant and exact amount. Copy them now; OpenTab stores only
            protected capability hashes after issuance.
          </p>
        </header>
        {revocationStatus === 'revoked' ? (
          <InlineAlert title="Split revoked" tone="success">
            <p>Unpaid invitations can no longer start a reimbursement.</p>
          </InlineAlert>
        ) : revocationStatus === 'revoking' ? (
          <InlineAlert title="Revocation is reconciling" tone="warning">
            <p>
              Payment-key revocations were durably submitted. Links remain in a protected pending
              state until every canonical revocation event is indexed.
            </p>
          </InlineAlert>
        ) : null}
        <div className="invite-list">
          {created.invitations.map((invitation) => {
            const url = `${shareOrigin}/split/${encodeURIComponent(invitation.capabilityReference)}`;
            return (
              <article className="invite-card" key={invitation.invitationId}>
                <div>
                  <strong>{invitation.participantLabel}</strong>
                  <MoneyAmount baseUnits={invitation.amountBaseUnits} />
                </div>
                <p className="mono invite-url">{url}</p>
                <p>
                  Expires{' '}
                  {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                    new Date(invitation.expiresAt),
                  )}
                </p>
                <div className="page-actions">
                  <CopyButton label={`Copy ${invitation.participantLabel}'s link`} value={url} />
                </div>
              </article>
            );
          })}
        </div>
        <InlineAlert title="Private by design" tone="info">
          <p>
            Links show only the purchaser alias, product, amount, and expiry—not email, balances, or
            the original payment details.
          </p>
        </InlineAlert>
        {error === undefined ? null : (
          <InlineAlert title="Split could not be changed" tone="danger">
            <p>{error}</p>
          </InlineAlert>
        )}
        {revocationStatus === 'active' && revokeSplit !== undefined ? (
          <Button
            loading={pending === 'revoke'}
            onClick={() => {
              setPending('revoke');
              setError(undefined);
              void revokeSplit(created.splitId)
                .then((result) => setRevocationStatus(result.status))
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : 'Split revocation failed.'),
                )
                .finally(() => setPending(undefined));
            }}
            variant="danger"
          >
            Revoke all unpaid invitations
          </Button>
        ) : null}
        {revocationStatus === 'revoking' && checkRevocation !== undefined ? (
          <Button
            onClick={() => {
              void checkRevocation()
                .then((result) => setRevocationStatus(result.status))
                .catch((caught: unknown) =>
                  setError(
                    caught instanceof Error ? caught.message : 'Revocation status is unavailable.',
                  ),
                );
            }}
            variant="secondary"
          >
            Check revocation status
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="split-layout">
      <header className="page-heading">
        <p className="eyebrow">Split purchase</p>
        <h1>Who is paying you back?</h1>
        <p>
          Allocate the exact <MoneyAmount baseUnits={initial.totalBaseUnits} /> purchase.
          Reimbursements are separate from the merchant order.
        </p>
      </header>
      <div className="participant-list">
        {participants.map((participant, index) => (
          <fieldset className="participant-card" key={participant.id}>
            <legend>Person {index + 1}</legend>
            <TextField
              label="Name or nickname"
              onChange={(event) =>
                setParticipants((current) =>
                  current.map((item) =>
                    item.id === participant.id
                      ? { ...item, label: event.currentTarget.value }
                      : item,
                  ),
                )
              }
              value={participant.label}
            />
            <TextField
              description="USDC amount, up to six decimal places"
              inputMode="decimal"
              label="Amount"
              onChange={(event) =>
                setParticipants((current) =>
                  current.map((item) =>
                    item.id === participant.id
                      ? { ...item, amount: event.currentTarget.value }
                      : item,
                  ),
                )
              }
              value={participant.amount}
            />
            <Button
              disabled={participants.length <= 2}
              onClick={() =>
                setParticipants((current) => current.filter((item) => item.id !== participant.id))
              }
              variant="quiet"
            >
              Remove person
            </Button>
          </fieldset>
        ))}
      </div>
      <Button
        onClick={() =>
          setParticipants((current) => [
            ...current,
            {
              id: `draft-${current.length + 1}`,
              label: `Friend ${current.length + 1}`,
              amount: '0.00',
            },
          ])
        }
        variant="secondary"
      >
        Add another person
      </Button>
      <SelectField
        description="All private links expire together. Submitted reimbursements are reconciled separately."
        label="Invitation expiry"
        onChange={(event) => setExpiryDays(event.currentTarget.value)}
        value={expiryDays}
      >
        <option value="1">24 hours</option>
        <option value="3">3 days</option>
        <option value="7">7 days</option>
      </SelectField>
      <section className="allocation-total">
        <div>
          <span>Allocated</span>
          {allocated ? <MoneyAmount baseUnits={allocated} /> : <strong>Invalid amount</strong>}
        </div>
        <div>
          <span>Purchase total</span>
          <MoneyAmount baseUnits={initial.totalBaseUnits} />
        </div>
      </section>
      {!exact ? (
        <InlineAlert title="Amounts must match the purchase" tone="warning">
          <p>
            Adjust the amounts until the allocated total is exactly{' '}
            <MoneyAmount baseUnits={initial.totalBaseUnits} />. No floating-point rounding is used.
          </p>
        </InlineAlert>
      ) : null}
      {error ? (
        <InlineAlert title="Split was not created" tone="danger">
          <p>{error}</p>
        </InlineAlert>
      ) : null}
      <Button
        disabled={
          pending !== undefined ||
          !exact ||
          participants.some((participant) => participant.label.trim().length === 0)
        }
        loading={pending === 'create'}
        onClick={() => {
          setError(undefined);
          setPending('create');
          const input = {
            totalBaseUnits: initial.totalBaseUnits,
            expiresAt: new Date(Date.now() + Number(expiryDays) * 86_400_000).toISOString(),
            participants: participants.map((participant) => ({
              label: participant.label.trim(),
              amountBaseUnits: decimalToBaseUnits(participant.amount),
            })),
          } satisfies SplitCreationInput;
          const create =
            createSplit ??
            (async () => ({
              splitId: initial.id,
              invitations: input.participants.map((participant, index) => ({
                invitationId: `spi_demo_${index + 1}`,
                participantLabel: participant.label,
                amountBaseUnits: participant.amountBaseUnits,
                capabilityReference: initial.invitations[index]?.shareToken ?? `demo-${index + 1}`,
                expiresAt: input.expiresAt,
              })),
            }));
          void create(input)
            .then(setCreated)
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : 'Split creation failed.'),
            )
            .finally(() => setPending(undefined));
        }}
        size="large"
      >
        Create private links
      </Button>
    </div>
  );
}

export function SplitProgressView({ split }: { split: SplitView }) {
  return (
    <div className="split-layout">
      <header className="page-heading">
        <CanonicalStatus
          label={split.status.replaceAll('_', ' ')}
          tone={split.status === 'complete' ? 'confirmed' : 'processing'}
        />
        <p className="eyebrow">Split progress</p>
        <h1>{split.productTitle}</h1>
        <p>
          Confirmed reimbursements count toward progress. Submitted payments stay separate while
          checking.
        </p>
      </header>
      <ProgressMeter
        current={split.confirmedBaseUnits}
        detail={`${baseUnitsToDecimal((BigInt(split.totalBaseUnits) - BigInt(split.confirmedBaseUnits)).toString())} USDC remains confirmed-unpaid.`}
        label="Confirmed reimbursement"
        target={split.totalBaseUnits}
      />
      <div className="invite-list">
        {split.invitations.map((invite) => (
          <article className="invite-card" key={invite.id}>
            <div>
              <strong>{invite.participantLabel}</strong>
              <MoneyAmount baseUnits={invite.amountBaseUnits} />
            </div>
            <CanonicalStatus
              label={invite.status.replaceAll('_', ' ')}
              tone={
                invite.status === 'paid'
                  ? 'confirmed'
                  : invite.status === 'unpaid'
                    ? 'neutral'
                    : invite.status === 'revoked' || invite.status === 'expired'
                      ? 'failed'
                      : 'processing'
              }
            />
            <p>
              Expires{' '}
              {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                new Date(invite.expiresAt),
              )}
            </p>
            <div className="page-actions">
              <CopyButton
                label={`Copy ${invite.participantLabel}'s link`}
                value={`https://opentab.example/split/${invite.shareToken}`}
              />
              <Button variant="quiet">Rotate</Button>
              <Button variant="quiet">Revoke</Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
