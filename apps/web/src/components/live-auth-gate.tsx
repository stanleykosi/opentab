'use client';

import { Button, LinkButton } from '@opentab/ui';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserApiError, type BrowserSession } from '../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../application/browser-application-service';
import { AuthPanel } from './auth-panel';
import { ErrorState, PageSkeleton } from './states';

export type LiveAuthGateService = Pick<
  BrowserApplicationService,
  'beginGoogleSignIn' | 'restoreSession' | 'signInWithEmail'
>;

type GateState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'ready'; session: BrowserSession }
  | { status: 'error'; message: string; reference?: string };

function safeReturnPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const base = new URL('https://opentab.invalid');
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || parsed.pathname === '/auth/callback') return '/';
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function browserReturnPath(): string {
  if (typeof window === 'undefined') return '/';
  return safeReturnPath(`${window.location.pathname}${window.location.search}`);
}

export function LiveAuthGate({
  authBody,
  authTitle,
  children,
  requireMerchant = false,
  returnPath,
  service: providedService,
}: {
  authBody?: string;
  authTitle?: string;
  children: ReactNode;
  requireMerchant?: boolean;
  returnPath?: string;
  service?: LiveAuthGateService;
}) {
  const service = useMemo(
    () => providedService ?? getBrowserApplicationService(),
    [providedService],
  );
  const [state, setState] = useState<GateState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', session: await service.restoreSession() });
    } catch (error) {
      if (error instanceof BrowserApiError && error.code === 'AUTH_REQUIRED') {
        setState({ status: 'anonymous' });
        return;
      }
      setState({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'OpenTab could not verify this application session.',
        ...(error instanceof BrowserApiError && error.requestId !== undefined
          ? { reference: error.requestId }
          : {}),
      });
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  const continuation = () => safeReturnPath(returnPath ?? browserReturnPath());

  if (state.status === 'loading') return <PageSkeleton label="Checking secure sign-in" />;
  if (state.status === 'anonymous') {
    return (
      <AuthPanel
        body={
          authBody ??
          'Continue with Google or email. Your secure OpenTab account is restored automatically, with no wallet extension required.'
        }
        deterministic={false}
        onAuthenticated={() => void load()}
        onEmailSignIn={async (email) => {
          await service.signInWithEmail(email, continuation());
        }}
        onGoogleSignIn={() => service.beginGoogleSignIn(continuation())}
        title={authTitle ?? 'Sign in to OpenTab'}
      />
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorState
        action={
          <Button onClick={() => void load()} variant="secondary">
            Try sign-in check again
          </Button>
        }
        body={`${state.message} No wallet or payment action was started.`}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Sign-in status unavailable"
      />
    );
  }
  if (requireMerchant && state.session.user.merchantMemberships.length === 0) {
    return (
      <section className="unavailable-panel">
        <p className="eyebrow">Merchant setup</p>
        <h1>Create your merchant profile</h1>
        <p>
          You are signed in, but this account does not own or manage a merchant yet. Create the
          customer-facing storefront and add its payout destination to continue.
        </p>
        <LinkButton href="/merchant/onboarding">Create merchant profile</LinkButton>
      </section>
    );
  }
  return children;
}

export const __authGateTestables = { safeReturnPath };
