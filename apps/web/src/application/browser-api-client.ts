import {
  BoundOperationTemplateSchema,
  CheckoutBindingSchema,
  CheckoutSessionIdSchema,
  CurrentUserSchema,
  DelegationStatusSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  MerchantSchema,
  OrderIdSchema,
  OrderKeySchema,
  PaymentAttemptIdSchema,
  PaymentAttemptStatusSchema,
  ProductSchema,
  ProviderOperationIdSchema,
  PublicJudgeProofSchema,
  QuantitySchema,
  QuotePreviewSchema,
  RefundIdSchema,
  SplitInvitationIdSchema,
  SplitSchema,
  TransactionHashSchema,
  UnifiedBalanceSchema,
  UserIdSchema,
  WithdrawalIdSchema,
} from '@opentab/shared';
import { z } from 'zod';
import {
  BrowserApiError,
  type BrowserSession,
  type PublicBrowserConfig,
  PublicBrowserConfigSchema,
  type PublicProductRecord,
  PublicProductRecordSchema,
  BrowserSessionSchema as SessionResultSchema,
} from './public-session-api-client';

export {
  BrowserApiError,
  type BrowserSession,
  type PublicBrowserConfig,
  PublicBrowserConfigSchema,
  type PublicProductRecord,
  PublicProductRecordSchema,
} from './public-session-api-client';

const RequestIdSchema = z.string().min(1).max(128);
const DateTimeSchema = z.string().datetime();
const UnsignedIntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SplitCapabilityReferenceSchema = z
  .string()
  .min(33)
  .max(401)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new BrowserApiError({
      code: 'VALIDATION_FAILED',
      message: 'The requested resource reference is invalid.',
      status: 0,
    });
  }
  return encodeURIComponent(value);
}

const ApiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(1_000),
        retryable: z.boolean().optional(),
        submissionPossible: z.boolean().optional(),
        requestId: RequestIdSchema,
      })
      .strict(),
  })
  .strict();

