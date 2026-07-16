import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { LiveMerchantConsole } from '../../../src/components/merchant/live-merchant-console';
import { FeatureUnavailable, MerchantShell } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Merchant products',
  robots: { index: false, follow: false },
};

export default function ProductsPage() {
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant/products" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Product records require an authenticated merchant application service."
          title="Products unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveMerchantConsole view="products" />
      ) : (
        <DeterministicProducts />
      )}
    </MerchantShell>
  );
}

async function DeterministicProducts() {
  const [{ demoDashboard }, { MerchantProducts }] = await Promise.all([
    import('../../../src/client/deterministic-data'),
    import('../../../src/components/merchant/dashboard'),
  ]);
  return <MerchantProducts dashboard={demoDashboard} />;
}
