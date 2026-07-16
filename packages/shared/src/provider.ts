import { z } from 'zod';
import { ChainIdSchema, EvmAddressSchema } from './address.js';
import { EvidenceDigestSchema, ProviderOperationIdSchema, TransactionHashSchema } from './ids.js';
import { BaseUnitAmountSchema, UnsignedIntegerStringSchema } from './money.js';

export const EvidenceProvenanceSchema = z.enum([
  'deterministic',
  'staging',
  'recorded_live',
  'live',
]);

export const AdapterEvidenceSchema = z.object({
  adapter: z.string().min(1).max(80),
  packageVersion: z.string().min(1).max(40),
  schemaVersion: z.number().int().positive(),
  environment: z.string().min(1).max(40),
  observedAt: z.string().datetime(),
  evidenceDigest: EvidenceDigestSchema,
  provenance: EvidenceProvenanceSchema,
});

export const DelegationStatusSchema = z.object({
  ownerAddress: EvmAddressSchema,
  chainId: ChainIdSchema,
  delegated: z.boolean(),
  implementationAddress: EvmAddressSchema.optional(),
  implementationCodeHash: EvidenceDigestSchema.optional(),
  transactionHash: TransactionHashSchema.optional(),
  evidence: AdapterEvidenceSchema,
});

export const VerifiedDelegationPlanSchema = z.object({
  ownerAddress: EvmAddressSchema,
  chainId: ChainIdSchema,
  implementationAddress: EvmAddressSchema,
  implementationCodeHash: EvidenceDigestSchema,
  nonce: UnsignedIntegerStringSchema,
  transactionTarget: EvmAddressSchema,
  data: z.literal('0x'),
  valueWei: z.literal('0'),
  expiresAt: z.string().datetime(),
  bindingDigest: EvidenceDigestSchema,
});

export const UnifiedBalanceSchema = z.object({
  totalUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  assets: z.array(
    z.object({
      tokenType: z.enum(['usdc', 'usdt', 'eth', 'sol', 'bnb']),
      amount: z.string().min(1).max(100),
      amountUsd: z.string().min(1).max(100),
      chains: z.array(
        z.object({
          chainId: ChainIdSchema,
          tokenAddress: z.string().min(1).max(128),
          symbol: z.string().min(1).max(20),
          amount: z.string().min(1).max(100),
          amountUsd: z.string().min(1).max(100),
          rawAmount: BaseUnitAmountSchema,
        }),
      ),
    }),
  ),
  fetchedAt: z.string().datetime(),
  evidence: AdapterEvidenceSchema,
});

export const ProviderOperationStatusSchema = z.enum([
  'preparing',
  'moving_funds',
  'executing',
  'succeeded',
  'failed',
  'refunding',
  'refunded',
  'unknown',
]);

export const ProviderOperationSchema = z.object({
  id: ProviderOperationIdSchema,
  status: ProviderOperationStatusSchema,
  submissionPossible: z.boolean(),
  destinationTransactionHash: TransactionHashSchema.optional(),
  activityUrl: z.string().url().optional(),
  updatedAt: z.string().datetime(),
  evidence: AdapterEvidenceSchema,
});

export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;
export type AdapterEvidence = z.infer<typeof AdapterEvidenceSchema>;
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;
export type VerifiedDelegationPlan = z.infer<typeof VerifiedDelegationPlanSchema>;
export type UnifiedBalance = z.infer<typeof UnifiedBalanceSchema>;
export type ProviderOperation = z.infer<typeof ProviderOperationSchema>;
