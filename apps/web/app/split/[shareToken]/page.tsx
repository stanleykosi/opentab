import type { Metadata } from 'next';
import { demoSplit } from '../../../src/client/deterministic-data';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import type { SplitInvitationView } from '../../../src/client/view-models';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';
import { LiveReimbursementPage } from '../../../src/components/split/live-reimbursement-page';
import { ReimbursementCheckout } from '../../../src/components/split/reimbursement-checkout';
import { ErrorState } from '../../../src/components/states';

export const metadata: Metadata = {
  title: 'Private reimbursement',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function SplitPage({ params }: { params: Promise<{ shareToken: string }> }) {
  const { shareToken } = await params;
  const features = getServerFeatureState();
  const found = demoSplit.invitations.find((item) => item.shareToken === shareToken);
  const invitationTemplate = demoSplit.invitations[1];
  const syntheticUnknown: SplitInvitationView | undefined =
    shareToken === 'share-unknown-demo' && invitationTemplate
      ? {
          ...invitationTemplate,
          id: 'spi_demo_unknown',
          shareToken,
          status: 'submitted_unknown',
        }
      : undefined;
  const invitation = found ?? syntheticUnknown;
  return (
    <CustomerShell features={features}>
      {!features.splits ? (
        <FeatureUnavailable
          body="No reimbursement can start while this feature is disabled."
          title="Reimbursement unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveReimbursementPage reference={shareToken} />
      ) : features.mode === 'deterministic' && invitation ? (
        <ReimbursementCheckout invitation={invitation} split={demoSplit} />
      ) : features.mode === 'deterministic' ? (
        <ErrorState
          body="This private invitation is invalid, expired, or was rotated. No reimbursement was started."
          title="This split link cannot be used"
        />
      ) : (
        <FeatureUnavailable
          body="The private reimbursement service is not configured in this environment."
          title="Reimbursement unavailable"
        />
      )}
    </CustomerShell>
  );
}
