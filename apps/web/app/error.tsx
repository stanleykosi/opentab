'use client';

import { Button } from '@opentab/ui';
import { ErrorState } from '../src/components/states';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="state-page" id="main-content">
      <ErrorState
        action={<Button onClick={reset}>Try loading again</Button>}
        body="OpenTab could not render this page. No money action was retried."
        reference={error.digest?.slice(0, 12) ?? 'PAGE-RENDER'}
        title="This page needs another try"
      />
    </main>
  );
}
