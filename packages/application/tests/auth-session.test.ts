import {
  AppError,
  CurrentUserSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  UserIdSchema,
  VerifiedMagicIdentitySchema,
} from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import type {
  MagicIdentityVerifierPort,
  RateLimitPort,
  SessionServicePort,
} from '../src/ports/index.js';
import {
  ExchangeSessionUseCase,
  LogoutSessionUseCase,
  RefreshSessionUseCase,
} from '../src/use-cases/auth-session.js';

const now = '2026-07-14T00:00:00.000Z';
const expiresAt = '2026-07-14T00:05:00.000Z';
const identity = VerifiedMagicIdentitySchema.parse({
  issuerHash: 'a'.repeat(64),
  walletAddress: EvmAddressSchema.parse(`0x${'1'.repeat(40)}`),
  issuedAt: now,
  expiresAt,
  audience: 'https://opentab.example',
  applicationId: 'pk_live_opentab',
  authMethod: 'email_otp',
  evidenceDigest: EvidenceDigestSchema.parse(`0x${'2'.repeat(64)}`),
});
const user = CurrentUserSchema.parse({
  id: UserIdSchema.parse('usr_01J00000000000000000000000'),
  walletAddress: identity.walletAddress,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});

function dependencies(input: { decisions?: readonly boolean[] } = {}) {
  const verifier: MagicIdentityVerifierPort = {
    verifyDidToken: vi.fn(async () => identity),
  };
  const sessions: SessionServicePort = {
    create: vi.fn(async () => ({
      user,
      plaintextToken: 'session-secret',
      csrfToken: 'csrf-secret-with-at-least-thirty-two-bytes',
      expiresAt: '2026-07-21T00:00:00.000Z',
    })),
    verify: vi.fn(async () => user),
    refresh: vi.fn(async () => ({
      user,
      plaintextToken: 'rotated-session-secret',
      csrfToken: 'rotated-csrf-secret-with-at-least-thirty-two-bytes',
      expiresAt: '2026-07-21T00:00:00.000Z',
    })),
    revoke: vi.fn(async () => undefined),
  };
  const decisions = [...(input.decisions ?? [])];
  const rateLimits: RateLimitPort = {
    consume: vi.fn(async () => ({ allowed: decisions.shift() ?? true })),
  };
  return { verifier, sessions, rateLimits, clock: { now: () => new Date(now) } };
}

