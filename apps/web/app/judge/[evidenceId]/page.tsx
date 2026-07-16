import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { LiveJudgeProofPage } from '../../../src/components/judge/live-judge-proof-page';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Judge Mode evidence',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function JudgePage({ params }: { params: Promise<{ evidenceId: string }> }) {
  const { evidenceId } = await params;
  const features = getServerFeatureState();
  if (!features.judgeMode || features.mode === 'live-unavailable')
    return (
      <CustomerShell features={features}>
        <FeatureUnavailable
          body="Judge Mode is feature-gated and this environment has not enabled public-safe evidence."
          title="Evidence unavailable"
        />
      </CustomerShell>
    );
  if (features.mode === 'live') return <LiveJudgeProofPage orderId={evidenceId} />;
  const [{ demoJudgeProof }, { JudgeProof }] = await Promise.all([
    import('../../../src/client/deterministic-data'),
    import('../../../src/components/judge/judge-proof'),
  ]);
  return <JudgeProof proof={{ ...demoJudgeProof, evidenceId }} />;
}
