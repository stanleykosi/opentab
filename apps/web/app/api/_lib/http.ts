import { randomUUID } from 'node:crypto';
import type { CurrentUser, ErrorCode } from '@opentab/shared';
import { AppError, isAppError } from '@opentab/shared';
import type { z } from 'zod';
import {
  type BackendApiRegistry,
  ensureBackendApiRegistry,
  getBackendApiRegistry,
} from './registry.js';

const JSON_LIMIT_BYTES = 65_536;

export interface ApiExecutionContext<T> {
  readonly registry: BackendApiRegistry;
  readonly requestId: string;
  readonly body: T;
  readonly actor?: CurrentUser;
  readonly idempotencyKeyHash?: string;
  readonly requestHash: string;
}

function headers(requestId: string, extra?: HeadersInit): Headers {
  const result = new Headers(extra);
  if (!result.has('cache-control')) result.set('cache-control', 'no-store, max-age=0');
  result.set('content-type', 'application/json; charset=utf-8');
  result.set('x-content-type-options', 'nosniff');
  result.set('x-request-id', requestId);
  return result;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested,
  );
}

export function secretDigest(registry: BackendApiRegistry, domain: string, value: string): string {
  const digest = registry.digestSecret(domain, value);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new AppError('CONFIGURATION_INVALID', 'The secret digest service returned invalid data.');
  }
  return digest;
}

export function jsonResponse(
  requestId: string,
  value: object,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  return new Response(stringify({ ...value, requestId }), {
    status,
    headers: headers(requestId, extraHeaders),
  });
}

export const HTTP_STATUS_BY_ERROR_CODE = {
  AUTH_CANCELLED: 400,
  AUTH_EXPIRED: 401,
  AUTH_STATE_MISMATCH: 400,
  AUTH_PROVIDER_UNAVAILABLE: 502,
  AUTH_DID_INVALID: 401,
  AUTH_SESSION_INVALID: 401,
  AUTH_SESSION_REVOKED: 401,
  AUTH_REQUIRED: 401,
  AUTH_FORBIDDEN: 403,
  CSRF_INVALID: 403,
  ORIGIN_INVALID: 403,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  WALLET_ADDRESS_MISMATCH: 403,
  WALLET_CHAIN_SWITCH_FAILED: 422,
  WALLET_7702_UNSUPPORTED: 422,
  WALLET_SIGNATURE_REJECTED: 422,
  WALLET_TYPE4_SUBMISSION_FAILED: 502,
  UA_CONFIGURATION_INVALID: 503,
  UA_PROVIDER_SCHEMA_INVALID: 502,
  UA_DELEGATION_REQUIRED: 422,
  UA_QUOTE_EXPIRED: 422,
  UA_INSUFFICIENT_BALANCE: 422,
  UA_ROUTE_UNAVAILABLE: 422,
  UA_SIGNATURE_REJECTED: 422,
  UA_SUBMISSION_FAILED: 502,
  UA_EXECUTION_FAILED: 409,
  UA_STATUS_UNKNOWN: 502,
  OPERATION_PLAN_INVALID: 422,
  PRODUCT_UNAVAILABLE: 422,
  PRODUCT_SOLD_OUT: 422,
  CHECKOUT_EXPIRED: 422,
  PAYMENT_ALREADY_SUBMITTED: 409,
  PAYMENT_SUBMITTED_UNKNOWN: 409,
  PAYMENT_EVENT_MISMATCH: 409,
  PAYMENT_NOT_CANONICAL: 409,
  RPC_UNAVAILABLE: 502,
  RPC_INCONSISTENT: 502,
  INDEXER_LAGGING: 503,
  SPONSOR_DISABLED: 503,
  SPONSOR_INELIGIBLE: 422,
  SPONSOR_BUDGET_EXHAUSTED: 503,
  SPONSOR_SUBMISSION_UNKNOWN: 409,
  REFUND_NOT_ALLOWED: 422,
  WITHDRAWAL_NOT_ALLOWED: 422,
  SPLIT_EXPIRED: 422,
  SPLIT_REVOKED: 409,
  SPLIT_ALREADY_PAID: 409,
  FEATURE_DISABLED: 503,
  CONFIGURATION_INVALID: 503,
  INTERNAL_ERROR: 503,
} as const satisfies Readonly<Record<ErrorCode, number>>;

