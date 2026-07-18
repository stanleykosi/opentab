import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountSetupPanel } from './account-setup-panel';

describe('AccountSetupPanel', () => {
  it('allows canonical self-funded preparation when the sponsor challenge is off', async () => {
    const onReady = vi.fn();
    const service = {
      checkWalletReadiness: vi.fn().mockResolvedValue({ ready: false, blockers: ['delegation'] }),
      getSponsorChallengeConfig: vi.fn().mockResolvedValue({}),
      evaluateWalletPreparation: vi.fn(),
      prepareWalletAccount: vi.fn(),
      prepareSelfFundedWalletAccount: vi.fn().mockResolvedValue({ ready: true, blockers: [] }),
    };

    render(<AccountSetupPanel onReady={onReady} service={service as never} />);

    expect(await screen.findByText('Sponsored setup unavailable')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare with my Arbitrum ETH' }));

    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(service.prepareSelfFundedWalletAccount).toHaveBeenCalledOnce();
    expect(service.prepareWalletAccount).not.toHaveBeenCalled();
    expect(service.evaluateWalletPreparation).not.toHaveBeenCalled();
  });
});
