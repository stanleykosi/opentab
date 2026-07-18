import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserApiError, type BrowserSession } from '../application/browser-api-client';
import { BrowserSessionSchema } from '../application/public-session-api-client';
import { __authGateTestables, LiveAuthGate, type LiveAuthGateService } from './live-auth-gate';

const id = '0'.repeat(26);

function session(merchant = false): BrowserSession {
  return BrowserSessionSchema.parse({
    user: {
      id: `usr_${id}`,
      walletAddress: '0x1111111111111111111111111111111111111111',
      authMethod: 'google',
      status: 'active',
      merchantMemberships: merchant ? [{ merchantId: `mer_${id}`, role: 'owner' }] : [],
    },
    csrfToken: 'c'.repeat(32),
    expiresAt: '2026-07-19T12:00:00.000Z',
    requestId: 'req_auth_gate',
  });
}

function authRequired() {
  return new BrowserApiError({
    code: 'AUTH_REQUIRED',
    message: 'Sign in required.',
    status: 401,
  });
}

function service(overrides: Partial<LiveAuthGateService> = {}): LiveAuthGateService {
  return {
    restoreSession: vi.fn().mockResolvedValue(session()),
    beginGoogleSignIn: vi.fn().mockResolvedValue(undefined),
    signInWithEmail: vi.fn().mockResolvedValue(session()),
    ...overrides,
  };
}

describe('LiveAuthGate', () => {
  it('restores an application session before rendering private content', async () => {
    const auth = service();
    render(
      <LiveAuthGate service={auth}>
        <h1>Your private content</h1>
      </LiveAuthGate>,
    );

    expect(screen.getByLabelText('Checking secure sign-in')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Your private content' })).toBeVisible();
    expect(auth.restoreSession).toHaveBeenCalledOnce();
  });

  it('offers Google sign-in with a safe current-route continuation', async () => {
    const auth = service({ restoreSession: vi.fn().mockRejectedValue(authRequired()) });
    window.history.replaceState({}, '', '/merchant/products?status=active');
    render(
      <LiveAuthGate service={auth}>
        <p>Merchant content</p>
      </LiveAuthGate>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() =>
      expect(auth.beginGoogleSignIn).toHaveBeenCalledWith('/merchant/products?status=active'),
    );
  });

  it('exchanges email sign-in and resumes the protected route', async () => {
    const restoreSession = vi
      .fn<LiveAuthGateService['restoreSession']>()
      .mockRejectedValueOnce(authRequired())
      .mockResolvedValueOnce(session());
    const auth = service({ restoreSession });
    render(
      <LiveAuthGate returnPath="/account/orders" service={auth}>
        <h1>Your orders</h1>
      </LiveAuthGate>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Email address/ }), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));

    expect(await screen.findByRole('heading', { name: 'Your orders' })).toBeVisible();
    expect(auth.signInWithEmail).toHaveBeenCalledWith('buyer@example.com', '/account/orders');
    expect(restoreSession).toHaveBeenCalledTimes(2);
  });

  it('directs an authenticated non-merchant to onboarding', async () => {
    render(
      <LiveAuthGate requireMerchant service={service()}>
        <p>Merchant dashboard</p>
      </LiveAuthGate>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Create your merchant profile' }),
    ).toBeVisible();
    expect(screen.queryByText('Merchant dashboard')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create merchant profile' })).toHaveAttribute(
      'href',
      '/merchant/onboarding',
    );
  });

  it('renders merchant content when the session has a membership', async () => {
    render(
      <LiveAuthGate
        requireMerchant
        service={service({ restoreSession: vi.fn().mockResolvedValue(session(true)) })}
      >
        <h1>Merchant dashboard</h1>
      </LiveAuthGate>,
    );
    expect(await screen.findByRole('heading', { name: 'Merchant dashboard' })).toBeVisible();
  });

  it('rejects external and callback return paths', () => {
    expect(__authGateTestables.safeReturnPath('//evil.example/merchant')).toBe('/');
    expect(__authGateTestables.safeReturnPath('https://evil.example/merchant')).toBe('/');
    expect(__authGateTestables.safeReturnPath('/auth/callback?next=/merchant')).toBe('/');
    expect(__authGateTestables.safeReturnPath('/merchant/orders?status=paid#ignored')).toBe(
      '/merchant/orders?status=paid',
    );
  });
});
