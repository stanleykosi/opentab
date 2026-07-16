import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import type { CheckoutState } from '../../../src/client/view-models';
import { CheckoutWorkflow } from '../../../src/components/checkout/checkout-workflow';
import { LiveCheckoutPage } from '../../../src/components/checkout/live-checkout-page';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false, follow: false } };

const states: readonly CheckoutState[] = [
  'product_ready',
  'creating_session',
  'authenticating',
  'checking_readiness',
  'sponsor_required',
  'preparing_account',
  'loading_balance',
  'ready_to_pay',
  'preparing_payment',
  'preview_ready',
  'signing_root_hash',
  'submitting_particle',
  'waiting_for_particle',
  'waiting_for_arbitrum',
  'submitted_status_unknown',
  'confirmed',
  'retryable_failure',
  'terminal_failure',
  'expired',
];

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ checkoutSessionId: string }>;
  searchParams: Promise<{ state?: string; quantity?: string }>;
}) {
  const { checkoutSessionId } = await params;
  const query = await searchParams;
  const features = getServerFeatureState();
  if (features.mode === 'live-unavailable' || !features.payments) {
    return (
      <CustomerShell features={features} narrow={false}>
        <FeatureUnavailable
          body="No provider or contract action can start until the live payment canary is enabled and its adapters pass readiness checks."
          title="Live checkout is safely disabled"
        />
      </CustomerShell>
    );
  }
  if (features.mode === 'live') {
    return (
      <CustomerShell features={features} narrow={false}>
        <LiveCheckoutPage checkoutSessionId={checkoutSessionId} />
      </CustomerShell>
    );
  }

  const [{ demoCheckout }, { repriceCheckoutQuantity }] = await Promise.all([
    import('../../../src/client/deterministic-data'),
    import('../../../src/client/quote-money'),
  ]);
  const state = states.includes(query.state as CheckoutState)
    ? (query.state as CheckoutState)
    : 'product_ready';
  const quantity = query.quantity && /^[1-4]$/.test(query.quantity) ? query.quantity : '1';
  const initial = repriceCheckoutQuantity({ ...demoCheckout(state), checkoutSessionId }, quantity);
  return (
    <CustomerShell features={features} narrow={false}>
      <CheckoutWorkflow initial={initial} mode={features.mode} />
    </CustomerShell>
  );
}
