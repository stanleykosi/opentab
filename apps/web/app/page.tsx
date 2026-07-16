import { getServerFeatureState } from '../src/client/presentation-mode';
import { MarketingHome } from '../src/components/marketing';

export default function HomePage() {
  return <MarketingHome features={getServerFeatureState()} />;
}
