import pino, { type Logger, type LoggerOptions } from 'pino';

export const OPEN_TAB_OBSERVABILITY_SCHEMA_VERSION = 2 as const;
export const REDACTED = '[REDACTED]' as const;

const sensitiveKey =
  /(?:authorization|cookie|did.?token|oauth|signature|root.?hash|private.?key|secret|password|email|ip(?:Address)?|device|risk|rpc.?url|access.?token|refresh.?token)/i;
const wholeSecretValue = /^(?:sk_(?:live|test)_[a-z0-9_-]+|pk_live_REPLACE)$/i;
const embeddedSecretValues = [
  /\bbearer\s+[a-z0-9._~+/=-]+/gi,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi,
  /\b(?:sk_(?:live|test)_)[a-z0-9_-]+\b/gi,
  /\b0x[0-9a-f]{64,132}\b/gi,
  /\b[0-9a-f]{64,132}\b/gi,
] as const;

export type SafeLogScalar = string | boolean | number | null;
export type SafeLogValue =
  | SafeLogScalar
  | readonly SafeLogValue[]
  | { readonly [key: string]: SafeLogValue };

const embeddedUrl = /\b(?:https?|wss?):\/\/[^\s"'<>\])}]+/gi;

function redactUrl(candidate: string): string {
  const trailing = candidate.match(/[.,;!?]+$/)?.[0] ?? '';
  const raw = trailing === '' ? candidate : candidate.slice(0, -trailing.length);
  try {
    const url = new URL(raw);
    // Log records never need provider paths or query strings. API credentials
    // are commonly carried in either location (Alchemy `/v2/<key>`, Infura
    // `/v3/<key>`, signed query strings), so retain only the public origin.
    return `${url.origin}${trailing}`;
  } catch {
    return REDACTED;
  }
}

function sanitizeString(value: string): string {
  if (wholeSecretValue.test(value)) return REDACTED;
  let sanitized = value.replace(embeddedUrl, redactUrl);
  for (const pattern of embeddedSecretValues) sanitized = sanitized.replace(pattern, REDACTED);
  return sanitized.length > 2_000 ? `${sanitized.slice(0, 2_000)}…` : sanitized;
}

export function sanitizeError(error: unknown, includeStack = false): SafeLogValue {
  if (!(error instanceof Error)) return sanitizeTelemetry(error);
  const stack = includeStack
    ? error.stack
        ?.split('\n')
        .slice(0, 12)
        .map((line) => sanitizeString(line))
        .join('\n')
    : undefined;
  return {
    type: sanitizeString(error.name),
    message: sanitizeString(error.message),
    ...(stack === undefined ? {} : { stack }),
  };
}

export function sanitizeTelemetry(value: unknown, depth = 0): SafeLogValue {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null) return null;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitizeTelemetry(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, SafeLogValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sensitiveKey.test(key) ? REDACTED : sanitizeTelemetry(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function createOpenTabLogger(input: {
  service: string;
  environment: string;
  level?: string;
  release?: string;
  destination?: LoggerOptions['transport'];
}): Logger {
  const includeStack = ['local', 'test'].includes(input.environment);
  return pino({
    name: input.service,
    level: input.level ?? 'info',
    base: {
      service: input.service,
      environment: input.environment,
      observabilitySchemaVersion: OPEN_TAB_OBSERVABILITY_SCHEMA_VERSION,
      ...(input.release === undefined ? {} : { release: input.release }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers.set-cookie',
        '*.didToken',
        '*.signature',
        '*.privateKey',
        '*.secret',
      ],
      censor: REDACTED,
    },
    serializers: {
      err(error: unknown) {
        return sanitizeError(error, includeStack);
      },
      safe(value: unknown) {
        return sanitizeTelemetry(value);
      },
    },
    ...(input.destination === undefined ? {} : { transport: input.destination }),
  });
}

export function correlationFields(input: {
  requestId?: string;
  userId?: string;
  checkoutSessionId?: string;
  orderId?: string;
  paymentAttemptId?: string;
  providerOperationId?: string;
  transactionHash?: string;
}): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
