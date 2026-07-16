import { z } from 'zod';
import { EvmAddressSchema } from './address.js';
import {
  Bytes32Schema,
  OrderIdSchema,
  SplitIdSchema,
  SplitInvitationIdSchema,
  UserIdSchema,
} from './ids.js';
import { BaseUnitAmountSchema, sumEquals, Uint64StringSchema } from './money.js';

export const SplitStatusSchema = z.enum([
  'active',
  'partially_paid',
  'revoking',
  'complete',
  'expired',
  'revoked',
]);
export const SplitInvitationStatusSchema = z.enum([
  'unpaid',
  'submission_started',
  'submitted_unknown',
  'confirming',
  'paid',
  'expired',
  'revoked',
]);

export const SplitInvitationSchema = z.object({
  id: SplitInvitationIdSchema,
  participantLabel: z.string().trim().min(1).max(60),
  amountBaseUnits: BaseUnitAmountSchema,
  status: SplitInvitationStatusSchema,
  expiresAt: z.string().datetime(),
});

export const SplitSchema = z.object({
  id: SplitIdSchema,
  orderId: OrderIdSchema,
  creatorUserId: UserIdSchema,
  beneficiary: EvmAddressSchema,
  totalBaseUnits: BaseUnitAmountSchema,
  confirmedBaseUnits: BaseUnitAmountSchema,
  status: SplitStatusSchema,
  invitations: z.array(SplitInvitationSchema).min(1).max(50),
  expiresAt: z.string().datetime(),
});

export const SplitReimbursementIntentSchema = z.object({
  paymentKey: Bytes32Schema,
  splitDigest: Bytes32Schema,
  originalOrderKey: Bytes32Schema,
  payer: EvmAddressSchema,
  beneficiary: EvmAddressSchema,
  token: EvmAddressSchema,
  amountBaseUnits: BaseUnitAmountSchema,
  validAfter: Uint64StringSchema,
  validUntil: Uint64StringSchema.refine((value) => BigInt(value) > 0n),
  metadataHash: Bytes32Schema,
});

export const SplitReimbursementBindingSchema = z.object({
  intent: SplitReimbursementIntentSchema,
  intentDigest: Bytes32Schema,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signerKeyId: z.string().min(1).max(80),
});

export type Split = z.infer<typeof SplitSchema>;
export type SplitInvitation = z.infer<typeof SplitInvitationSchema>;
export type SplitReimbursementIntent = z.infer<typeof SplitReimbursementIntentSchema>;
export type SplitReimbursementBinding = z.infer<typeof SplitReimbursementBindingSchema>;

export function validateSplitAllocation(
  amounts: readonly z.infer<typeof BaseUnitAmountSchema>[],
  total: z.infer<typeof BaseUnitAmountSchema>,
): boolean {
  return (
    amounts.length > 0 &&
    amounts.every((amount) => BigInt(amount) > 0n) &&
    sumEquals(amounts, total)
  );
}
