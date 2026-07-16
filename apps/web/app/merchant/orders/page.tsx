import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { LiveMerchantConsole } from '../../../src/components/merchant/live-merchant-console';
import { FeatureUnavailable, MerchantShell } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Merchant orders',
  robots: { index: false, follow: false },
};

export default function OrdersPage() {
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant/orders" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Order records require an authenticated merchant application service."
          title="Orders unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveMerchantConsole view="orders" />
      ) : (
        <DeterministicOrders />
      )}
    </MerchantShell>
  );
}

async function DeterministicOrders() {
  const [{ demoDashboard }, { MerchantOrders }] = await Promise.all([
    import('../../../src/client/deterministic-data'),
    import('../../../src/components/merchant/dashboard'),
  ]);
  return <MerchantOrders dashboard={demoDashboard} />;
}
