'use client';

import { Button, InlineAlert, TextField } from '@opentab/ui';
import { useState } from 'react';

export function AuthPanel({
  body = 'Sign in securely. Your account and payment access are created automatically.',
  onAuthenticated,
  deterministic,
  title = 'Continue to checkout',
  onEmailSignIn,
  onGoogleSignIn,
}: {
  onAuthenticated: () => void;
  deterministic: boolean;
  title?: string;
  body?: string;
  onEmailSignIn?: (email: string) => Promise<void>;
  onGoogleSignIn?: () => Promise<void>;
}) {
  const [emailMode, setEmailMode] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<'email' | 'google'>();

  const googleSignIn = async () => {
    setError(undefined);
    if (deterministic) {
      onAuthenticated();
      return;
    }
    if (onGoogleSignIn === undefined) {
      setError('Secure Google sign-in is not available in this environment.');
      return;
    }
    setPending('google');
    try {
      await onGoogleSignIn();
    } catch (caught) {
      setPending(undefined);
      setError(caught instanceof Error ? caught.message : 'Google sign-in could not continue.');
    }
  };

  const emailSignIn = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Enter a complete email address.');
      document.getElementById('auth-email')?.focus();
      return;
    }
    setError(undefined);
    if (deterministic) {
      onAuthenticated();
      return;
    }
    if (onEmailSignIn === undefined) {
      setError('Secure email sign-in is not available in this environment.');
      document.getElementById('auth-email')?.focus();
      return;
    }
    setPending('email');
    try {
      await onEmailSignIn(email);
      onAuthenticated();
    } catch (caught) {
      setPending(undefined);
      setError(caught instanceof Error ? caught.message : 'Email sign-in could not continue.');
      document.getElementById('auth-email')?.focus();
    }
  };
  return (
    <section aria-labelledby="auth-title" className="auth-panel">
      <p className="eyebrow">Secure sign-in</p>
      <h2 id="auth-title">{title}</h2>
      <p>{body}</p>
      {deterministic ? (
        <InlineAlert title="Demo sign-in" tone="info">
          This local path simulates the normalized result. It does not contact Magic.
        </InlineAlert>
      ) : null}
      {error ? (
        <InlineAlert title="Sign-in did not continue" tone="danger">
          <p>{error} No payment was started.</p>
        </InlineAlert>
      ) : null}
      {!emailMode ? (
        <div className="auth-actions">
          <Button
            loading={pending === 'google'}
            loadingLabel="Opening secure Google sign-in"
            onClick={() => void googleSignIn()}
            size="large"
          >
            Continue with Google
          </Button>
          <Button onClick={() => setEmailMode(true)} size="large" variant="secondary">
            Continue with email
          </Button>
        </div>
      ) : (
        <form
          className="auth-email"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void emailSignIn();
          }}
        >
          <TextField
            autoComplete="email"
            id="auth-email"
            label="Email address"
            onChange={(event) => setEmail(event.currentTarget.value)}
            placeholder="you@example.com"
            required
            type="email"
            value={email}
            {...(error === undefined || /^\S+@\S+\.\S+$/.test(email) ? {} : { error })}
          />
          <p className="field-note">
            You’ll receive a one-time code. Email and Google provide the same checkout access.
          </p>
          <div className="form-actions">
            <Button
              loading={pending === 'email'}
              loadingLabel="Verifying your email code"
              type="submit"
            >
              Continue with email
            </Button>
            <Button onClick={() => setEmailMode(false)} variant="quiet">
              Back
            </Button>
          </div>
        </form>
      )}
      <p className="privacy-note">
        By continuing, you agree to the merchant’s terms and OpenTab’s privacy notice.
      </p>
    </section>
  );
}
