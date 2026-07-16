import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'AUTH_CANCELLED',
  'AUTH_EXPIRED',
  'AUTH_STATE_MISMATCH',
  'AUTH_PROVIDER_UNAVAILABLE',
  'AUTH_DID_INVALID',
  'AUTH_SESSION_INVALID',
  'AUTH_SESSION_REVOKED',
  'AUTH_REQUIRED',
  'AUTH_FORBIDDEN',
  'CSRF_INVALID',
  'ORIGIN_INVALID',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'WALLET_ADDRESS_MISMATCH',
  'WALLET_CHAIN_SWITCH_FAILED',
  'WALLET_7702_UNSUPPORTED',
  'WALLET_SIGNATURE_REJECTED',
  'WALLET_TYPE4_SUBMISSION_FAILED',
  'UA_CONFIGURATION_INVALID',
  'UA_PROVIDER_SCHEMA_INVALID',
  'UA_DELEGATION_REQUIRED',
  'UA_QUOTE_EXPIRED',
  'UA_INSUFFICIENT_BALANCE',
  'UA_ROUTE_UNAVAILABLE',
  'UA_SIGNATURE_REJECTED',
  'UA_SUBMISSION_FAILED',
  'UA_EXECUTION_FAILED',
  'UA_STATUS_UNKNOWN',
  'OPERATION_PLAN_INVALID',
  'PRODUCT_UNAVAILABLE',
  'PRODUCT_SOLD_OUT',
  'CHECKOUT_EXPIRED',
  'PAYMENT_ALREADY_SUBMITTED',
  'PAYMENT_SUBMITTED_UNKNOWN',
  'PAYMENT_EVENT_MISMATCH',
  'PAYMENT_NOT_CANONICAL',
  'RPC_UNAVAILABLE',
  'RPC_INCONSISTENT',
  'INDEXER_LAGGING',
  'SPONSOR_DISABLED',
  'SPONSOR_INELIGIBLE',
  'SPONSOR_BUDGET_EXHAUSTED',
  'SPONSOR_SUBMISSION_UNKNOWN',
  'REFUND_NOT_ALLOWED',
  'WITHDRAWAL_NOT_ALLOWED',
  'SPLIT_EXPIRED',
  'SPLIT_REVOKED',
  'SPLIT_ALREADY_PAID',
  'FEATURE_DISABLED',
  'CONFIGURATION_INVALID',
  'INTERNAL_ERROR',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
    submissionPossible: z.boolean(),
    requestId: z.string().min(1).max(64),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly submissionPossible: boolean;
  readonly safeDetails: Readonly<Record<string, string>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      submissionPossible?: boolean;
      safeDetails?: Readonly<Record<string, string>>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.submissionPossible = options.submissionPossible ?? false;
    this.safeDetails = options.safeDetails;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
