import type { Metadata } from 'next';
import { demoReceipt } from '../../src/client/deterministic-data';
import { getServerFeatureState } from '../../src/client/presentation-mode';
import { AccountOverview } from '../../src/components/account/account-view';
import { LiveAccountOverview } from '../../src/components/account/live-account-page';
import { LiveAuthGate } from '../../src/components/live-auth-gate';
import { CustomerShell, FeatureUnavailable } from '../../src/components/shell';

export const metadata: Metadata = {
  title: 'Your account',
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  const features = getServerFeatureState();
  return (
    <CustomerShell features={features} narrow={false}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Account data requires a configured authenticated server session."
          title="Account unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveAuthGate
          authBody="Continue with the Google or email account used for your purchases. Your passes appear here automatically."
          authTitle="Sign in to see your passes"
          returnPath="/account"
        >
          <LiveAccountOverview />
        </LiveAuthGate>
      ) : (
        <AccountOverview receipt={demoReceipt} />
      )}
    </CustomerShell>
  );
}
