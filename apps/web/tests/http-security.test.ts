import type {
  BackendApiCommandPort,
  BackendApiQueryPort,
  BackendApiResourceQueryPort,
} from '@opentab/application';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handleMutation } from '../app/api/_lib/http.js';
import {
  type BackendApiRegistry,
  installBackendApiRegistry,
  resetBackendApiRegistryForTests,
} from '../app/api/_lib/registry.js';

function callableProxy<T extends object>(): T {
  return new Proxy(
    {},
    {
      get: () => async () => ({}),
    },
  ) as T;
}

function install(input: {
  consume?: BackendApiRegistry['rateLimits']['consume'];
  info: BackendApiRegistry['requestLog']['info'];
  error: BackendApiRegistry['requestLog']['error'];
}) {
  const consume = input.consume ?? (async () => ({ allowed: true as const }));
  installBackendApiRegistry({
    sessions: callableProxy<BackendApiRegistry['sessions']>(),
    authContinuations: callableProxy<BackendApiRegistry['authContinuations']>(),
    exchangeSession: callableProxy<BackendApiRegistry['exchangeSession']>(),
    refreshSession: callableProxy<BackendApiRegistry['refreshSession']>(),
    logoutSession: callableProxy<BackendApiRegistry['logoutSession']>(),
    queries: callableProxy<BackendApiQueryPort>(),
    resourceQueries: callableProxy<BackendApiResourceQueryPort>(),
    commands: callableProxy<BackendApiCommandPort>(),
    featureFlags: { enabled: async () => true },
    rateLimits: { consume },
    requestLog: { info: input.info, error: input.error },
    allowedOrigin: 'https://opentab.example',
    sessionCookieName: '__Host-opentab_session',
    authContinuationCookieName: '__Host-opentab_auth_state',
    sessionCookieSecure: true,
    digestSecret: () => 'a'.repeat(64),
    networkSubject: () => '198.51.100.24',
  });
}

describe('HTTP rate-limit and redacted logging boundary', () => {
  beforeEach(() => resetBackendApiRegistryForTests());

  it('logs only bounded request metadata and hashes the network subject', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const consume = vi.fn(async () => ({ allowed: true as const }));
    install({ info, error, consume });
    const sensitive = 'did-token-that-must-never-reach-logs';
    const response = await handleMutation({
      request: new Request('https://opentab.example/api/v1/auth/exchange?secret=query', {
        method: 'POST',
        headers: {
          origin: 'https://opentab.example',
          'content-type': 'application/json',
          cookie: '__Host-opentab_session=private-cookie',
        },
        body: JSON.stringify({ proof: sensitive }),
      }),
      schema: z.object({ proof: z.string() }).strict(),
      auth: 'none',
      execute: async () => ({ accepted: true }),
    });
    expect(response.status).toBe(200);
    expect(consume).toHaveBeenCalledWith({
      scope: 'auth-mutation',
      limit: 20,
      windowSeconds: 60,
      subjectHash: 'a'.repeat(64),
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(Object.keys(info.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'durationMs',
      'method',
      'path',
      'requestId',
      'status',
    ]);
    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain('private-cookie');
    expect(serialized).not.toContain('198.51.100.24');
    expect(serialized).not.toContain('secret=query');
    expect(error).not.toHaveBeenCalled();
  });

  it('fails closed with Retry-After and a redacted error log when Redis denies', async () => {
    const info = vi.fn();
    const error = vi.fn();
    install({
      info,
      error,
      consume: async () => ({ allowed: false as const, retryAfterSeconds: 17 }),
    });
    const response = await handleMutation({
      request: new Request('https://opentab.example/api/v1/payment-attempts', {
        method: 'POST',
        headers: { origin: 'https://opentab.example', 'content-type': 'application/json' },
        body: '{}',
      }),
      schema: z.object({}).strict(),
      auth: 'none',
      execute: async () => ({ impossible: true }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
      expect.objectContaining({ status: 429 }),
    );
  });

  it('keeps unexpected failures generic for the client and attaches the exception to its request log', async () => {
    const info = vi.fn();
    const error = vi.fn();
    install({ info, error });
    const failure = new TypeError('value.toISOString is not a function');
    const response = await handleMutation({
      request: new Request('https://opentab.example/api/v1/operator/particle-certification', {
        method: 'POST',
        headers: { origin: 'https://opentab.example', 'content-type': 'application/json' },
        body: '{}',
      }),
      schema: z.object({}).strict(),
      auth: 'none',
      execute: async () => {
        throw failure;
      },
    });

    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(body)).not.toContain(failure.message);
    expect(error).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        path: '/api/v1/operator/particle-certification',
        status: 503,
        requestId: body.error.requestId,
      }),
    );
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    '/api/v1/orders/ord_01J00000000000000000000001/splits',
    '/api/v1/splits/spl_01J00000000000000000000001/payment-attempts',
    '/api/v1/split-payment-attempts/spa_01J00000000000000000000001/submission',
  ])('applies the strict financial mutation policy to %s', async (path) => {
    const consume = vi.fn(async () => ({ allowed: true as const }));
    install({ info: vi.fn(), error: vi.fn(), consume });

    const response = await handleMutation({
      request: new Request(`https://opentab.example${path}`, {
        method: 'POST',
        headers: { origin: 'https://opentab.example', 'content-type': 'application/json' },
        body: '{}',
      }),
      schema: z.object({}).strict(),
      auth: 'none',
      execute: async () => ({ accepted: true }),
    });

    expect(response.status).toBe(200);
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'financial-mutation', limit: 12, windowSeconds: 60 }),
    );
  });
});