function statusFor(error: AppError): number {
  return HTTP_STATUS_BY_ERROR_CODE[error.code];
}

export function errorResponse(error: unknown, requestId = `req_${randomUUID()}`): Response {
  const normalized = isAppError(error)
    ? error
    : new AppError('INTERNAL_ERROR', 'The request could not be completed.', { cause: error });
  const retryAfter = normalized.safeDetails?.retryAfterSeconds;
  return new Response(
    stringify({
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        submissionPossible: normalized.submissionPossible,
        requestId,
      },
    }),
    {
      status: statusFor(normalized),
      headers: headers(
        requestId,
        retryAfter === undefined ? undefined : { 'retry-after': retryAfter },
      ),
    },
  );
}

export function readCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get('cookie');
  if (cookie === null) return undefined;
  for (const entry of cookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    const value = entry.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      throw new AppError('AUTH_SESSION_INVALID', 'The application session is invalid.');
    }
  }
  return undefined;
}

export function readSessionToken(
  request: Request,
  registry: BackendApiRegistry,
): string | undefined {
  return readCookie(request, registry.sessionCookieName);
}

export function sessionCookie(
  registry: BackendApiRegistry,
  plaintextToken: string,
  expiresAt: string,
): string {
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires <= new Date()) {
    throw new AppError('CONFIGURATION_INVALID', 'The session expiry is invalid.');
  }
  return [
    `${registry.sessionCookieName}=${encodeURIComponent(plaintextToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(registry.sessionCookieSecure ? ['Secure'] : []),
    `Expires=${expires.toUTCString()}`,
  ].join('; ');
}

export function clearSessionCookie(registry: BackendApiRegistry): string {
  return [
    `${registry.sessionCookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(registry.sessionCookieSecure ? ['Secure'] : []),
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ].join('; ');
}

export function authContinuationCookie(
  registry: BackendApiRegistry,
  verifierToken: string,
  expiresAt: string,
): string {
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires <= new Date()) {
    throw new AppError('CONFIGURATION_INVALID', 'The auth continuation expiry is invalid.');
  }
  return [
    `${registry.authContinuationCookieName}=${encodeURIComponent(verifierToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(registry.sessionCookieSecure ? ['Secure'] : []),
    `Expires=${expires.toUTCString()}`,
  ].join('; ');
}

export function clearAuthContinuationCookie(registry: BackendApiRegistry): string {
  return [
    `${registry.authContinuationCookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(registry.sessionCookieSecure ? ['Secure'] : []),
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ].join('; ');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

async function parseJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  allowEmpty: boolean,
): Promise<T> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > JSON_LIMIT_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'The request body is too large.');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > JSON_LIMIT_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'The request body is too large.');
  }
  const empty = text.trim().length === 0;
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (!empty && contentType !== 'application/json') {
    throw new AppError('VALIDATION_FAILED', 'Content-Type must be application/json.');
  }
  if (empty && !allowEmpty) {
    throw new AppError('VALIDATION_FAILED', 'The request body is required.');
  }
  try {
    return schema.parse(empty ? {} : JSON.parse(text));
  } catch (error) {
    throw new AppError('VALIDATION_FAILED', 'The request body is invalid.', { cause: error });
  }
}

async function authenticate(
  request: Request,
  registry: BackendApiRegistry,
  mode: 'none' | 'optional' | 'required',
  csrf: boolean,
): Promise<CurrentUser | undefined> {
  if (mode === 'none') return undefined;
  const token = readSessionToken(request, registry);
  if (token === undefined) {
    if (mode === 'optional') return undefined;
    throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
  }
  if (!csrf) return registry.sessions.verify(token);
  const csrfToken = request.headers.get('x-csrf-token');
  if (csrfToken === null || csrfToken.length < 32 || csrfToken.length > 256) {
    throw new AppError('CSRF_INVALID', 'The CSRF token is invalid.');
  }
  return registry.sessions.verifyCsrf(token, csrfToken);
}

