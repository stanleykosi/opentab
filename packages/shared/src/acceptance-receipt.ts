import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';
import {
  EvidenceDigestSchema,
  OrderIdSchema,
  PaymentAttemptIdSchema,
  ProviderOperationIdSchema,
} from './ids.js';

const ReceiptMacSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const LiveAcceptanceReceiptPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('accepted'),
    evidenceId: z.string().uuid(),
    releaseId: z.string().regex(/^[0-9a-fA-F]{40}$/),
    deploymentConfigDigest: EvidenceDigestSchema,
    orderId: OrderIdSchema,
    paymentAttemptId: PaymentAttemptIdSchema,
    providerOperationId: ProviderOperationIdSchema,
    payloadDigest: EvidenceDigestSchema,
    ingestionFileDigest: EvidenceDigestSchema,
    artifactFileDigest: EvidenceDigestSchema,
    acceptedAt: z.string().datetime(),
  })
  .strict();

export const LiveAcceptanceReceiptSchema = LiveAcceptanceReceiptPayloadSchema.extend({
  receiptMac: ReceiptMacSchema,
}).strict();

export type LiveAcceptanceReceiptPayload = z.infer<typeof LiveAcceptanceReceiptPayloadSchema>;
export type LiveAcceptanceReceipt = z.infer<typeof LiveAcceptanceReceiptSchema>;

function bytesToHex(value: Uint8Array): `0x${string}` {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function digestLiveAcceptanceFile(content: string): z.infer<typeof EvidenceDigestSchema> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > 1024 * 1024) {
    throw new RangeError('Live acceptance file exceeds the one-megabyte bound');
  }
  return EvidenceDigestSchema.parse(bytesToHex(sha256(bytes)));
}

function receiptMessage(payload: LiveAcceptanceReceiptPayload): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      domain: 'opentab/live-acceptance-ingestion-receipt',
      version: 1,
      ...payload,
    }),
  );
}

export function createLiveAcceptanceReceipt(
  secret: string,
  input: z.input<typeof LiveAcceptanceReceiptPayloadSchema>,
): LiveAcceptanceReceipt {
  if (secret.length < 32) throw new RangeError('Live acceptance receipt secret is too short');
  const payload = LiveAcceptanceReceiptPayloadSchema.parse(input);
  return LiveAcceptanceReceiptSchema.parse({
    ...payload,
    receiptMac: bytesToHex(hmac(sha256, new TextEncoder().encode(secret), receiptMessage(payload))),
  });
}

export function verifyLiveAcceptanceReceipt(secret: string, input: unknown): LiveAcceptanceReceipt {
  const receipt = LiveAcceptanceReceiptSchema.parse(input);
  const { receiptMac, ...payload } = receipt;
  const expected = createLiveAcceptanceReceipt(secret, payload).receiptMac.toLowerCase();
  const supplied = receiptMac.toLowerCase();
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < Math.max(expected.length, supplied.length); index += 1) {
    difference |= (expected.charCodeAt(index) || 0) ^ (supplied.charCodeAt(index) || 0);
  }
  if (difference !== 0) throw new Error('Live acceptance receipt MAC is invalid');
  return receipt;
}
