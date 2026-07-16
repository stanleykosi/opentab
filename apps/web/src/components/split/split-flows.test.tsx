import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SplitInvitationView, SplitView } from '../../client/view-models';
import { ReimbursementCheckout } from './reimbursement-checkout';
import { SplitBuilder, type SplitCreationInput } from './split-builder';

const invitation: SplitInvitationView = {
  id: `spi_${'0'.repeat(26)}`,
  participantLabel: 'Alex',
  amountBaseUnits: '9000000',
  status: 'unpaid',
  shareToken: `spi_${'0'.repeat(26)}.${'a'.repeat(43)}`,
  expiresAt: '2027-07-14T09:00:00.000Z',
};

const split: SplitView = {
  id: `spl_${'0'.repeat(26)}`,
  orderId: `ord_${'0'.repeat(26)}`,
  purchaserAlias: 'Sam',
  productTitle: 'Sunday Table',
  totalBaseUnits: '18000000',
  confirmedBaseUnits: '0',
  status: 'active',
  invitations: [invitation],
  expiresAt: invitation.expiresAt,
};

describe('split flows', () => {
  it('creates exact private capabilities and revokes unpaid invitations through bound callbacks', async () => {
    const createSplit = vi.fn(async (_input: SplitCreationInput) => ({
      splitId: split.id,
      invitations: [
        {
          invitationId: invitation.id,
          participantLabel: 'Alex',
          amountBaseUnits: '9000000',
          capabilityReference: invitation.shareToken,
          expiresAt: invitation.expiresAt,
        },
        {
          invitationId: `spi_${'1'.repeat(26)}`,
          participantLabel: 'Jo',
          amountBaseUnits: '9000000',
          capabilityReference: `spi_${'1'.repeat(26)}.${'b'.repeat(43)}`,
          expiresAt: invitation.expiresAt,
        },
      ],
    }));
    const revokeSplit = vi.fn(async () => ({ status: 'revoked' as const }));
    render(
      <SplitBuilder
        createSplit={createSplit}
        initial={split}
        revokeSplit={revokeSplit}
        shareOrigin="https://opentab.example"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create private links' }));
    expect(
      await screen.findByRole('heading', { name: 'Your private links are ready' }),
    ).toBeInTheDocument();
    expect(createSplit).toHaveBeenCalledTimes(1);
    const input = createSplit.mock.calls[0]?.[0];
    expect(input?.participants.map((item) => item.amountBaseUnits)).toEqual(['9000000', '9000000']);
    expect(input?.totalBaseUnits).toBe('18000000');
    expect(screen.getByText(new RegExp(invitation.id))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke all unpaid invitations' }));
    await waitFor(() => expect(revokeSplit).toHaveBeenCalledWith(split.id));
    expect(await screen.findByText('Split revoked')).toBeInTheDocument();
  });

  it('does not submit a reimbursement until the exact fee preview is confirmed', async () => {
    const actions = {
      prepare: vi.fn(async () => ({ estimatedFeeUsd: '0.09', maximumTotalUsd: '9.09' })),
      submit: vi.fn(async () => ({ status: 'submitted' as const })),
      getStatus: vi.fn(async () => ({ status: 'paid' as const })),
    };
    render(<ReimbursementCheckout actions={actions} invitation={invitation} split={split} />);

    fireEvent.click(screen.getByRole('button', { name: 'Review exact reimbursement' }));
    expect(await screen.findByText('$0.09')).toBeInTheDocument();
    expect(actions.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm reimbursement of/ }));
    await waitFor(() => expect(actions.submit).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole('heading', { name: 'Confirming your reimbursement' }),
    ).toBeInTheDocument();
  });

  it('keeps managed revocation pending until canonical operation checks confirm', async () => {
    const checkRevocation = vi.fn(async () => ({ status: 'revoked' as const }));
    render(
      <SplitBuilder
        checkRevocation={checkRevocation}
        initial={split}
        initialCreated={{
          splitId: split.id,
          invitations: [
            {
              invitationId: invitation.id,
              participantLabel: invitation.participantLabel,
              amountBaseUnits: invitation.amountBaseUnits,
              capabilityReference: invitation.shareToken,
              expiresAt: invitation.expiresAt,
            },
          ],
        }}
        initialRevocationStatus="revoking"
      />,
    );

    expect(screen.getByText('Revocation is reconciling')).toBeInTheDocument();
    expect(screen.queryByText('Split revoked')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check revocation status' }));
    expect(await screen.findByText('Split revoked')).toBeInTheDocument();
    expect(checkRevocation).toHaveBeenCalledTimes(1);
  });

  it('recovers submitted-unknown reimbursement status without offering another approval', async () => {
    const actions = {
      prepare: vi.fn(),
      submit: vi.fn(),
      getStatus: vi.fn(async () => ({ status: 'paid' as const })),
    };
    render(
      <ReimbursementCheckout
        actions={actions}
        invitation={{ ...invitation, status: 'submitted_unknown' }}
        split={split}
      />,
    );

    expect(screen.queryByRole('button', { name: /Confirm reimbursement/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Confirmed reimbursement')).toBeInTheDocument();
    expect(actions.prepare).not.toHaveBeenCalled();
    expect(actions.submit).not.toHaveBeenCalled();
  });
});
