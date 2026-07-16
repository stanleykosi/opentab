import { LinkButton } from '@opentab/ui';
import { ErrorState } from '../src/components/states';

export default function NotFound() {
  return (
    <main className="state-page" id="main-content">
      <ErrorState
        action={<LinkButton href="/">Return home</LinkButton>}
        body="The link may have expired, been revoked, or moved. No payment was started."
        title="We couldn’t find that tab"
      />
    </main>
  );
}