function assertOrigin(request: Request, registry: BackendApiRegistry): void {
  if (request.headers.get('origin') !== registry.allowedOrigin) {
    throw new AppError('ORIGIN_INVALID', 'The request origin is not allowed.');
  }
}

async function assertFeature(
  registry: BackendApiRegistry,
  feature: string | undefined,
  actor: CurrentUser | undefined,
): Promise<void> {
  if (feature === undefined) return;
  const enabled = await registry.featureFlags.enabled(
    feature,
    actor === undefined ? undefined : { userId: actor.id },
  );
  if (!enabled) throw new AppError('FEATURE_DISABLED', 'This feature is not available.');
}

function ratePolicy(
  request: Request,
  mutation: boolean,
): {
  scope: string;
  limit: number;
  windowSeconds: number;
} {
  const path = new URL(request.url).pathname;
  if (
    /\/(?:payment-attempts|refunds|withdrawals|splits|split-links|split-payment-attempts|bootstrap-gas|contract-operations|operator)(?:\/|$)/.test(
      path,
    )
  ) {
    return {
      scope: mutation ? 'financial-mutation' : 'financial-query',
      limit: mutation ? 12 : 60,
      windowSeconds: 60,
    };
  }
  if (path.includes('/auth/')) {
    return {
      scope: mutation ? 'auth-mutation' : 'auth-query',
      limit: mutation ? 20 : 60,
      windowSeconds: 60,
    };
  }
  if (!mutation) return { scope: 'public-or-private-query', limit: 120, windowSeconds: 60 };
  return { scope: 'application-mutation', limit: 60, windowSeconds: 60 };
}

async function enforceRateLimit(input: {
  registry: BackendApiRegistry;
  request: Request;
  actor?: CurrentUser;
  mutation: boolean;
}): Promise<void> {
  const policy = ratePolicy(input.request, input.mutation);
  const subject =
    input.actor === undefined
      ? input.registry.networkSubject(input.request)
      : `authenticated:${input.actor.id}`;
  const decision = await input.registry.rateLimits.consume({
    ...policy,
    subjectHash: secretDigest(input.registry, 'rate-limit-subject', subject),
  });
  if (!decision.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', {
      retryable: true,
      safeDetails: {
        retryAfterSeconds: (decision.retryAfterSeconds ?? policy.windowSeconds).toString(),
      },
    });
  }
}

