import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../../src/client/presentation-mode';
import { LiveOrderDetail } from '../../../../src/components/merchant/live-order-detail';
import { FeatureUnavailable, MerchantShell } from '../../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Order detail',
  robots: { index: false, follow: false },
};

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant/orders" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Order finance actions require an authenticated merchant application service."
          title="Order unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveOrderDetail features={features} orderId={orderId} />
      ) : (
        <DeterministicOrder features={features} orderId={orderId} />
      )}
    </MerchantShell>
  );
}

async function DeterministicOrder({
  features,
  orderId,
}: {
  features: ReturnType<typeof getServerFeatureState>;
  orderId: string;
}) {
  const [{ notFound }, { demoDashboard }, { OrderDetail }] = await Promise.all([
    import('next/navigation'),
    import('../../../../src/client/deterministic-data'),
    import('../../../../src/components/merchant/details'),
  ]);
  const order = demoDashboard.orders.find((item) => item.id === orderId);
  if (order === undefined) return notFound();
  return <OrderDetail features={features} order={order} />;
}
