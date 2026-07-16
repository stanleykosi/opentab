import { describe, expect, it } from 'vitest';
import {
  createLiveAcceptanceReceipt,
  verifyLiveAcceptanceReceipt,
} from '../src/acceptance-receipt.js';

const secret = 'acceptance-receipt-test-secret-over-32-bytes';
const payload = {
  schemaVersion: 1 as const,
  status: 'accepted' as const,
  evidenceId: '018f0000-0000-7000-8000-000000000001',
  releaseId: 'b'.repeat(40),
  deploymentConfigDigest: `0x${'dc'.repeat(32)}`,
  orderId: 'ord_01J00000000000000000000000',
  paymentAttemptId: 'pay_01J00000000000000000000000',
  providerOperationId: 'particle-operation-1',
  payloadDigest: `0x${'ab'.repeat(32)}`,
  acceptedAt: '2026-07-14T12:00:00.000Z',
  ingestionFileDigest: `0x${'cd'.repeat(32)}`,
  artifactFileDigest: `0x${'ef'.repeat(32)}`,
};

describe('live acceptance ingestion receipt', () => {
  it('authenticates the exact accepted identity and rejects mutation', () => {
    const receipt = createLiveAcceptanceReceipt(secret, payload);
    expect(verifyLiveAcceptanceReceipt(secret, receipt)).toEqual(receipt);
    expect(() =>
      verifyLiveAcceptanceReceipt(secret, {
        ...receipt,
        orderId: 'ord_01J00000000000000000000001',
      }),
    ).toThrow(/MAC/);
    expect(() => verifyLiveAcceptanceReceipt(`${secret}-wrong`, receipt)).toThrow(/MAC/);
  });
});
