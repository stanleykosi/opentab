import type { Metadata } from 'next';
import { getServerFeatureState } from '../../src/client/presentation-mode';
import { CustomerShell } from '../../src/components/shell';
import { StatusPage } from '../../src/components/status-page';

export const metadata: Metadata = {
  title: 'System status',
  description: 'Product-level availability for OpenTab checkout, sign-in, and receipts.',
};

export default function SystemStatusPage() {
  const features = getServerFeatureState();
  return (
    <CustomerShell features={features}>
      <StatusPage features={features} />
    </CustomerShell>
  );
}
