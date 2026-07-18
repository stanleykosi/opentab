import type { Metadata } from 'next';
import { demoReceipt } from '../../../src/client/deterministic-data';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import type { OrderCanonicalStatus, ReceiptView } from '../../../src/client/view-models';
import { LiveAuthGate } from '../../../src/components/live-auth-gate';
import { LiveReceiptPage } from '../../../src/components/receipt/live-receipt-page';
import { ReceiptPageView } from '../../../src/components/receipt/receipt-view';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Receipt and pass',
  robots: { index: false, follow: false },
};

const statusMap: Record<string, OrderCanonicalStatus> = {
  submitted: 'submitted',
  confirming: 'confirming',
  paid: 'paid',
  partial: 'partially_refunded',
  refunded: 'refunded',
  investigation: 'investigation',
};

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { orderId } = await params;
  const query = await searchParams;
  const features = getServerFeatureState();
  const inferred = orderId.includes('3F8')
    ? 'confirming'
    : orderId.includes('9AA')
      ? 'partially_refunded'
      : 'paid';
  const status = query.status ? (statusMap[query.status] ?? inferred) : inferred;
  const receipt: ReceiptView = {
    ...demoReceipt,
    orderId,
    status,
    passStatus:
      status === 'refunded'
        ? 'refunded'
        : status === 'paid' || status === 'partially_refunded'
          ? 'valid'
          : status === 'investigation'
            ? 'investigation'
            : 'pending',
    refundBaseUnits:
      status === 'partially_refunded'
        ? '3000000'
        : status === 'refunded'
          ? demoReceipt.amountBaseUnits
          : '0',
    ...(status === 'submitted' || status === 'confirming' || status === 'investigation'
      ? { confirmedAt: undefined, transactionHash: undefined }
      : {}),
  };
  return (
    <CustomerShell features={features} narrow={false}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Private receipt data is unavailable until the authenticated server query is configured."
          title="Receipt unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveAuthGate
          authBody="Continue with the Google or email account that completed this purchase."
          authTitle="Sign in to view this receipt"
          returnPath={`/receipt/${encodeURIComponent(orderId)}`}
        >
          <LiveReceiptPage features={features} orderId={orderId} />
        </LiveAuthGate>
      ) : (
        <ReceiptPageView features={features} receipt={receipt} />
      )}
    </CustomerShell>
  );
}
