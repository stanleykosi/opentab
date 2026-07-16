import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { LiveMerchantSettings } from '../../../src/components/merchant/live-onboarding-settings';
import { MerchantSettings } from '../../../src/components/merchant/onboarding-settings';
import { FeatureUnavailable, MerchantShell } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Merchant settings',
  robots: { index: false, follow: false },
};

export default function SettingsPage() {
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant/settings" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Settings require an authenticated merchant session."
          title="Settings unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveMerchantSettings />
      ) : (
        <MerchantSettings />
      )}
    </MerchantShell>
  );
}
