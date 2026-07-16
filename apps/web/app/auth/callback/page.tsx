import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { AuthCallback } from '../../../src/components/auth-callback';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Verifying sign-in',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const outcomes = [
  'verifying',
  'success',
  'rejected',
  'expired',
  'invalid_continuation',
  'session_error',
] as const;

export default async function CallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string }>;
}) {
  const query = await searchParams;
  const features = getServerFeatureState();
  const initialState =
    features.mode === 'deterministic' &&
    outcomes.includes(query.outcome as (typeof outcomes)[number])
      ? (query.outcome as (typeof outcomes)[number])
      : 'verifying';
  if (features.mode === 'live-unavailable') {
    return (
      <CustomerShell features={features}>
        <FeatureUnavailable
          body="The live authentication callback stays disabled until the server exchange and safe continuation adapter are connected."
          title="Sign-in callback unavailable"
        />
      </CustomerShell>
    );
  }
  return <AuthCallback initialState={initialState} mode={features.mode} />;
}
