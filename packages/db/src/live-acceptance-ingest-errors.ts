import { AppError } from '@opentab/shared';

export function safeAcceptanceIngestError(error: unknown): {
  readonly status: 'rejected';
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof AppError) {
    return { status: 'rejected', code: error.code, message: error.message };
  }
  return {
    status: 'rejected',
    code: 'EVIDENCE_INGEST_FAILED',
    message: 'Acceptance evidence ingestion failed.',
  };
}
