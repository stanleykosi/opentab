'use client';

import { useEffect, useState } from 'react';
import {
  BrowserApiError,
  getPublicSessionApplicationService,
  type PublicSessionApplicationService,
} from '../application/public-session-api-client';

type SessionService = Pick<PublicSessionApplicationService, 'logout' | 'restoreSession'>;

export function SessionControl({
  service = getPublicSessionApplicationService(),
}: {
  service?: SessionService;
}) {
  const [state, setState] = useState<'checking' | 'anonymous' | 'signed_in' | 'signing_out'>(
    'checking',
  );
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void service
      .restoreSession()
      .then(() => {
        if (active) setState('signed_in');
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setState('anonymous');
        if (!(caught instanceof BrowserApiError) || caught.code !== 'AUTH_REQUIRED') {
          setError('Session status is temporarily unavailable.');
        }
      });
    return () => {
      active = false;
    };
  }, [service]);

  if (state === 'checking' || state === 'anonymous') {
    return error === undefined ? null : <span className="sr-status">{error}</span>;
  }
  return (
    <>
      {error === undefined ? null : <span className="sr-status">{error}</span>}
      <button
        className="ot-button ot-button--quiet ot-button--compact"
        disabled={state === 'signing_out'}
        onClick={() => {
          setError(undefined);
          setState('signing_out');
          void service
            .logout()
            .then(() => setState('anonymous'))
            .catch((caught: unknown) => {
              setState('signed_in');
              setError(caught instanceof Error ? caught.message : 'Sign-out could not finish.');
            });
        }}
        type="button"
      >
        {state === 'signing_out' ? 'Signing out…' : 'Sign out'}
      </button>
    </>
  );
}
