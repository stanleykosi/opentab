import type { HumanChallengeVerifierPort } from '@opentab/application';
import { AppError } from '@opentab/shared';
import { z } from 'zod';

const TurnstileResponseSchema = z
  .object({
    success: z.boolean(),
    hostname: z.string().min(1).max(253).optional(),
    action: z.string().min(1).max(64).optional(),
    'error-codes': z.array(z.string().max(100)).max(20).optional(),
  })
  .passthrough();

export interface TurnstileChallengeVerifierConfig {
  readonly secretKey: string;
  readonly expectedHostname?: string;
  readonly expectedAction?: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export function createTurnstileChallengeVerifier(
  config: TurnstileChallengeVerifierConfig,
): HumanChallengeVerifierPort {
  if (config.secretKey.length < 16 || config.secretKey.length > 512) {
    throw new AppError('CONFIGURATION_INVALID', 'The challenge verifier secret is invalid.');
  }
  const timeoutMs = config.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15_000) {
    throw new AppError('CONFIGURATION_INVALID', 'The challenge verifier timeout is invalid.');
  }
  const request = config.fetchImplementation ?? fetch;
  return {
    async verify(token) {
      if (token.length < 16 || token.length > 4_096) {
        throw new AppError('SPONSOR_INELIGIBLE', 'Account preparation could not be verified.');
      }
      let response: Response;
      try {
        response = await request('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: config.secretKey, response: token }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AppError(
          'INTERNAL_ERROR',
          'Account preparation verification is temporarily unavailable.',
          { retryable: true, cause: error },
        );
      }
      if (!response.ok) {
        throw new AppError(
          'INTERNAL_ERROR',
          'Account preparation verification is temporarily unavailable.',
          { retryable: true },
        );
      }
      const result = TurnstileResponseSchema.parse(await response.json());
      const validHostname =
        config.expectedHostname === undefined || result.hostname === config.expectedHostname;
      const validAction =
        config.expectedAction === undefined || result.action === config.expectedAction;
      if (!result.success || !validHostname || !validAction) {
        throw new AppError('SPONSOR_INELIGIBLE', 'Account preparation could not be verified.');
      }
    },
  };
}
