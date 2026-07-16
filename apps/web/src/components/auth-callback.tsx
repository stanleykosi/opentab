'use client';

import { InlineAlert, LinkButton } from '@opentab/ui';
import { useEffect, useRef, useState } from 'react';
import { BrowserApiError } from '../application/browser-api-client';
import type { BrowserApplicationService } from '../application/browser-application-service';
import { getBrowserApplicationService } from '../application/browser-application-service';
import type { PresentationMode } from '../client/view-models';

type CallbackState =
  | 'verifying'
  | 'success'
  | 'rejected'
  | 'expired'
  | 'invalid_continuation'
  | 'session_error';

export function AuthCallback({
  initialState = 'verifying',
  mode,
  service = getBrowserApplicationService(),
}: {
  initialState?: CallbackState;
  mode: PresentationMode;
  service?: Pick<BrowserApplicationService, 'completeGoogleSignIn'>;
}) {
  const [state, setState] = useState<CallbackState>(initialState);
  const [returnPath, setReturnPath] = useState('/');
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state) headingRef.current?.focus();
  }, [state]);
  useEffect(() => {
    if (state !== 'verifying' || mode !== 'deterministic') return;
    const timeout = window.setTimeout(() => setState('success'), 700);
    return () => window.clearTimeout(timeout);
  }, [mode, state]);
  useEffect(() => {
    if (state !== 'verifying' || mode !== 'live') return;
    let active = true;
    void service
      .completeGoogleSignIn()
      .then((session) => {
        if (!active) return;
        const next = session.returnPath;
        setReturnPath(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
        setState('success');
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof BrowserApiError) {
          setState(
            error.code === 'AUTH_STATE_MISMATCH'
              ? 'invalid_continuation'
              : error.code === 'AUTH_EXPIRED'
                ? 'expired'
                : error.retryable
                  ? 'session_error'
                  : 'rejected',
          );
          return;
        }
        setState('session_error');
      });
    return () => {
      active = false;
    };
  }, [mode, service, state]);
  useEffect(() => {
    if (state !== 'success') return;
    const timeout = window.setTimeout(
      () =>
        window.location.replace(
          mode === 'deterministic' ? '/checkout/chk_demo_sunday_table' : returnPath,
        ),
      650,
    );
    return () => window.clearTimeout(timeout);
  }, [mode, returnPath, state]);
  return (
    <main className="auth-callback" id="main-content">
      <div className="working-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <p className="eyebrow">Secure sign-in</p>
      <h1 ref={headingRef} tabIndex={-1}>
        {state === 'verifying'
          ? 'Verifying your sign-in'
          : state === 'success'
            ? 'Sign-in complete'
            : state === 'rejected'
              ? 'Sign-in was not approved'
              : state === 'expired'
                ? 'This sign-in expired'
                : state === 'invalid_continuation'
                  ? 'This return link is not valid'
                  : 'Your browser sign-in needs another try'}
      </h1>
      {state === 'verifying' ? (
        <p role="status">
          OpenTab is exchanging a short-lived provider result for a secure application session.
        </p>
      ) : null}
      {state === 'success' ? (
        <InlineAlert title="Returning to checkout" tone="success">
          <p>
            Your application session is ready. No token or callback detail is shown on this page.
          </p>
        </InlineAlert>
      ) : null}
      {state === 'rejected' ? (
        <>
          <p>No application session was created and no payment started.</p>
          <LinkButton href={mode === 'deterministic' ? '/checkout/chk_demo_sunday_table' : '/'}>
            {mode === 'deterministic' ? 'Return to checkout' : 'Return home'}
          </LinkButton>
        </>
      ) : null}
      {state === 'expired' ? (
        <>
          <p>
            The provider result is too old to use safely. Start sign-in again from the checkout.
          </p>
          <LinkButton href={mode === 'deterministic' ? '/checkout/chk_demo_sunday_table' : '/'}>
            {mode === 'deterministic' ? 'Restart sign-in' : 'Return home'}
          </LinkButton>
        </>
      ) : null}
      {state === 'invalid_continuation' ? (
        <>
          <p>OpenTab only returns to an allowlisted, opaque checkout continuation.</p>
          <LinkButton href="/">Return home</LinkButton>
        </>
      ) : null}
      {state === 'session_error' ? (
        <>
          <p>
            Your provider session may still be active. OpenTab can retry the server exchange without
            repeating payment.
          </p>
          <button
            className="ot-button ot-button--secondary"
            onClick={() => setState('verifying')}
            type="button"
          >
            Try session exchange again
          </button>
        </>
      ) : null}
      {mode === 'live-unavailable' ? (
        <InlineAlert title="Live authentication is disabled" tone="warning">
          <p>The provider adapter is not configured. No authentication request was started.</p>
        </InlineAlert>
      ) : null}
    </main>
  );
}
