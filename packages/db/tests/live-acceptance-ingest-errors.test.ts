import { AppError } from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { safeAcceptanceIngestError } from '../src/live-acceptance-ingest-errors.js';

describe('live acceptance CLI error redaction', () => {
  it('never emits credentials, private hosts, ports, or protected paths from unknown errors', () => {
    const sensitive =
      'connect failed for postgresql://private_role:private_password@db.internal:5432/opentab while reading /srv/private/evidence/accept.ingest.json';
    const safe = safeAcceptanceIngestError(new Error(sensitive));
    const serialized = JSON.stringify(safe);
    expect(safe).toEqual({
      status: 'rejected',
      code: 'EVIDENCE_INGEST_FAILED',
      message: 'Acceptance evidence ingestion failed.',
    });
    expect(serialized).not.toContain('private_role');
    expect(serialized).not.toContain('private_password');
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('5432');
    expect(serialized).not.toContain('/srv/private');
  });

  it('retains the normalized code and safe message for application errors', () => {
    expect(
      safeAcceptanceIngestError(
        new AppError('VALIDATION_FAILED', 'The acceptance artifact is invalid.'),
      ),
    ).toEqual({
      status: 'rejected',
      code: 'VALIDATION_FAILED',
      message: 'The acceptance artifact is invalid.',
    });
  });
});
