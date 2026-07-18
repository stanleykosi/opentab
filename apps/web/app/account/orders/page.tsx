import type { Metadata } from 'next';
import { demoDashboard } from '../../../src/client/deterministic-data';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { AccountOrders } from '../../../src/components/account/account-view';
import { LiveAccountOrders } from '../../../src/components/account/live-account-page';
import { LiveAuthGate } from '../../../src/components/live-auth-gate';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';

export const metadata: Metadata = { title: 'Your orders', robots: { index: false, follow: false } };

export default function AccountOrdersPage() {
  const features = getServerFeatureState();
  return (
    <CustomerShell features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Order history requires a configured authenticated server session."
          title="Order history unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveAuthGate
          authBody="Continue with the Google or email account used for your purchases to see verified payment and receipt updates."
          authTitle="Sign in to see your orders"
          returnPath="/account/orders"
        >
          <LiveAccountOrders />
        </LiveAuthGate>
      ) : (
        <AccountOrders dashboard={demoDashboard} />
      )}
    </CustomerShell>
  );
}
