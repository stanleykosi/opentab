import { describe, expect, it, vi } from 'vitest';
import { createTurnstileChallengeVerifier } from '../src/turnstile.js';

describe('Turnstile challenge verifier', () => {
  it('posts the token to the official verifier and enforces hostname', async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: 'opentab.example',
            action: 'opentab-bootstrap',
          }),
          { status: 200 },
        ),
    );
    const verifier = createTurnstileChallengeVerifier({
      secretKey: 'turnstile-secret-material-for-test',
      expectedHostname: 'opentab.example',
      expectedAction: 'opentab-bootstrap',
      fetchImplementation: request,
    });
    await expect(verifier.verify('challenge-token-material')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = request.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('response')).toBe('challenge-token-material');
  });

  it('fails closed on rejection, hostname mismatch, and transport errors', async () => {
    for (const payload of [
      { success: false, hostname: 'opentab.example', action: 'opentab-bootstrap' },
      { success: true, hostname: 'attacker.example', action: 'opentab-bootstrap' },
      { success: true, hostname: 'opentab.example' },
      { success: true, hostname: 'opentab.example', action: 'other-action' },
    ]) {
      const verifier = createTurnstileChallengeVerifier({
        secretKey: 'turnstile-secret-material-for-test',
        expectedHostname: 'opentab.example',
        expectedAction: 'opentab-bootstrap',
        fetchImplementation: vi.fn(async () => new Response(JSON.stringify(payload))),
      });
      await expect(verifier.verify('challenge-token-material')).rejects.toMatchObject({
        code: 'SPONSOR_INELIGIBLE',
      });
    }
    const unavailable = createTurnstileChallengeVerifier({
      secretKey: 'turnstile-secret-material-for-test',
      fetchImplementation: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    await expect(unavailable.verify('challenge-token-material')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: true,
    });
  });
});
