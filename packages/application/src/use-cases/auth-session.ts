import { AppError, type CurrentUser } from '@opentab/shared';
import type {
  ClockPort,
  IdempotencyRepositoryPort,
  MagicIdentityVerifierPort,
  RateLimitPort,
  SessionServicePort,
} from '../ports/index.js';

export interface ExchangeSessionResult {
  readonly user: CurrentUser;
  readonly plaintextToken: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

/**
 * Verifies a short-lived Magic proof and immediately exchanges it for an
 * opaque application session. Raw DID material never crosses persistence.
 */
export class ExchangeSessionUseCase {
  constructor(
    private readonly dependencies: {
      verifier: MagicIdentityVerifierPort;
      sessions: SessionServicePort;
      rateLimits: RateLimitPort;
      clock: ClockPort;
      expectedAudience: string;
      expectedApplicationId: string;
    },
  ) {}

  async execute(input: {
    didToken: string;
    tokenDigest: string;
    networkSubjectHash: string;
  }): Promise<ExchangeSessionResult> {
    if (input.didToken.length < 16 || input.didToken.length > 16_384) {
      throw new AppError('AUTH_DID_INVALID', 'The identity proof is invalid.');
    }
    if (
      !/^[a-f0-9]{64}$/.test(input.tokenDigest) ||
      !/^[a-f0-9]{64}$/.test(input.networkSubjectHash)
    ) {
      throw new AppError('VALIDATION_FAILED', 'The sign-in request digest is invalid.');
    }
    const networkDecision = await this.dependencies.rateLimits.consume({
      scope: 'auth-session-network',
      subjectHash: input.networkSubjectHash,
      limit: 10,
      windowSeconds: 60,
    });
    if (!networkDecision.allowed) {
      throw new AppError('RATE_LIMITED', 'Too many sign-in attempts. Please wait and try again.', {
        retryable: true,
        ...(networkDecision.retryAfterSeconds === undefined
          ? {}
          : { safeDetails: { retryAfterSeconds: networkDecision.retryAfterSeconds.toString() } }),
      });
    }

    const identity = await this.dependencies.verifier.verifyDidToken({
      didToken: input.didToken,
      expectedAudience: this.dependencies.expectedAudience,
      expectedApplicationId: this.dependencies.expectedApplicationId,
    });
    const proofLifetimeSeconds = Math.ceil(
      (new Date(identity.expiresAt).getTime() - this.dependencies.clock.now().getTime()) / 1_000,
    );
    if (!Number.isSafeInteger(proofLifetimeSeconds) || proofLifetimeSeconds < 1) {
      throw new AppError('AUTH_EXPIRED', 'The identity proof has expired.');
    }
    const proofDecision = await this.dependencies.rateLimits.consume({
      scope: 'auth-session-proof',
      subjectHash: input.tokenDigest,
      limit: 1,
      windowSeconds: Math.min(proofLifetimeSeconds, 86_400),
    });
    if (!proofDecision.allowed) {
      throw new AppError('AUTH_DID_INVALID', 'The identity proof was already used.');
    }
    return this.dependencies.sessions.create(identity);
  }
}

export class RefreshSessionUseCase {
  constructor(private readonly sessions: SessionServicePort) {}

  async execute(plaintextToken: string): Promise<ExchangeSessionResult> {
    return this.sessions.refresh(plaintextToken);
  }
}

export class LogoutSessionUseCase {
  constructor(private readonly sessions: SessionServicePort) {}

  async execute(plaintextToken: string): Promise<void> {
    await this.sessions.revoke(plaintextToken);
  }
}

/**
 * Idempotency repositories are intentionally not used for session exchange:
 * replaying their stored response would persist and re-expose the plaintext
 * session and CSRF secrets. DID proof replay is atomically rejected by the
 * rate-limit store; the HTTP request can recover by authenticating again.
 */
export type SessionExchangeIdempotencyBoundary = Pick<IdempotencyRepositoryPort, 'execute'>;
