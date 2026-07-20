import { AppError, type ErrorCode } from '@opentab/shared';
import { z } from 'zod';
import { digestUnknown } from './evidence.js';

const VendorErrorShape = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().max(1_000).optional(),
    name: z.string().max(200).optional(),
    data: z.unknown().optional(),
    error: z.unknown().optional(),
    cause: z.unknown().optional(),
    response: z.unknown().optional(),
  })
  .passthrough();

type VendorReason =
  | 'insufficient_funds'
  | 'invalid_parameters'
  | 'unsupported_chain'
  | 'simulation_failed'
  | 'network_unavailable'
  | 'timeout';

interface SafeVendorSignals {
  readonly vendorCode?: string;
  readonly vendorCauseCode?: string;
  readonly vendorReason?: VendorReason;
}

function parsedVendorErrors(error: unknown): readonly z.infer<typeof VendorErrorShape>[] {
  const queue: unknown[] = [error];
  const seen = new WeakSet<object>();
  const parsed: z.infer<typeof VendorErrorShape>[] = [];
  while (queue.length > 0 && parsed.length < 16) {
    const candidate = queue.shift();
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    const result = VendorErrorShape.safeParse(candidate);
    if (!result.success) continue;
    parsed.push(result.data);
    queue.push(result.data.data, result.data.error, result.data.cause, result.data.response);
  }
  return parsed;
}

function classifyVendorReason(
  messages: readonly string[],
  codes: readonly string[],
): VendorReason | undefined {
  const combined = messages.join(' ').toLowerCase();
  if (codes.includes('40104') || /insufficient (?:funds|balance)|balance too low/.test(combined)) {
    return 'insufficient_funds';
  }
  if (
    codes.includes('-32602') ||
    codes.includes('10002') ||
    /invalid (?:parameters|params)|request body error/.test(combined)
  ) {
    return 'invalid_parameters';
  }
  if (codes.includes('-32001') || /unsupported chain|chain.+not supported/.test(combined)) {
    return 'unsupported_chain';
  }
  if (
    codes.includes('-32005') ||
    codes.includes('-32606') ||
    /estimate gas failed|simulation failed|simulate user operation failed/.test(combined)
  ) {
    return 'simulation_failed';
  }
  if (
    codes.includes('ECONNABORTED') ||
    codes.includes('ETIMEDOUT') ||
    /timed? ?out/.test(combined)
  ) {
    return 'timeout';
  }
  if (codes.includes('ERR_NETWORK') || /network error|failed to fetch/.test(combined)) {
    return 'network_unavailable';
  }
  return undefined;
}

function safeVendorSignals(error: unknown): SafeVendorSignals {
  const parsed = parsedVendorErrors(error);
  if (parsed.length === 0) return {};
  const codes = parsed
    .flatMap((entry) => (entry.code === undefined ? [] : [String(entry.code).slice(0, 80)]))
    .filter((code, index, values) => values.indexOf(code) === index);
  const messages = parsed.flatMap((entry) => (entry.message === undefined ? [] : [entry.message]));
  const vendorReason = classifyVendorReason(messages, codes);
  return {
    ...(codes[0] === undefined ? {} : { vendorCode: codes[0] }),
    ...(codes[1] === undefined ? {} : { vendorCauseCode: codes[1] }),
    ...(vendorReason === undefined ? {} : { vendorReason }),
  };
}

function safeVendorCode(error: unknown): string | undefined {
  return safeVendorSignals(error).vendorCode;
}

function looksCancelled(error: unknown): boolean {
  const parsed = VendorErrorShape.safeParse(error);
  if (!parsed.success) return false;
  if (parsed.data.code === 4001 || parsed.data.code === '4001') return true;
  const message = parsed.data.message?.toLowerCase() ?? '';
  return /cancel|closed by user|user reject|denied/.test(message);
}

export function mapMagicError(
  error: unknown,
  fallbackCode: ErrorCode,
  options: { submissionPossible?: boolean } = {},
): AppError {
  const cancelled = looksCancelled(error);
  const code: ErrorCode = cancelled ? 'AUTH_CANCELLED' : fallbackCode;
  const vendorCode = safeVendorCode(error);
  return new AppError(
    code,
    cancelled ? 'The wallet action was cancelled.' : 'Magic is unavailable.',
    {
      retryable: !cancelled,
      submissionPossible: options.submissionPossible ?? false,
      safeDetails: {
        vendor: 'magic',
        causeDigest: digestUnknown(error),
        ...(vendorCode === undefined ? {} : { vendorCode }),
      },
      cause: error,
    },
  );
}

export function mapParticleError(
  error: unknown,
  fallbackCode: ErrorCode,
  options: { submissionPossible?: boolean; retryable?: boolean } = {},
): AppError {
  const signals = safeVendorSignals(error);
  const code: ErrorCode =
    signals.vendorReason === 'insufficient_funds'
      ? 'UA_INSUFFICIENT_BALANCE'
      : signals.vendorReason === 'unsupported_chain' || signals.vendorReason === 'simulation_failed'
        ? 'UA_ROUTE_UNAVAILABLE'
        : fallbackCode;
  const message =
    signals.vendorReason === 'insufficient_funds'
      ? 'The unified balance does not cover the payment and route fees.'
      : signals.vendorReason === 'invalid_parameters'
        ? 'Particle rejected the prepared operation parameters.'
        : signals.vendorReason === 'unsupported_chain'
          ? 'Particle does not support one of the prepared operation chains.'
          : signals.vendorReason === 'simulation_failed'
            ? 'Particle could not simulate a valid route for this operation.'
            : signals.vendorReason === 'network_unavailable'
              ? 'The browser could not reach Particle.'
              : signals.vendorReason === 'timeout'
                ? 'Particle did not respond before the request timed out.'
                : 'The payment provider is unavailable.';
  const classifiedNonRetryable =
    signals.vendorReason === 'insufficient_funds' ||
    signals.vendorReason === 'invalid_parameters' ||
    signals.vendorReason === 'unsupported_chain' ||
    signals.vendorReason === 'simulation_failed';
  return new AppError(code, message, {
    retryable: options.retryable ?? !classifiedNonRetryable,
    submissionPossible: options.submissionPossible ?? false,
    safeDetails: {
      vendor: 'particle',
      causeDigest: digestUnknown(error),
      ...(signals.vendorCode === undefined ? {} : { vendorCode: signals.vendorCode }),
      ...(signals.vendorCauseCode === undefined
        ? {}
        : { vendorCauseCode: signals.vendorCauseCode }),
      ...(signals.vendorReason === undefined ? {} : { vendorReason: signals.vendorReason }),
    },
    cause: error,
  });
}

export function mapRpcError(
  error: unknown,
  options: { submissionPossible?: boolean } = {},
): AppError {
  return new AppError('RPC_UNAVAILABLE', 'Arbitrum RPC is unavailable.', {
    retryable: true,
    submissionPossible: options.submissionPossible ?? false,
    safeDetails: { vendor: 'arbitrum', causeDigest: digestUnknown(error) },
    cause: error,
  });
}
