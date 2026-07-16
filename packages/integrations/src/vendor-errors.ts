import { AppError, type ErrorCode } from '@opentab/shared';
import { z } from 'zod';
import { digestUnknown } from './evidence.js';

const VendorErrorShape = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().max(1_000).optional(),
    name: z.string().max(200).optional(),
  })
  .passthrough();

function safeVendorCode(error: unknown): string | undefined {
  const parsed = VendorErrorShape.safeParse(error);
  return parsed.success && parsed.data.code !== undefined
    ? String(parsed.data.code).slice(0, 80)
    : undefined;
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
  const vendorCode = safeVendorCode(error);
  return new AppError(fallbackCode, 'The payment provider is unavailable.', {
    retryable: options.retryable ?? true,
    submissionPossible: options.submissionPossible ?? false,
    safeDetails: {
      vendor: 'particle',
      causeDigest: digestUnknown(error),
      ...(vendorCode === undefined ? {} : { vendorCode }),
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
