import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthPanel } from './auth-panel';

describe('AuthPanel', () => {
  it('labels deterministic sign-in honestly and exposes equivalent methods', () => {
    render(<AuthPanel deterministic onAuthenticated={vi.fn()} />);
    expect(
      screen.getByText(
        'This local path simulates the normalized result. It does not contact Magic.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Continue with email' })).toBeEnabled();
  });

  it('preserves email input and presents an associated validation error', () => {
    render(<AuthPanel deterministic onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
    const input = screen.getByRole('textbox', { name: /Email address/ });
    fireEvent.change(input, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
    expect(input).toHaveValue('not-an-email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    expect(screen.getByText('Enter a complete email address.')).toBeVisible();
  });
});