describe('Magic proof and opaque application session use cases', () => {
  it('passes only the raw proof to the verifier and returns newly issued session secrets', async () => {
    const deps = dependencies();
    const useCase = new ExchangeSessionUseCase({
      ...deps,
      expectedAudience: 'https://opentab.example',
      expectedApplicationId: 'pk_live_opentab',
    });

    const result = await useCase.execute({
      didToken: 'did-token-that-is-never-persisted',
      tokenDigest: 'b'.repeat(64),
      networkSubjectHash: 'c'.repeat(64),
    });

    expect(deps.rateLimits.consume).toHaveBeenNthCalledWith(1, {
      scope: 'auth-session-network',
      subjectHash: 'c'.repeat(64),
      limit: 10,
      windowSeconds: 60,
    });
    expect(deps.rateLimits.consume).toHaveBeenNthCalledWith(2, {
      scope: 'auth-session-proof',
      subjectHash: 'b'.repeat(64),
      limit: 1,
      windowSeconds: 300,
    });
    expect(deps.verifier.verifyDidToken).toHaveBeenCalledWith({
      didToken: 'did-token-that-is-never-persisted',
      expectedAudience: 'https://opentab.example',
      expectedApplicationId: 'pk_live_opentab',
    });
    expect(deps.sessions.create).toHaveBeenCalledWith(identity);
    expect(result.user.id).toBe(user.id);
    expect(result.plaintextToken).toBe('session-secret');
  });

  it('rejects malformed proof material before rate limiting or provider access', async () => {
    const deps = dependencies();
    const useCase = new ExchangeSessionUseCase({
      ...deps,
      expectedAudience: 'https://opentab.example',
      expectedApplicationId: 'pk_live_opentab',
    });

    await expect(
      useCase.execute({
        didToken: 'short',
        tokenDigest: 'b'.repeat(64),
        networkSubjectHash: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_DID_INVALID' });
    expect(deps.rateLimits.consume).not.toHaveBeenCalled();
    expect(deps.verifier.verifyDidToken).not.toHaveBeenCalled();
  });

  it('fails closed when the proof exchange rate limit is exhausted', async () => {
    const deps = dependencies({ decisions: [false] });
    const useCase = new ExchangeSessionUseCase({
      ...deps,
      expectedAudience: 'https://opentab.example',
      expectedApplicationId: 'pk_live_opentab',
    });

    await expect(
      useCase.execute({
        didToken: 'did-token-that-is-never-persisted',
        tokenDigest: 'b'.repeat(64),
        networkSubjectHash: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(deps.verifier.verifyDidToken).not.toHaveBeenCalled();
    expect(deps.sessions.create).not.toHaveBeenCalled();
  });

  it('shares one network limit across varying invalid proofs', async () => {
    const deps = dependencies({ decisions: [true, true, false] });
    vi.mocked(deps.verifier.verifyDidToken).mockRejectedValue(
      new AppError('AUTH_DID_INVALID', 'invalid'),
    );
    const useCase = new ExchangeSessionUseCase({
      ...deps,
      expectedAudience: 'https://opentab.example',
      expectedApplicationId: 'pk_live_opentab',
    });

    for (const tokenDigest of ['1'.repeat(64), '2'.repeat(64)]) {
      await expect(
        useCase.execute({
          didToken: `different-invalid-token-${tokenDigest[0]}`,
          tokenDigest,
          networkSubjectHash: 'c'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'AUTH_DID_INVALID' });
    }
    await expect(
      useCase.execute({
        didToken: 'third-different-invalid-token',
        tokenDigest: '3'.repeat(64),
        networkSubjectHash: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(deps.verifier.verifyDidToken).toHaveBeenCalledTimes(2);
    expect(deps.rateLimits.consume).toHaveBeenCalledTimes(3);
  });

  it('allows one accepted proof and rejects its replay before creating another session', async () => {
    const deps = dependencies({ decisions: [true, true, true, false] });
    const useCase = new ExchangeSessionUseCase({
      ...deps,
      expectedAudience: 'https://opentab.example',
      expectedApplicationId: 'pk_live_opentab',
    });
    const request = {
      didToken: 'accepted-did-token-never-persisted',
      tokenDigest: 'b'.repeat(64),
      networkSubjectHash: 'c'.repeat(64),
    };
    await expect(useCase.execute(request)).resolves.toMatchObject({ user: { id: user.id } });
    await expect(useCase.execute(request)).rejects.toMatchObject({ code: 'AUTH_DID_INVALID' });
    expect(deps.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('retains a proof digest for its full accepted lifetime beyond one hour', async () => {
    const deps = dependencies();
    vi.mocked(deps.verifier.verifyDidToken).mockResolvedValue({
      ...identity,
      expiresAt: '2026-07-14T02:00:01.000Z',
    });
    const useCase = new ExchangeSessionUseCase({
      ...deps,
      expectedAudience: 'https://opentab.example',
      expectedApplicationId: 'pk_live_opentab',
    });
    await useCase.execute({
      didToken: 'long-lived-did-token-never-persisted',
      tokenDigest: 'b'.repeat(64),
      networkSubjectHash: 'c'.repeat(64),
    });
    expect(deps.rateLimits.consume).toHaveBeenNthCalledWith(2, {
      scope: 'auth-session-proof',
      subjectHash: 'b'.repeat(64),
      limit: 1,
      windowSeconds: 7_201,
    });
  });

  it('delegates opaque session rotation without exposing the old token', async () => {
    const deps = dependencies();
    const refreshed = await new RefreshSessionUseCase(deps.sessions).execute('old-token');
    expect(deps.sessions.refresh).toHaveBeenCalledWith('old-token');
    expect(refreshed.plaintextToken).toBe('rotated-session-secret');
    expect(JSON.stringify(refreshed)).not.toContain('old-token');
  });

  it('revokes the opaque server session before logout completes', async () => {
    const deps = dependencies();
    await new LogoutSessionUseCase(deps.sessions).execute('opaque-session-token');
    expect(deps.sessions.revoke).toHaveBeenCalledWith('opaque-session-token');
  });
});
