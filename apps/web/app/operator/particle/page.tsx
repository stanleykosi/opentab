import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { ParticleCertificationConsole } from '../../../src/components/operator/particle-certification-console';
import { CustomerShell } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Activate payments',
  robots: { index: false, follow: false },
};

export default function ParticleCertificationPage() {
  return (
    <CustomerShell features={getServerFeatureState()} narrow={false}>
      <ParticleCertificationConsole />
    </CustomerShell>
  );
}
