import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { LiveAuthGate } from '../../../src/components/live-auth-gate';
import { LiveMerchantOnboarding } from '../../../src/components/merchant/live-onboarding-settings';
import { MerchantOnboarding } from '../../../src/components/merchant/onboarding-settings';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Merchant onboarding',
  robots: { index: false, follow: false },
};

export default function OnboardingPage() {
  const features = getServerFeatureState();
  return (
    <CustomerShell features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Merchant creation requires an authenticated application service and verified payout ownership."
          title="Onboarding unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveAuthGate
          authBody="Continue with Google or email to create your storefront. OpenTab sets up secure payment access automatically."
          authTitle="Sign in to start selling"
          returnPath="/merchant/onboarding"
        >
          <LiveMerchantOnboarding />
        </LiveAuthGate>
      ) : (
        <MerchantOnboarding />
      )}
    </CustomerShell>
  );
}