function requestLogFields(request: Request, requestId: string, startedAt: number, status: number) {
  return {
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function idempotencyDigest(request: Request, registry: BackendApiRegistry): string {
  const key = request.headers.get('idempotency-key');
  if (key === null || key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(key)) {
    throw new AppError('VALIDATION_FAILED', 'A valid Idempotency-Key header is required.');
  }
  return secretDigest(registry, 'idempotency-key', key);
}

export async function handleMutation<T>(input: {
  request: Request;
  schema: z.ZodType<T>;
  auth: 'none' | 'optional' | 'required';
  csrf?: boolean;
  idempotency?: boolean;
  allowEmptyBody?: boolean;
  feature?: string;
  status?: number;
  execute: (context: ApiExecutionContext<T>) => Promise<object>;
}): Promise<Response> {
  const requestId = `req_${randomUUID()}`;
  const startedAt = Date.now();
  try {
    await ensureBackendApiRegistry();
    const registry = getBackendApiRegistry();
    assertOrigin(input.request, registry);
    const body = await parseJson(input.request, input.schema, input.allowEmptyBody ?? false);
    const actor = await authenticate(
      input.request,
      registry,
      input.auth,
      input.csrf ?? input.auth !== 'none',
    );
    await enforceRateLimit({
      registry,
      request: input.request,
      ...(actor === undefined ? {} : { actor }),
      mutation: true,
    });
    await assertFeature(registry, input.feature, actor);
    const requestHash = secretDigest(
      registry,
      'api-request',
      stringify({
        method: input.request.method,
        pathname: new URL(input.request.url).pathname,
        body: stable(body),
      }),
    );
    const idempotencyKeyHash = input.idempotency
      ? idempotencyDigest(input.request, registry)
      : undefined;
    const result = await input.execute({
      registry,
      requestId,
      body,
      ...(actor === undefined ? {} : { actor }),
      ...(idempotencyKeyHash === undefined ? {} : { idempotencyKeyHash }),
      requestHash,
    });
    const response = jsonResponse(requestId, result, input.status ?? 200);
    registry.requestLog.info(
      requestLogFields(input.request, requestId, startedAt, response.status),
    );
    return response;
  } catch (error) {
    const response = errorResponse(error, requestId);
    try {
      getBackendApiRegistry().requestLog.error(
        requestLogFields(input.request, requestId, startedAt, response.status),
      );
    } catch {
      // Registry initialization failures have no logger by definition.
    }
    return response;
  }
}

export async function handleQuery(input: {
  request: Request;
  auth: 'none' | 'optional' | 'required';
  feature?: string;
  publicCache?: { readonly sMaxAgeSeconds: number; readonly staleWhileRevalidateSeconds: number };
  exactJsonBody?: boolean;
  etag?: (value: object) => string;
  execute: (context: {
    registry: BackendApiRegistry;
    requestId: string;
    actor?: CurrentUser;
  }) => Promise<object | undefined>;
}): Promise<Response> {
  const requestId = `req_${randomUUID()}`;
  const startedAt = Date.now();
  try {
    if (
      input.publicCache !== undefined &&
      (input.auth !== 'none' ||
        !Number.isSafeInteger(input.publicCache.sMaxAgeSeconds) ||
        input.publicCache.sMaxAgeSeconds < 1 ||
        input.publicCache.sMaxAgeSeconds > 300 ||
        !Number.isSafeInteger(input.publicCache.staleWhileRevalidateSeconds) ||
        input.publicCache.staleWhileRevalidateSeconds < 0 ||
        input.publicCache.staleWhileRevalidateSeconds > 900)
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'The public cache policy is invalid.');
    }
    await ensureBackendApiRegistry();
    const registry = getBackendApiRegistry();
    const actor = await authenticate(input.request, registry, input.auth, false);
    await enforceRateLimit({
      registry,
      request: input.request,
      ...(actor === undefined ? {} : { actor }),
      mutation: false,
    });
    await assertFeature(registry, input.feature, actor);
    const result = await input.execute({
      registry,
      requestId,
      ...(actor === undefined ? {} : { actor }),
    });
    if (result === undefined) throw new AppError('NOT_FOUND', 'The resource was not found.');
    const cacheHeaders =
      input.publicCache === undefined
        ? undefined
        : {
            'cache-control': `public, s-maxage=${input.publicCache.sMaxAgeSeconds}, stale-while-revalidate=${input.publicCache.staleWhileRevalidateSeconds}`,
            vary: 'Accept-Encoding',
          };
    if (input.exactJsonBody) {
      const extra = new Headers(cacheHeaders);
      const etag = input.etag?.(result);
      if (etag !== undefined) extra.set('etag', etag);
      const response = new Response(stringify(result), {
        status: 200,
        headers: headers(requestId, extra),
      });
      registry.requestLog.info(
        requestLogFields(input.request, requestId, startedAt, response.status),
      );
      return response;
    }
    const response = jsonResponse(requestId, result, 200, cacheHeaders);
    registry.requestLog.info(
      requestLogFields(input.request, requestId, startedAt, response.status),
    );
    return response;
  } catch (error) {
    const response = errorResponse(error, requestId);
    try {
      getBackendApiRegistry().requestLog.error(
        requestLogFields(input.request, requestId, startedAt, response.status),
      );
    } catch {
      // Registry initialization failures have no logger by definition.
    }
    return response;
  }
}
