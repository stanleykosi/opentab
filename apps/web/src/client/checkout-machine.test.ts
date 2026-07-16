import { describe, expect, it } from 'vitest';
import { checkoutMachine, paymentCanRepeat } from './checkout-machine';
import { demoCheckout } from './deterministic-data';
import { createActor } from './xstate-runtime.js';

function stateValueOf(actor: ReturnType<typeof createCheckoutActor>): string {
  return String(actor.getSnapshot().value);
}

function createCheckoutActor(state: Parameters<typeof demoCheckout>[0]) {
  return createActor(checkoutMachine, { input: demoCheckout(state) }).start();
}

describe('checkout machine safety boundaries', () => {
  it('restores an unresolved submitted workflow into do-not-repeat status', () => {
    const actor = createCheckoutActor('waiting_for_arbitrum');
    expect(stateValueOf(actor)).toBe('submitted_status_unknown');
    expect(paymentCanRepeat(stateValueOf(actor), actor.getSnapshot().context)).toBe(false);
  });

  it('blocks a second payment as soon as approval begins', () => {
    const actor = createCheckoutActor('preview_ready');
    expect(stateValueOf(actor)).toBe('preview_ready');
    actor.send({ type: 'CONFIRM_PAYMENT' });
    expect(stateValueOf(actor)).toBe('signing_root_hash');
    expect(paymentCanRepeat(stateValueOf(actor), actor.getSnapshot().context)).toBe(false);
  });

  it('does not confirm until canonical OrderPaid reaches required depth', () => {
    const actor = createCheckoutActor('preview_ready');
    actor.send({ type: 'CONFIRM_PAYMENT' });
    actor.send({ type: 'SIGNATURE_APPROVED' });
    actor.send({ type: 'SUBMISSION_REGISTERED' });
    actor.send({ type: 'PROVIDER_EXECUTED' });
    expect(stateValueOf(actor)).toBe('waiting_for_arbitrum');
    actor.send({
      type: 'CANONICAL_CONFIRMED',
      proof: {
        eventName: 'OrderPaid',
        canonical: true,
        confirmations: '1',
        requiredConfirmations: '2',
        transactionHash: '0x6d65d60f18fcfa3a2dc8b73d4b5ee2a7b32f628c3af4fc8f0f44de4d87ee8f31',
        blockNumber: '351204118',
        observedAt: '2026-07-10T10:34:38.000Z',
      },
    });
    expect(stateValueOf(actor)).toBe('waiting_for_arbitrum');
    actor.send({
      type: 'CANONICAL_CONFIRMED',
      proof: {
        eventName: 'OrderPaid',
        canonical: true,
        confirmations: '2',
        requiredConfirmations: '2',
        transactionHash: '0x6d65d60f18fcfa3a2dc8b73d4b5ee2a7b32f628c3af4fc8f0f44de4d87ee8f31',
        blockNumber: '351204119',
        observedAt: '2026-07-10T10:35:02.000Z',
      },
    });
    expect(stateValueOf(actor)).toBe('confirmed');
  });

  it('moves an ambiguous submission timeout to status checking without retry', () => {
    const actor = createCheckoutActor('preview_ready');
    actor.send({ type: 'CONFIRM_PAYMENT' });
    actor.send({ type: 'TIMEOUT_AFTER_POSSIBLE_SUBMISSION' });
    expect(stateValueOf(actor)).toBe('submitted_status_unknown');
    expect(paymentCanRepeat(stateValueOf(actor), actor.getSnapshot().context)).toBe(false);
  });
});