const AuthContinuationSchema = z
  .object({
    continuationId: z.string().min(16).max(256),
    expiresAt: DateTimeSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const CurrentSessionSchema = z
  .object({ user: CurrentUserSchema, requestId: RequestIdSchema })
  .strict();

const JudgeProofResponseSchema = z
  .object({ proof: PublicJudgeProofSchema, requestId: RequestIdSchema })
  .strict();

const MerchantSummaryResponseSchema = z
  .object({
    merchant: MerchantSchema,
    grossBaseUnits: UnsignedIntegerSchema,
    refundedBaseUnits: UnsignedIntegerSchema,
    pendingBaseUnits: UnsignedIntegerSchema,
    withdrawableBaseUnits: UnsignedIntegerSchema,
    withdrawnBaseUnits: UnsignedIntegerSchema,
    loyaltyMembers: UnsignedIntegerSchema,
    observedAt: DateTimeSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const MerchantOrderListResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            order: z.lazy(() => OrderRecordSchema),
            productTitle: z.string().min(1).max(140),
          })
          .strict(),
      )
      .max(100),
    nextCursor: z.string().min(4).max(512).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const CustomerOrderListResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            order: z.lazy(() => OrderRecordSchema),
            merchantDisplayName: z.string().min(2).max(100),
            merchantSlug: z
              .string()
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
              .max(80),
            product: ProductSchema,
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.string().min(4).max(512).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const MerchantProductListResponseSchema = z
  .object({
    items: z.array(ProductSchema).max(100),
    nextCursor: z.string().min(4).max(512).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const OrderSnapshotResponseSchema = z
  .object({
    order: z.lazy(() => OrderRecordSchema),
    merchant: MerchantSchema,
    product: ProductSchema,
    attempt: z.lazy(() => PaymentAttemptRecordSchema).optional(),
    receipt: z
      .object({
        status: z.enum(['expected', 'issued', 'revoked', 'orphaned']),
        tokenId: UnsignedIntegerSchema.optional(),
      })
      .strict()
      .optional(),
    pendingRefund: z
      .object({
        id: RefundIdSchema,
        orderId: OrderIdSchema,
        amountBaseUnits: UnsignedIntegerSchema,
        status: z.enum([
          'created',
          'prepared',
          'submission_started',
          'submitted',
          'submitted_unknown',
          'confirming',
          'confirmed',
          'failed',
          'mismatch',
          'orphaned',
        ]),
        providerOperationId: ProviderOperationIdSchema.optional(),
        createdAt: DateTimeSchema,
        updatedAt: DateTimeSchema,
      })
      .strict()
      .optional(),
    refundOperation: z.lazy(() => ContractOperationRecordSchema).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const MerchantCatalogResponseSchema = z
  .object({
    merchant: MerchantSchema,
    products: z.array(ProductSchema).max(1_000),
    observedAt: DateTimeSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const MerchantProfileResponseSchema = z
  .object({
    merchant: MerchantSchema,
    version: UnsignedIntegerSchema.optional(),
    chainSyncStatus: z
      .enum(['not_required', 'pending', 'submitted', 'confirmed', 'mismatch', 'failed'])
      .optional(),
    operation: z.lazy(() => ContractOperationRecordSchema).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const MerchantCreateResponseSchema = z
  .object({
    merchant: MerchantSchema,
    operation: z.lazy(() => ContractOperationRecordSchema),
    requestId: RequestIdSchema,
  })
  .strict();

const ProductMutationResponseSchema = z
  .object({
    product: ProductSchema,
    optimisticVersion: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
    operation: z.lazy(() => ContractOperationRecordSchema),
    requestId: RequestIdSchema,
  })
  .strict();

const ProductStatusResponseSchema = z
  .object({
    id: ProductSchema.shape.id,
    status: ProductSchema.shape.status,
    operation: z.lazy(() => ContractOperationRecordSchema),
    requestId: RequestIdSchema,
  })
  .strict();

const CheckoutLinkResponseSchema = z
  .object({
    id: z.string().min(1).max(256),
    reference: z.string().min(16).max(256),
    productId: ProductSchema.shape.id,
    campaign: z.string().min(1).max(100).optional(),
    expiresAt: DateTimeSchema.optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const SettlementResponseSchema = z
  .object({
    merchantId: MerchantSchema.shape.id,
    grossBaseUnits: UnsignedIntegerSchema,
    withdrawnBaseUnits: UnsignedIntegerSchema,
    availableBaseUnits: UnsignedIntegerSchema,
    observedAt: DateTimeSchema,
    pendingWithdrawal: z
      .object({
        id: WithdrawalIdSchema,
        merchantId: MerchantSchema.shape.id,
        recipient: EvmAddressSchema,
        amountBaseUnits: UnsignedIntegerSchema,
        status: z.enum([
          'created',
          'prepared',
          'submission_started',
          'submitted',
          'submitted_unknown',
          'confirming',
          'confirmed',
          'failed',
          'mismatch',
          'orphaned',
        ]),
        providerOperationId: ProviderOperationIdSchema.optional(),
        transactionHash: TransactionHashSchema.optional(),
        confirmedAt: DateTimeSchema.optional(),
        createdAt: DateTimeSchema,
        updatedAt: DateTimeSchema,
      })
      .strict()
      .optional(),
    withdrawalOperation: z.lazy(() => ContractOperationRecordSchema).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const LoyaltyProgramSchema = z
  .object({
    id: z.string().min(1).max(128),
    merchantId: MerchantSchema.shape.id,
    name: z.string().min(1).max(100),
    thresholdPoints: UnsignedIntegerSchema,
    enabled: z.boolean(),
    version: UnsignedIntegerSchema,
    updatedAt: DateTimeSchema,
  })
  .strict();

const LoyaltyStatusResponseSchema = z
  .object({
    programs: z.array(LoyaltyProgramSchema).max(1_000),
    balances: z
      .array(
        z
          .object({
            programId: z.string().min(1).max(128),
            points: UnsignedIntegerSchema,
          })
          .strict(),
      )
      .max(1_000),
    observedAt: DateTimeSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const LoyaltyMutationResponseSchema = z
  .object({ program: LoyaltyProgramSchema, requestId: RequestIdSchema })
  .strict();

const LogoutResultSchema = z
  .object({ revoked: z.literal(true), requestId: RequestIdSchema })
  .strict();

export const ContractOperationRecordSchema = z
  .object({
    id: z.string().regex(/^cop_[0-9A-HJKMNP-TV-Z]{26}$/),
    kind: z.enum([
      'merchant_mutation',
      'product_mutation',
      'refund',
      'withdrawal',
      'split_reimbursement',
      'split_revocation',
    ]),
    aggregateType: z.enum([
      'merchant',
      'product',
      'refund',
      'withdrawal',
      'split_payment',
      'split',
    ]),
    aggregateId: z.string().min(1).max(128),
    binding: z.record(z.string(), z.unknown()),
    template: BoundOperationTemplateSchema,
    bindingDigest: EvidenceDigestSchema,
    status: z.enum([
      'prepared',
      'submission_started',
      'submitted',
      'submitted_unknown',
      'confirming',
      'confirmed',
      'failed',
      'orphaned',
    ]),
    providerOperationId: ProviderOperationIdSchema.optional(),
    transactionHash: TransactionHashSchema.optional(),
    canonicalEventName: z.string().min(1).max(80).optional(),
    expiresAt: DateTimeSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .strict();

const ContractOperationResponseSchema = z
  .object({ operation: ContractOperationRecordSchema, requestId: RequestIdSchema })
  .strict();

const MerchantProductDetailResponseSchema = z
  .object({
    product: ProductSchema,
    optimisticVersion: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
    chainSyncStatus: z.enum([
      'not_required',
      'pending',
      'submitted',
      'confirmed',
      'mismatch',
      'failed',
    ]),
    operation: ContractOperationRecordSchema.optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const PreparedRefundResponseSchema = z
  .object({
    refund: z
      .object({
        id: RefundIdSchema,
        status: z.literal('created'),
        amountBaseUnits: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
      })
      .strict(),
    operation: ContractOperationRecordSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const PreparedWithdrawalResponseSchema = z
  .object({
    withdrawal: z
      .object({
        id: WithdrawalIdSchema,
        status: z.literal('created'),
        amountBaseUnits: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
      })
      .strict(),
    operation: ContractOperationRecordSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const SplitCapabilityResponseSchema = z
  .object({
    split: SplitSchema,
    invitation: z
      .object({
        id: SplitInvitationIdSchema,
        participantLabel: z.string().trim().min(1).max(80),
        amountBaseUnits: UnsignedIntegerSchema,
        status: z.enum([
          'unpaid',
          'submission_started',
          'submitted_unknown',
          'confirming',
          'paid',
          'expired',
          'revoked',
        ]),
        expiresAt: DateTimeSchema,
      })
      .strict(),
    existingPayment: z.lazy(() => SplitPaymentRecordSchema).optional(),
    operation: ContractOperationRecordSchema.optional(),
    requestId: RequestIdSchema,
  })
  .strict();

export const SplitCreateResponseSchema = z
  .object({
    splitId: SplitSchema.shape.id,
    invitations: z
      .array(
        z
          .object({
            invitationId: SplitInvitationIdSchema,
            participantLabel: z.string().trim().min(1).max(80),
            amountBaseUnits: UnsignedIntegerSchema,
            capabilityReference: z.string().min(33).max(401),
            expiresAt: DateTimeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    requestId: RequestIdSchema,
  })
  .strict();

const SplitRevocationResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      splitId: SplitSchema.shape.id,
      status: z.literal('revoked'),
      reason: z.string().trim().min(3).max(200),
      requestId: RequestIdSchema,
    })
    .strict(),
  z
    .object({
      splitId: SplitSchema.shape.id,
      status: z.literal('revoking'),
      reason: z.string().trim().min(3).max(200),
      operations: z.array(ContractOperationRecordSchema).min(1).max(50),
      requestId: RequestIdSchema,
    })
    .strict(),
]);

const SplitPaymentRecordSchema = z
  .object({
    id: z.string().min(16).max(128),
    splitId: SplitSchema.shape.id,
    invitationId: SplitInvitationIdSchema,
    amountBaseUnits: UnsignedIntegerSchema,
    status: z.enum([
      'unpaid',
      'submission_started',
      'submitted_unknown',
      'confirming',
      'paid',
      'failed',
      'orphaned',
    ]),
    providerOperationId: ProviderOperationIdSchema.optional(),
    transactionHash: TransactionHashSchema.optional(),
    confirmedAt: DateTimeSchema.optional(),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .strict();

const PreparedSplitPaymentResponseSchema = z
  .object({
    payment: SplitPaymentRecordSchema,
    binding: z.record(z.string(), z.unknown()),
    operation: ContractOperationRecordSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const CheckoutSessionCreatedSchema = z
  .object({
    sessionId: CheckoutSessionIdSchema,
    expiresAt: DateTimeSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const CheckoutSessionRecordSchema = z
  .object({
    id: CheckoutSessionIdSchema,
    userId: UserIdSchema.optional(),
    productId: ProductSchema.shape.id,
    productVersion: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
    quantity: QuantitySchema,
    receiptRecipient: EvmAddressSchema.optional(),
    amountBaseUnits: UnsignedIntegerSchema,
    orderKey: OrderKeySchema,
    status: z.enum(['active', 'bound', 'consumed', 'expired', 'cancelled']),
    expiresAt: DateTimeSchema,
    bindingDigest: EvidenceDigestSchema.optional(),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .strict();

const OrderRecordSchema = z
  .object({
    id: OrderIdSchema,
    checkoutSessionId: CheckoutSessionIdSchema,
    orderKey: OrderKeySchema,
    userId: UserIdSchema,
    merchantId: MerchantSchema.shape.id,
    productId: ProductSchema.shape.id,
    payer: EvmAddressSchema,
    recipient: EvmAddressSchema,
    quantity: QuantitySchema,
    amountBaseUnits: UnsignedIntegerSchema,
    paidAmountBaseUnits: UnsignedIntegerSchema,
    refundedAmountBaseUnits: UnsignedIntegerSchema,
    status: z.enum([
      'created',
      'submission_started',
      'submitted',
      'executing',
      'paid',
      'partially_refunded',
      'refunded',
      'failed_confirmed',
      'mismatch',
      'orphaned',
    ]),
    providerOperationId: ProviderOperationIdSchema.optional(),
    transactionHash: TransactionHashSchema.optional(),
    confirmedAt: DateTimeSchema.optional(),
    refundableUntil: DateTimeSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .strict();

const PaymentAttemptRecordSchema = z
  .object({
    id: PaymentAttemptIdSchema,
    orderId: OrderIdSchema,
    checkoutSessionId: CheckoutSessionIdSchema,
    attemptNumber: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
    status: PaymentAttemptStatusSchema,
    bindingDigest: EvidenceDigestSchema,
    providerOperationId: ProviderOperationIdSchema.optional(),
    destinationTransactionHash: TransactionHashSchema.optional(),
    preparedExpiresAt: DateTimeSchema.optional(),
    reconciliationRequired: z.boolean(),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .strict();

const CanonicalOrderPaidSchema = z
  .object({
    eventName: z.literal('OrderPaid'),
    canonical: z.literal(true),
    transactionHash: TransactionHashSchema,
    blockNumber: UnsignedIntegerSchema,
    blockHash: EvidenceDigestSchema,
    logIndex: UnsignedIntegerSchema,
    confirmations: UnsignedIntegerSchema,
    requiredConfirmations: UnsignedIntegerSchema,
    observedAt: DateTimeSchema,
  })
  .strict();

const ReceiptProjectionSchema = z
  .object({
    status: z.enum(['expected', 'issued', 'revoked', 'orphaned']),
    tokenId: UnsignedIntegerSchema.optional(),
  })
  .strict();

export const CheckoutSnapshotResponseSchema = z
  .object({
    session: CheckoutSessionRecordSchema,
    order: OrderRecordSchema.optional(),
    attempt: PaymentAttemptRecordSchema.optional(),
    product: ProductSchema,
    merchant: MerchantSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const PaymentWorkflowResponseSchema = z
  .object({
    attempt: PaymentAttemptRecordSchema,
    order: OrderRecordSchema,
    receipt: ReceiptProjectionSchema.optional(),
    canonicalOrderPaid: CanonicalOrderPaidSchema.optional(),
    requestId: RequestIdSchema,
  })
  .strict();

const CheckoutSessionBoundSchema = z
  .object({ session: CheckoutSessionRecordSchema, requestId: RequestIdSchema })
  .strict();

const CheckoutQuoteSchema = z
  .object({
    checkoutSessionId: CheckoutSessionIdSchema,
    quote: QuotePreviewSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const PaymentAttemptCreatedSchema = z
  .object({ binding: CheckoutBindingSchema, requestId: RequestIdSchema })
  .strict();

const PaymentAttemptMutationSchema = z
  .object({ attempt: PaymentAttemptRecordSchema, requestId: RequestIdSchema })
  .strict();

const WalletReadinessSchema = z
  .object({
    ownerAddress: EvmAddressSchema,
    universalAccountAddress: EvmAddressSchema,
    ownerMatches: z.boolean(),
    delegation: DelegationStatusSchema,
    ready: z.boolean(),
    blockers: z.array(
      z.enum([
        'owner_mismatch',
        'delegation_required',
        'delegation_target_mismatch',
        'balance_unavailable',
      ]),
    ),
    observedAt: DateTimeSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const WalletBalanceSchema = z
  .object({ balance: UnifiedBalanceSchema, requestId: RequestIdSchema })
  .strict();

const BootstrapEligibilitySchema = z
  .object({
    eligible: z.boolean(),
    recipient: EvmAddressSchema,
    targetWei: UnsignedIntegerSchema,
    confirmedBalanceWei: UnsignedIntegerSchema,
    pendingAmountWei: UnsignedIntegerSchema,
    deficitWei: UnsignedIntegerSchema,
    reason: z
      .enum([
        'eligible',
        'already_prepared',
        'sufficient_balance',
        'policy_disabled',
        'risk_rejected',
      ])
      .optional(),
    observedAt: DateTimeSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const SponsorGrantSchema = z
  .object({
    id: z.string().min(16).max(256),
    userId: UserIdSchema,
    recipient: EvmAddressSchema,
    amountWei: UnsignedIntegerSchema,
    status: z.enum([
      'created',
      'submission_started',
      'submitted',
      'submitted_unknown',
      'confirmed',
      'failed',
      'replaced',
      'orphaned',
    ]),
    transactionHash: TransactionHashSchema.optional(),
    createdAt: DateTimeSchema,
  })
  .strict();

const SponsorGrantResponseSchema = z
  .object({ grant: SponsorGrantSchema, requestId: RequestIdSchema })
  .strict();

export type CheckoutSnapshotResponse = z.infer<typeof CheckoutSnapshotResponseSchema>;
export type PaymentWorkflowResponse = z.infer<typeof PaymentWorkflowResponseSchema>;
export type WalletReadinessResponse = z.infer<typeof WalletReadinessSchema>;
export type WalletBalanceResponse = z.infer<typeof WalletBalanceSchema>;
export type BootstrapEligibilityResponse = z.infer<typeof BootstrapEligibilitySchema>;
export type MerchantSummaryResponse = z.infer<typeof MerchantSummaryResponseSchema>;
export type MerchantOrderListResponse = z.infer<typeof MerchantOrderListResponseSchema>;
export type CustomerOrderListResponse = z.infer<typeof CustomerOrderListResponseSchema>;
export type MerchantProductListResponse = z.infer<typeof MerchantProductListResponseSchema>;
export type OrderSnapshotResponse = z.infer<typeof OrderSnapshotResponseSchema>;
export type MerchantCatalogResponse = z.infer<typeof MerchantCatalogResponseSchema>;
export type MerchantProfileResponse = z.infer<typeof MerchantProfileResponseSchema>;
export type ContractOperationRecord = z.infer<typeof ContractOperationRecordSchema>;
export type MerchantProductDetailResponse = z.infer<typeof MerchantProductDetailResponseSchema>;
export type PreparedRefundResponse = z.infer<typeof PreparedRefundResponseSchema>;
export type PreparedWithdrawalResponse = z.infer<typeof PreparedWithdrawalResponseSchema>;
export type SplitCapabilityResponse = z.infer<typeof SplitCapabilityResponseSchema>;
export type SplitCreateResponse = z.infer<typeof SplitCreateResponseSchema>;
export type SplitRevocationResponse = z.infer<typeof SplitRevocationResponseSchema>;
export type PreparedSplitPaymentResponse = z.infer<typeof PreparedSplitPaymentResponseSchema>;

export interface BrowserApiClientOptions {
  fetcher?: typeof fetch;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: Readonly<Record<string, unknown>>;
  csrf?: boolean | 'if-available';
  idempotencyKey?: string;
  headers?: Readonly<Record<string, string>>;
}

export class BrowserApiClient {
  readonly #fetcher: typeof fetch;
  #csrfToken: string | undefined;

  constructor(options: BrowserApiClientOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
  }

  async getPublicConfig(): Promise<PublicBrowserConfig> {
    return this.#request('/api/v1/config/public', PublicBrowserConfigSchema);
  }

  async getPublicProduct(merchantSlug: string, productSlug: string): Promise<PublicProductRecord> {
    return this.#request(
      `/api/v1/merchants/${safeSegment(merchantSlug)}/products/${safeSegment(productSlug)}`,
      PublicProductRecordSchema,
    );
  }

  async getPublicProductById(productId: string): Promise<PublicProductRecord> {
    return this.#request(`/api/v1/products/${safeSegment(productId)}`, PublicProductRecordSchema);
  }

  async getMerchantCatalog(merchantSlug: string): Promise<MerchantCatalogResponse> {
    return this.#request(
      `/api/v1/merchants/${safeSegment(merchantSlug)}`,
      MerchantCatalogResponseSchema,
    );
  }

  async getMerchantSummary(): Promise<MerchantSummaryResponse> {
    return this.#request('/api/v1/merchant/summary', MerchantSummaryResponseSchema);
  }

  async listMerchantOrders(): Promise<MerchantOrderListResponse> {
    return this.#request('/api/v1/merchant/orders?limit=100', MerchantOrderListResponseSchema);
  }

  async listCustomerOrders(cursor?: string): Promise<CustomerOrderListResponse> {
    const query = new URLSearchParams({ limit: '25' });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.#request(
      `/api/v1/account/orders?${query.toString()}`,
      CustomerOrderListResponseSchema,
    );
  }

  async listMerchantProducts(): Promise<MerchantProductListResponse> {
    return this.#request('/api/v1/merchant/products?limit=100', MerchantProductListResponseSchema);
  }

  async getMerchantProduct(productId: string): Promise<MerchantProductDetailResponse> {
    return this.#request(
      `/api/v1/merchant/products/${safeSegment(productId)}`,
      MerchantProductDetailResponseSchema,
    );
  }

  async getOrder(orderId: string): Promise<OrderSnapshotResponse> {
    return this.#request(`/api/v1/orders/${safeSegment(orderId)}`, OrderSnapshotResponseSchema);
  }

  async getReceipt(orderId: string): Promise<OrderSnapshotResponse> {
    return this.#request(`/api/v1/receipts/${safeSegment(orderId)}`, OrderSnapshotResponseSchema);
  }

  async getMerchantProfile(): Promise<MerchantProfileResponse> {
    return this.#request('/api/v1/merchant/profile', MerchantProfileResponseSchema);
  }

  async getMerchantSettlement() {
    return this.#request('/api/v1/merchant/settlement', SettlementResponseSchema);
  }

  async getLoyaltyStatus() {
    return this.#request('/api/v1/loyalty/status', LoyaltyStatusResponseSchema);
  }

  async updateLoyaltyProgram(
    input: { merchantId: string; name: string; thresholdPoints: string; enabled: boolean },
    idempotencyKey: string,
  ) {
    return this.#request('/api/v1/merchant/loyalty', LoyaltyMutationResponseSchema, {
      method: 'PATCH',
      body: input,
      csrf: true,
      idempotencyKey,
    });
  }

  async createMerchantProfile(
    input: {
      slug: string;
      displayName: string;
      supportContact?: string;
      payoutAddress: string;
    },
    idempotencyKey: string,
  ) {
    return this.#request('/api/v1/merchant/profile', MerchantCreateResponseSchema, {
      method: 'POST',
      body: input,
      csrf: true,
      idempotencyKey,
    });
  }

  async updateMerchantProfile(
    input: {
      expectedVersion: string;
      slug?: string;
      displayName?: string;
      supportContact?: string;
      payoutAddress?: string;
    },
    idempotencyKey: string,
  ) {
    return this.#request('/api/v1/merchant/profile', MerchantProfileResponseSchema, {
      method: 'PATCH',
      body: input,
      csrf: true,
      idempotencyKey,
    });
  }

  async onboardMerchant(idempotencyKey: string) {
    return this.#request(
      '/api/v1/merchant/onboarding',
      z
        .object({
          merchantId: MerchantSchema.shape.id,
          status: MerchantSchema.shape.status,
          requestId: RequestIdSchema,
        })
        .strict(),
      { method: 'POST', body: {}, csrf: true, idempotencyKey },
    );
  }

  async createMerchantProduct(
    input: {
      merchantId: string;
      slug: string;
      title: string;
      description: string;
      imageUrl?: string;
      unitPriceBaseUnits: string;
      maxSupply?: string;
      maxPerOrder: string;
      startsAt: string;
      endsAt?: string;
      refundWindowSeconds: string;
      loyaltyPoints: string;
    },
    idempotencyKey: string,
  ) {
    return this.#request('/api/v1/merchant/products', ProductMutationResponseSchema, {
      method: 'POST',
      body: input,
      csrf: true,
      idempotencyKey,
    });
  }

  async updateMerchantProduct(
    productId: string,
    input: {
      expectedVersion: string;
      slug?: string;
      title?: string;
      description?: string;
      imageUrl?: string;
      unitPriceBaseUnits?: string;
      maxSupply?: string;
      maxPerOrder?: string;
      startsAt?: string;
      endsAt?: string;
      refundWindowSeconds?: string;
      loyaltyPoints?: string;
    },
    idempotencyKey: string,
  ) {
    return this.#request(
      `/api/v1/merchant/products/${safeSegment(productId)}`,
      ProductMutationResponseSchema,
      { method: 'PATCH', body: input, csrf: true, idempotencyKey },
    );
  }

  async changeMerchantProductStatus(
    productId: string,
    action: 'publish' | 'pause' | 'archive',
    idempotencyKey: string,
  ) {
    return this.#request(
      `/api/v1/merchant/products/${safeSegment(productId)}/${action}`,
      ProductStatusResponseSchema,
      { method: 'POST', body: {}, csrf: true, idempotencyKey },
    );
  }

  async createCheckoutLink(
    input: { productId: string; campaign?: string; expiresAt?: string },
    idempotencyKey: string,
  ) {
    return this.#request('/api/v1/merchant/checkout-links', CheckoutLinkResponseSchema, {
      method: 'POST',
      body: input,
      csrf: true,
      idempotencyKey,
    });
  }

  async prepareRefund(orderId: string, amountBaseUnits: string, idempotencyKey: string) {
    return this.#request(
      `/api/v1/merchant/orders/${safeSegment(orderId)}/refunds`,
      PreparedRefundResponseSchema,
      {
        method: 'POST',
        body: { amountBaseUnits },
        csrf: true,
        idempotencyKey,
      },
    );
  }

  async prepareWithdrawal(merchantId: string, amountBaseUnits: string, idempotencyKey: string) {
    return this.#request('/api/v1/merchant/withdrawals', PreparedWithdrawalResponseSchema, {
      method: 'POST',
      body: { merchantId, amountBaseUnits },
      csrf: true,
      idempotencyKey,
    });
  }

  async getContractOperation(operationId: string): Promise<ContractOperationRecord> {
    const response = await this.#request(
      `/api/v1/contract-operations/${safeSegment(operationId)}`,
      ContractOperationResponseSchema,
    );
    return response.operation;
  }

  async registerContractOperationSubmission(
    operationId: string,
    input: {
      status: 'submission_started' | 'submitted' | 'submitted_unknown';
      providerOperationId: string;
    },
    idempotencyKey: string,
  ): Promise<ContractOperationRecord> {
    const response = await this.#request(
      `/api/v1/contract-operations/${safeSegment(operationId)}/submission`,
      ContractOperationResponseSchema,
      { method: 'POST', body: input, csrf: true, idempotencyKey },
    );
    return response.operation;
  }

  async getSplitByCapability(reference: string): Promise<SplitCapabilityResponse> {
    const parsed = SplitCapabilityReferenceSchema.safeParse(reference);
    if (!parsed.success) {
      throw new BrowserApiError({
        code: 'VALIDATION_FAILED',
        message: 'This private reimbursement reference is invalid.',
        status: 0,
      });
    }
    const capability = parsed.data;
    return this.#request(
      `/api/v1/split-links/${encodeURIComponent(capability)}`,
      SplitCapabilityResponseSchema,
    );
  }

  async createSplit(
    orderId: string,
    input: {
      beneficiary: string;
      totalBaseUnits: string;
      expiresAt: string;
      participants: readonly { label: string; amountBaseUnits: string }[];
    },
    idempotencyKey: string,
  ): Promise<SplitCreateResponse> {
    return this.#request(
      `/api/v1/orders/${safeSegment(orderId)}/splits`,
      SplitCreateResponseSchema,
      {
        method: 'POST',
        body: { ...input, participants: [...input.participants] },
        csrf: true,
        idempotencyKey,
      },
    );
  }

  async prepareSplitPayment(
    splitId: string,
    capabilityReference: string,
    idempotencyKey: string,
  ): Promise<PreparedSplitPaymentResponse> {
    return this.#request(
      `/api/v1/splits/${safeSegment(splitId)}/payment-attempts`,
      PreparedSplitPaymentResponseSchema,
      {
        method: 'POST',
        body: { capabilityReference },
        csrf: true,
        idempotencyKey,
      },
    );
  }

  async revokeSplit(splitId: string, reason: string, idempotencyKey: string) {
    return this.#request(
      `/api/v1/splits/${safeSegment(splitId)}/revoke`,
      SplitRevocationResponseSchema,
      {
        method: 'POST',
        body: { reason },
        csrf: true,
        idempotencyKey,
      },
    );
  }

  async createCheckoutSession(
    input: { productId: string; quantity: string },
    idempotencyKey: string,
  ) {
    return this.#request('/api/v1/checkout-sessions', CheckoutSessionCreatedSchema, {
      method: 'POST',
      body: input,
      csrf: 'if-available',
      idempotencyKey,
    });
  }

  async getCheckoutSession(checkoutSessionId: string): Promise<CheckoutSnapshotResponse> {
    return this.#request(
      `/api/v1/checkout-sessions/${safeSegment(checkoutSessionId)}`,
      CheckoutSnapshotResponseSchema,
    );
  }

  async bindCheckoutSession(checkoutSessionId: string, idempotencyKey: string) {
    return this.#request(
      `/api/v1/checkout-sessions/${safeSegment(checkoutSessionId)}/bind`,
      CheckoutSessionBoundSchema,
      { method: 'POST', body: {}, csrf: true, idempotencyKey },
    );
  }

  async refreshCheckoutQuote(
    checkoutSessionId: string,
    reason: 'expired' | 'balance_changed' | 'user_requested',
    idempotencyKey: string,
  ) {
    return this.#request(
      `/api/v1/checkout-sessions/${safeSegment(checkoutSessionId)}/quote-refresh`,
      CheckoutQuoteSchema,
      { method: 'POST', body: { reason }, csrf: true, idempotencyKey },
    );
  }

  async getWalletReadiness(): Promise<WalletReadinessResponse> {
    return this.#request('/api/v1/wallet/readiness', WalletReadinessSchema);
  }

  async getWalletBalance(): Promise<WalletBalanceResponse> {
    return this.#request('/api/v1/wallet/balance', WalletBalanceSchema);
  }

  async getJudgeProof(orderId: string, capability?: string) {
    return this.#request(
      `/api/v1/judge/orders/${safeSegment(orderId)}/proof`,
      JudgeProofResponseSchema,
      capability === undefined ? {} : { headers: { 'X-OpenTab-Judge-Token': capability } },
    );
  }

  async recordDelegationEvidence(
    input: { transactionHash: string; evidenceDigest: string },
    idempotencyKey: string,
  ): Promise<WalletReadinessResponse> {
    return this.#request('/api/v1/wallet/delegation-evidence', WalletReadinessSchema, {
      method: 'POST',
      body: input,
      csrf: true,
      idempotencyKey,
    });
  }

  async evaluateBootstrapEligibility(challengeToken: string, idempotencyKey: string) {
    return this.#request('/api/v1/wallet/bootstrap-gas/eligibility', BootstrapEligibilitySchema, {
      method: 'POST',
      body: { challengeToken },
      csrf: true,
      idempotencyKey,
    });
  }

  async requestBootstrapGrant(challengeToken: string, idempotencyKey: string) {
    return this.#request('/api/v1/wallet/bootstrap-gas/grants', SponsorGrantResponseSchema, {
      method: 'POST',
      body: { challengeToken },
      csrf: true,
      idempotencyKey,
    });
  }

  async getBootstrapGrant(grantId: string) {
    return this.#request(
      `/api/v1/wallet/bootstrap-gas/grants/${safeSegment(grantId)}`,
      SponsorGrantResponseSchema,
    );
  }

  async createPaymentAttempt(checkoutSessionId: string, idempotencyKey: string) {
    return this.#request(
      `/api/v1/checkout-sessions/${safeSegment(checkoutSessionId)}/payment-attempts`,
      PaymentAttemptCreatedSchema,
      { method: 'POST', body: {}, csrf: true, idempotencyKey },
    );
  }

  async recordPreparedPayment(
    paymentAttemptId: string,
    input: {
      providerOperationId: string;
      rootHashDigest: string;
      previewDigest: string;
      expiresAt: string;
      quoteSummary: {
        sourceAmountBaseUnits: string;
        destinationAmountBaseUnits: string;
        feeBaseUnits: string;
        routeLabel: string;
      };
    },
    idempotencyKey: string,
  ) {
    return this.#request(
      `/api/v1/payment-attempts/${safeSegment(paymentAttemptId)}/prepared`,
      PaymentAttemptMutationSchema,
      { method: 'POST', body: input, csrf: true, idempotencyKey },
    );
  }

  async startPaymentSubmission(
    paymentAttemptId: string,
    bindingDigest: string,
    idempotencyKey: string,
  ) {
    return this.#request(
      `/api/v1/payment-attempts/${safeSegment(paymentAttemptId)}/submission/start`,
      PaymentAttemptMutationSchema,
      { method: 'POST', body: { bindingDigest }, csrf: true, idempotencyKey },
    );
  }

  async registerPaymentSubmission(
    paymentAttemptId: string,
    input: { status: 'submitted'; providerOperationId: string } | { status: 'submitted_unknown' },
    idempotencyKey: string,
  ) {
    return this.#request(
      `/api/v1/payment-attempts/${safeSegment(paymentAttemptId)}/submission`,
      PaymentAttemptMutationSchema,
      { method: 'POST', body: input, csrf: true, idempotencyKey },
    );
  }

  async getPaymentAttempt(paymentAttemptId: string): Promise<PaymentWorkflowResponse> {
    return this.#request(
      `/api/v1/payment-attempts/${safeSegment(paymentAttemptId)}`,
      PaymentWorkflowResponseSchema,
    );
  }

  async getPaymentRecovery(paymentAttemptId: string): Promise<PaymentWorkflowResponse> {
    return this.#request(
      `/api/v1/payment-attempts/${safeSegment(paymentAttemptId)}/recovery`,
      PaymentWorkflowResponseSchema,
    );
  }

  async createAuthContinuation(returnPath: string) {
    return this.#request('/api/v1/auth/continuations', AuthContinuationSchema, {
      method: 'POST',
      body: { returnPath },
    });
  }

  async exchangeSession(input: { didToken: string; continuationId: string }) {
    const session = await this.#request('/api/v1/auth/session', SessionResultSchema, {
      method: 'POST',
      body: input,
    });
    this.#csrfToken = session.csrfToken;
    return session;
  }

  async restoreSession(): Promise<BrowserSession> {
    const session = await this.#request('/api/v1/auth/session/refresh', SessionResultSchema, {
      method: 'POST',
      body: {},
    });
    this.#csrfToken = session.csrfToken;
    return session;
  }

  async getCurrentSession() {
    return this.#request('/api/v1/auth/me', CurrentSessionSchema);
  }

  async logoutSession(): Promise<void> {
    await this.#request('/api/v1/auth/session', LogoutResultSchema, {
      method: 'DELETE',
      body: {},
      csrf: true,
    });
    this.#csrfToken = undefined;
  }

  getCsrfTokenForTests(): string | undefined {
    return this.#csrfToken;
  }

  async #request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers = new Headers({ Accept: 'application/json', ...options.headers });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.csrf === true) {
      if (this.#csrfToken === undefined) {
        throw new BrowserApiError({
          code: 'CSRF_UNAVAILABLE',
          message: 'Refresh your secure session before continuing.',
          retryable: true,
          status: 0,
        });
      }
      headers.set('X-CSRF-Token', this.#csrfToken);
    } else if (options.csrf === 'if-available' && this.#csrfToken !== undefined) {
      headers.set('X-CSRF-Token', this.#csrfToken);
    }
    if (options.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', options.idempotencyKey);
    }
    let response: Response;
    try {
      response = await this.#fetcher(path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new BrowserApiError({
        code: 'NETWORK_UNAVAILABLE',
        message: 'OpenTab could not reach the secure server. Try again.',
        retryable: true,
        status: 0,
      });
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsedError = ApiErrorEnvelopeSchema.safeParse(payload);
      if (parsedError.success) {
        throw new BrowserApiError({
          code: parsedError.data.error.code,
          message: parsedError.data.error.message,
          requestId: parsedError.data.error.requestId,
          status: response.status,
          ...(parsedError.data.error.retryable === undefined
            ? {}
            : { retryable: parsedError.data.error.retryable }),
          ...(parsedError.data.error.submissionPossible === undefined
            ? {}
            : { submissionPossible: parsedError.data.error.submissionPossible }),
        });
      }
      throw new BrowserApiError({
        code: 'RESPONSE_INVALID',
        message: 'OpenTab received an unexpected secure-server response and stopped safely.',
        status: response.status,
      });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new BrowserApiError({
        code: 'RESPONSE_INVALID',
        message: 'OpenTab received an unexpected secure-server response and stopped safely.',
        status: response.status,
      });
    }
    return parsed.data;
  }
}
