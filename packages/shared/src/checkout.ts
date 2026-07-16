import { z } from 'zod';
import { ChainIdSchema, EvmAddressSchema } from './address.js';
import {
  Bytes32Schema,
  CheckoutSessionIdSchema,
  EvidenceDigestSchema,
  OrderIdSchema,
  OrderKeySchema,
  PaymentAttemptIdSchema,
  ProviderOperationIdSchema,
} from './ids.js';
import {
  BaseUnitAmountSchema,
  BasisPointsSchema,
  QuantitySchema,
  Uint64StringSchema,
  UnsignedIntegerStringSchema,
} from './money.js';

export const OrderIntentSchema = z.object({
  orderKey: OrderKeySchema,
  payer: EvmAddressSchema,
  recipient: EvmAddressSchema,
  merchantOnchainId: UnsignedIntegerStringSchema.refine((value) => BigInt(value) > 0n),
  productOnchainId: UnsignedIntegerStringSchema.refine((value) => BigInt(value) > 0n),
  productVersion: Uint64StringSchema.refine((value) => BigInt(value) > 0n),
  token: EvmAddressSchema,
  amountBaseUnits: BaseUnitAmountSchema,
  platformFeeBps: BasisPointsSchema.refine(
    (value) => BigInt(value) <= 500n,
    'Platform fee exceeds immutable contract cap',
  ),
  platformFeeBaseUnits: BaseUnitAmountSchema,
  quantity: QuantitySchema,
  validAfter: Uint64StringSchema,
  validUntil: Uint64StringSchema.refine((value) => BigInt(value) > 0n),
  refundDeadline: Uint64StringSchema,
  metadataHash: Bytes32Schema,
});

export const CheckoutBindingSchema = z.object({
  checkoutSessionId: CheckoutSessionIdSchema,
  attemptId: PaymentAttemptIdSchema,
  orderId: OrderIdSchema,
  orderIntent: OrderIntentSchema,
  orderIntentDigest: EvidenceDigestSchema,
  orderIntentSignature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signerKeyId: z.string().min(1).max(80),
  chainId: ChainIdSchema,
  usdcAddress: EvmAddressSchema,
  checkoutAddress: EvmAddressSchema,
  expiresAt: z.string().datetime(),
  bindingDigest: EvidenceDigestSchema,
});

export const QuoteSourceSchema = z.object({
  chainId: ChainIdSchema,
  symbol: z.string().min(1).max(20),
  amount: z.string().min(1).max(100),
  amountUsd: z.string().min(1).max(100),
});

export const QuotePreviewSchema = z.object({
  amountBaseUnits: BaseUnitAmountSchema,
  estimatedFeeUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  totalUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  slippageBps: BasisPointsSchema,
  sources: z.array(QuoteSourceSchema).min(1),
  quotedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const PaymentAttemptStatusSchema = z.enum([
  'created',
  'prepared',
  'submission_started',
  'submitted',
  'submitted_unknown',
  'executing',
  'confirming',
  'paid',
  'failed_pre_submission',
  'failed_confirmed',
  'expired',
]);

export const CheckoutWorkflowStateSchema = z.enum([
  'idle',
  'loading_product',
  'product_ready',
  'creating_session',
  'authenticating',
  'establishing_session',
  'checking_readiness',
  'requesting_bootstrap_gas',
  'waiting_for_bootstrap_receipt',
  'requesting_delegation_consent',
  'signing_delegation',
  'waiting_for_delegation_receipt',
  'loading_balance',
  'ready_to_pay',
  'preparing_payment',
  'preview_ready',
  'signing_root_hash',
  'submitting_particle',
  'waiting_for_particle',
  'waiting_for_arbitrum',
  'confirmed',
  'retryable_failure',
  'submitted_status_unknown',
  'terminal_failure',
  'cancelled',
  'expired',
]);

export const OperationKindSchema = z.enum([
  'checkout',
  'product_mutation',
  'refund',
  'withdrawal',
  'split_reimbursement',
  'split_revocation',
]);

export const OperationCallSchema = z.object({
  to: EvmAddressSchema,
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  valueWei: BaseUnitAmountSchema,
});

export const BoundOperationTemplateSchema = z.object({
  kind: OperationKindSchema,
  ownerAddress: EvmAddressSchema,
  chainId: ChainIdSchema,
  calls: z.array(OperationCallSchema).min(1).max(3),
  bindingDigest: EvidenceDigestSchema,
  expiresAt: z.string().datetime(),
});

export const UntrustedPreparedOperationSchema = z.object({
  kind: OperationKindSchema,
  rawSchemaVersion: z.string().min(1).max(40),
  rootHash: Bytes32Schema,
  providerOperationId: ProviderOperationIdSchema.optional(),
  quotedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  redactedPayloadDigest: EvidenceDigestSchema,
});

export const ValidatedOperationPlanSchema = z.object({
  planId: EvidenceDigestSchema,
  template: BoundOperationTemplateSchema,
  rootHash: Bytes32Schema,
  quote: QuotePreviewSchema,
  validatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type OrderIntent = z.infer<typeof OrderIntentSchema>;
export type CheckoutBinding = z.infer<typeof CheckoutBindingSchema>;
export type QuotePreview = z.infer<typeof QuotePreviewSchema>;
export type PaymentAttemptStatus = z.infer<typeof PaymentAttemptStatusSchema>;
export type CheckoutWorkflowState = z.infer<typeof CheckoutWorkflowStateSchema>;
export type BoundOperationTemplate = z.infer<typeof BoundOperationTemplateSchema>;
export type UntrustedPreparedOperation = z.infer<typeof UntrustedPreparedOperationSchema>;
export type ValidatedOperationPlan = z.infer<typeof ValidatedOperationPlanSchema>;
