import { AppError, ErrorCodeSchema } from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { errorResponse, HTTP_STATUS_BY_ERROR_CODE } from './http.js';

describe('exhaustive API error status mapping', () => {
  it('maps every current error code deliberately with no runtime fallback', () => {
    expect(Object.keys(HTTP_STATUS_BY_ERROR_CODE).sort()).toEqual(
      [...ErrorCodeSchema.options].sort(),
    );
    for (const code of ErrorCodeSchema.options) {
      const status = HTTP_STATUS_BY_ERROR_CODE[code];
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
      expect(errorResponse(new AppError(code, 'Safe message'), 'req_test').status).toBe(status);
    }
  });

  it('classifies vendor/RPC failures as 502 and controlled outages as 503', () => {
    for (const code of [
      'AUTH_PROVIDER_UNAVAILABLE',
      'UA_PROVIDER_SCHEMA_INVALID',
      'UA_SUBMISSION_FAILED',
      'RPC_UNAVAILABLE',
      'RPC_INCONSISTENT',
    ] as const) {
      expect(HTTP_STATUS_BY_ERROR_CODE[code]).toBe(502);
    }
    for (const code of [
      'INDEXER_LAGGING',
      'FEATURE_DISABLED',
      'SPONSOR_DISABLED',
      'CONFIGURATION_INVALID',
      'INTERNAL_ERROR',
    ] as const) {
      expect(HTTP_STATUS_BY_ERROR_CODE[code]).toBe(503);
    }
  });
});
