import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveJudgeProofPage } from './live-judge-proof-page';
import { recordedPublicJudgeProof as proof } from './public-judge-proof.test-fixture';

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('live Judge proof capability handling', () => {
  it('scrubs a fragment capability before loading and never renders or logs it', async () => {
    const capability = 'private_judge_capability_1234567890';
    window.history.replaceState(null, '', `/judge/${proof.orderId}#token=${capability}`);
    const calls: unknown[][] = [];
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation((...input) => calls.push(input)),
      vi.spyOn(console, 'warn').mockImplementation((...input) => calls.push(input)),
      vi.spyOn(console, 'log').mockImplementation((...input) => calls.push(input)),
    ];
    const getJudgeProof = vi.fn(async (_orderId: string, token?: string) => {
      expect(window.location.hash).toBe('');
      expect(window.location.href).not.toContain(capability);
      expect(token).toBe(capability);
      return { proof, requestId: 'req_judge_component' };
    });

    render(<LiveJudgeProofPage client={{ getJudgeProof }} orderId={proof.orderId} />);

    expect(
      await screen.findByText('One account. One routed balance. One canonical order.'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(capability);
    expect(JSON.stringify(calls)).not.toContain(capability);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('loads a public proof without manufacturing a capability', async () => {
    window.history.replaceState(null, '', `/judge/${proof.orderId}`);
    const getJudgeProof = vi.fn(async () => ({ proof, requestId: 'req_judge_public' }));
    const event = proof.settlement.event;
    if (event.eventName !== 'OrderPaid') throw new Error('The Judge fixture must be OrderPaid.');

    render(<LiveJudgeProofPage client={{ getJudgeProof }} orderId={proof.orderId} />);

    await screen.findByText('One account. One routed balance. One canonical order.');
    expect(getJudgeProof).toHaveBeenCalledWith(proof.orderId, undefined);
    expect(screen.getAllByText(proof.orderId).length).toBeGreaterThan(0);
    expect(screen.getByText(proof.settlement.receiptId)).toBeInTheDocument();
    expect(screen.getAllByText(proof.settlement.passTokenId).length).toBeGreaterThan(0);
    expect(screen.getByText(event.fields.orderKey)).toBeInTheDocument();
    expect(screen.getByText('0.75%')).toBeInTheDocument();
    expect(screen.getByText('14,750 ms')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Particle activity/ })).toHaveAttribute(
      'href',
      proof.particle.activityUrl,
    );
    expect(screen.getByRole('link', { name: /Open checkout contract/ })).toHaveAttribute(
      'href',
      `https://arbiscan.io/address/${proof.settlement.checkoutAddress}`,
    );
    expect(screen.getByRole('link', { name: /Open block/ })).toHaveAttribute(
      'href',
      `https://arbiscan.io/block/${event.blockNumber}`,
    );
  });

  it('scrubs and rejects a malformed fragment without sending it', async () => {
    const malformed = 'secret with spaces';
    window.history.replaceState(null, '', `/judge/${proof.orderId}#token=${malformed}`);
    const getJudgeProof = vi.fn();

    render(<LiveJudgeProofPage client={{ getJudgeProof }} orderId={proof.orderId} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(window.location.hash).toBe('');
    expect(document.body.textContent).not.toContain(malformed);
    expect(getJudgeProof).not.toHaveBeenCalled();
  });
});
