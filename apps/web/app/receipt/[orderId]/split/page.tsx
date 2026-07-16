import type { Metadata } from 'next';
import { demoSplit } from '../../../../src/client/deterministic-data';
import { getServerFeatureState } from '../../../../src/client/presentation-mode';
import { CustomerShell, FeatureUnavailable } from '../../../../src/components/shell';
import { LiveSplitBuilder } from '../../../../src/components/split/live-split-builder';
import { SplitBuilder, SplitProgressView } from '../../../../src/components/split/split-builder';

export const metadata: Metadata = {
  title: 'Split purchase',
  robots: { index: false, follow: false },
};

export default async function ReceiptSplitPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { orderId } = await params;
  const query = await searchParams;
  const features = getServerFeatureState();
  return (
    <CustomerShell features={features}>
      {!features.splits ? (
        <FeatureUnavailable
          body="Split reimbursement is disabled for this environment. The original merchant order is unchanged."
          title="Split is not available"
        />
      ) : features.mode === 'live' ? (
        <LiveSplitBuilder orderId={orderId} />
      ) : features.mode === 'deterministic' && query.view === 'progress' ? (
        <SplitProgressView split={demoSplit} />
      ) : features.mode === 'deterministic' ? (
        <SplitBuilder initial={demoSplit} />
      ) : (
        <FeatureUnavailable
          body="The authenticated split service is not configured in this environment."
          title="Split is not available"
        />
      )}
    </CustomerShell>
  );
}
