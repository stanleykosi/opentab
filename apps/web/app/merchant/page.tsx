import type { Metadata } from 'next';
import { getServerFeatureState } from '../../src/client/presentation-mode';
import { LiveMerchantConsole } from '../../src/components/merchant/live-merchant-console';
import { FeatureUnavailable, MerchantShell } from '../../src/components/shell';

export const metadata: Metadata = {
  title: 'Merchant overview',
  robots: { index: false, follow: false },
};

export default function MerchantPage() {
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Merchant records require an authenticated live application service."
          title="Merchant console unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveMerchantConsole view="dashboard" />
      ) : (
        <DeterministicDashboard />
      )}
    </MerchantShell>
  );
}

async function DeterministicDashboard() {
  const [{ demoDashboard }, { MerchantDashboard }] = await Promise.all([
    import('../../src/client/deterministic-data'),
    import('../../src/components/merchant/dashboard'),
  ]);
  return <MerchantDashboard dashboard={demoDashboard} />;
}
