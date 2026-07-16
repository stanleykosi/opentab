'use client';

import { useLayoutEffect, useState } from 'react';
import { BrowserApiClient, BrowserApiError } from '../../application/browser-api-client';
import { mapPublicJudgeProofToView } from '../../application/live-view-mappers';
import { takeJudgeCapability } from '../../client/judge-capability';
import type { JudgeProofView } from '../../client/view-models';
import { ErrorState, PageSkeleton } from '../states';
import { JudgeProof } from './judge-proof';

type JudgeProofClient = Pick<BrowserApiClient, 'getJudgeProof'>;

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; proof: JudgeProofView }
  | { status: 'error'; message: string; reference?: string };

function safeError(error: unknown): { message: string; reference?: string } {
  if (error instanceof BrowserApiError) {
    return {
      message:
        error.code === 'NOT_FOUND'
          ? 'This proof is unavailable or its private access link is no longer valid.'
          : 'OpenTab could not load the public-safe proof. Try again from the order receipt.',
      ...(error.requestId === undefined ? {} : { reference: error.requestId }),
    };
  }
  return { message: 'OpenTab could not load the public-safe proof. Try again later.' };
}

export function LiveJudgeProofPage({
  orderId,
  client = new BrowserApiClient(),
}: {
  orderId: string;
  client?: JudgeProofClient;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useLayoutEffect(() => {
    let active = true;
    const result = takeJudgeCapability(window.location, window.history);
    if (result.kind === 'invalid') {
      setState({
        status: 'error',
        message: 'This private proof link is malformed. Request a new link from the merchant.',
      });
      return () => {
        active = false;
      };
    }

    const capability = result.kind === 'protected' ? result.capability : undefined;
    client
      .getJudgeProof(orderId, capability)
      .then(({ proof }) => {
        if (active) setState({ status: 'ready', proof: mapPublicJudgeProofToView(proof) });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'error', ...safeError(error) });
      });
    return () => {
      active = false;
    };
  }, [client, orderId]);

  if (state.status === 'loading') return <PageSkeleton label="Loading payment proof" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Evidence unavailable"
      />
    );
  }
  return <JudgeProof proof={state.proof} />;
}
