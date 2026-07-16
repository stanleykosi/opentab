import { z } from 'zod';
import { ChainIdSchema, EvmAddressSchema } from './address.js';
import { CanonicalEventProofSchema } from './chain-events.js';
import {
  EvidenceDigestSchema,
  EvidenceIdSchema,
  OrderIdSchema,
  ProviderOperationIdSchema,
  ReceiptIdSchema,
  TransactionHashSchema,
} from './ids.js';
import { BaseUnitAmountSchema, UnsignedIntegerStringSchema } from './money.js';
import { EvidenceProvenanceSchema } from './provider.js';

export const JudgeClaimEvidenceSchema = z.enum([
  'evidenced',
  'not_evidenced',
  'deterministic_fixture',
]);

const PublicUsdAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);

export const JudgeRouteSourceSchema = z.object({
  chainId: ChainIdSchema,
  symbol: z.string().min(1).max(20),
  amount: z.string().min(1).max(100),
  amountUsd: PublicUsdAmountSchema,
});

export const PublicJudgeProofSchema = z.object({
  evidenceId: EvidenceIdSchema,
  orderId: OrderIdSchema,
  provenance: EvidenceProvenanceSchema,
  environment: z.enum(['local', 'preview', 'staging', 'demo-mainnet', 'production']),
  capturedAt: z.string().datetime(),
  refreshedAt: z.string().datetime(),
  versions: z.object({
    application: z.string().min(1).max(80),
    particleSdk: z.string().min(1).max(40),
    magicSdk: z.string().min(1).max(40),
    contracts: z.string().min(1).max(40),
  }),
  account: z.object({
    magicEoaBefore: EvmAddressSchema,
    magicEoaAfter: EvmAddressSchema,
    addressContinuous: z.boolean(),
    continuityEvidence: JudgeClaimEvidenceSchema.default('not_evidenced'),
    authMethod: z.enum(['google', 'email_otp']),
    delegationTarget: EvmAddressSchema.optional(),
    delegationTransactionHash: TransactionHashSchema.optional(),
  }),
  particle: z.object({
    eip7702Enabled: z.boolean(),
    eip7702Evidence: JudgeClaimEvidenceSchema.default('not_evidenced'),
    universalAccountAddress: EvmAddressSchema,
    routeEvidence: JudgeClaimEvidenceSchema.default('not_evidenced'),
    totalUsd: PublicUsdAmountSchema.optional(),
    sourceSummary: z.array(JudgeRouteSourceSchema).max(20),
    estimatedFeeUsd: PublicUsdAmountSchema.optional(),
    slippageBps: UnsignedIntegerStringSchema.optional(),
    quoteObservedAt: z.string().datetime().optional(),
    previewDigest: EvidenceDigestSchema.optional(),
    operationId: ProviderOperationIdSchema.optional(),
    activityUrl: z.string().url().optional(),
  }),
  settlement: z.object({
    chainId: ChainIdSchema,
    checkoutAddress: EvmAddressSchema,
    passAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    amountBaseUnits: BaseUnitAmountSchema,
    receiptId: ReceiptIdSchema,
    passTokenId: UnsignedIntegerStringSchema.refine((value) => BigInt(value) > 0n),
    event: CanonicalEventProofSchema,
  }),
  recovery: z.object({
    submissionPersistedBeforeWait: z.boolean(),
    submissionPersistenceEvidence: JudgeClaimEvidenceSchema.default('not_evidenced'),
    reloadRecovered: z.boolean(),
    reloadRecoveryEvidence: JudgeClaimEvidenceSchema.default('not_evidenced'),
    duplicatePrevented: z.boolean(),
    duplicatePreventionEvidence: JudgeClaimEvidenceSchema.default('not_evidenced'),
    timing: z.object({
      authenticationMs: UnsignedIntegerStringSchema.optional(),
      delegationMs: UnsignedIntegerStringSchema.optional(),
      routePreparationMs: UnsignedIntegerStringSchema.optional(),
      submissionToCanonicalMs: UnsignedIntegerStringSchema.optional(),
      recoveryVerificationMs: UnsignedIntegerStringSchema.optional(),
      totalDurationMs: UnsignedIntegerStringSchema,
    }),
  }),
});

export type PublicJudgeProof = z.infer<typeof PublicJudgeProofSchema>;
