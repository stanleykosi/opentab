import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionControl } from './session-control';

describe('live session control', () => {
  it('checks the secure session without rotating it and logs out only after user intent', async () => {
    const getCurrentSession = vi.fn(async () => ({ user: { id: 'user' } }));
    let finishLogout: (() => void) | undefined;
    const logout = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLogout = resolve;
        }),
    );

    render(<SessionControl service={{ getCurrentSession, logout } as never} />);

    const button = await screen.findByRole('button', { name: 'Sign out' });
    expect(getCurrentSession).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
    expect(logout).toHaveBeenCalledTimes(1);
    finishLogout?.();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument(),
    );
  });
});
