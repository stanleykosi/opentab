import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserApiError } from '../application/browser-api-client';
import { AuthCallback } from './auth-callback';

describe('live authentication callback', () => {
  it('exchanges the provider result through the application service', async () => {
    const completeGoogleSignIn = vi.fn(async () => ({
      returnPath: '/checkout/chk_live_http',
    }));

    render(<AuthCallback mode="live" service={{ completeGoogleSignIn } as never} />);

    expect(await screen.findByRole('heading', { name: 'Sign-in complete' })).toBeVisible();
    expect(completeGoogleSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/token/i)).toHaveTextContent(
      'No token or callback detail is shown on this page.',
    );
  });

  it('fails closed on invalid continuation state without exposing a demo checkout link', async () => {
    const completeGoogleSignIn = vi.fn(async () => {
      throw new BrowserApiError({
        code: 'AUTH_STATE_MISMATCH',
        message: 'Invalid continuation.',
        status: 0,
      });
    });

    render(<AuthCallback mode="live" service={{ completeGoogleSignIn } as never} />);

    expect(
      await screen.findByRole('heading', { name: 'This return link is not valid' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Return home' })).toHaveAttribute('href', '/');
    expect(document.querySelector('a[href*="chk_demo"]')).toBeNull();
  });
});
