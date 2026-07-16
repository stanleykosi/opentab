import { AppError } from '@opentab/shared';
import {
  authContinuationCookie,
  clearAuthContinuationCookie,
  clearSessionCookie,
  handleMutation,
  handleQuery,
  readCookie,
  readSessionToken,
  secretDigest,
  sessionCookie,
} from './http.js';
import {
  AuthContinuationBodySchema,
  EmptyBodySchema,
  SessionExchangeBodySchema,
} from './schemas.js';

export async function createAuthContinuation(request: Request): Promise<Response> {
  let cookie: string | undefined;
  const response = await handleMutation({
    request,
    schema: AuthContinuationBodySchema,
    auth: 'none',
    execute: async ({ registry, body }) => {
      const issued = await registry.authContinuations.issue({ returnPath: body.returnPath });
      cookie = authContinuationCookie(registry, issued.verifierToken, issued.expiresAt);
      return { continuationId: issued.continuationId, expiresAt: issued.expiresAt };
    },
    status: 201,
  });
  if (cookie !== undefined) response.headers.append('set-cookie', cookie);
  return response;
}

export async function createSession(request: Request): Promise<Response> {
  let cookie: string | undefined;
  const response = await handleMutation({
    request,
    schema: SessionExchangeBodySchema,
    auth: 'none',
    execute: async ({ registry, body }) => {
      const verifierToken = readCookie(request, registry.authContinuationCookieName);
      if (verifierToken === undefined) {
        throw new AppError('AUTH_STATE_MISMATCH', 'The login continuation cookie is missing.');
      }
      const continuation = await registry.authContinuations.consume({
        continuationId: body.continuationId,
        verifierToken,
      });
      const rawNetworkSubject = registry.networkSubject(request);
      if (rawNetworkSubject.length < 1 || rawNetworkSubject.length > 512) {
        throw new AppError(
          'CONFIGURATION_INVALID',
          'The network subject service returned invalid data.',
        );
      }
      const issued = await registry.exchangeSession.execute({
        didToken: body.didToken,
        tokenDigest: secretDigest(registry, 'magic-did-token', body.didToken),
        networkSubjectHash: secretDigest(registry, 'auth-network-subject', rawNetworkSubject),
      });
      cookie = sessionCookie(registry, issued.plaintextToken, issued.expiresAt);
      return {
        user: issued.user,
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt,
        returnPath: continuation.returnPath,
      };
    },
  });
  try {
    const registryModule = await import('./registry.js');
    const registry = registryModule.getBackendApiRegistry();
    response.headers.append('set-cookie', clearAuthContinuationCookie(registry));
  } catch {
    // The response already contains the fail-closed configuration error.
  }
  if (cookie !== undefined) response.headers.append('set-cookie', cookie);
  return response;
}

export async function refreshSession(request: Request): Promise<Response> {
  let cookie: string | undefined;
  const response = await handleMutation({
    request,
    schema: EmptyBodySchema,
    allowEmptyBody: true,
    auth: 'required',
    csrf: false,
    execute: async ({ registry }) => {
      const token = readSessionToken(request, registry);
      if (token === undefined) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
      const issued = await registry.refreshSession.execute(token);
      cookie = sessionCookie(registry, issued.plaintextToken, issued.expiresAt);
      return { user: issued.user, csrfToken: issued.csrfToken, expiresAt: issued.expiresAt };
    },
  });
  if (cookie !== undefined) response.headers.append('set-cookie', cookie);
  return response;
}

export async function deleteSession(request: Request): Promise<Response> {
  let clearCookie: string | undefined;
  const response = await handleMutation({
    request,
    schema: EmptyBodySchema,
    allowEmptyBody: true,
    auth: 'required',
    execute: async ({ registry }) => {
      const token = readSessionToken(request, registry);
      if (token === undefined) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
      await registry.logoutSession.execute(token);
      clearCookie = clearSessionCookie(registry);
      return { revoked: true };
    },
  });
  if (clearCookie !== undefined) response.headers.append('set-cookie', clearCookie);
  return response;
}

export function getMe(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ actor }) => ({ user: actor }),
  });
}
