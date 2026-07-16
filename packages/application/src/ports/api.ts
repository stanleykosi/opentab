import type {
  BaseUnitAmount,
  BoundOperationTemplate,
  CheckoutBinding,
  CheckoutSessionId,
  CurrentUser,
  DelegationStatus,
  EvmAddress,
  Merchant,
  MerchantId,
  OrderId,
  Product,
  ProductId,
  PublicJudgeProof,
  Split,
  UnifiedBalance,
} from '@opentab/shared';
import type {
  CheckoutSessionRecord,
  OrderRecord,
  PaymentAttemptRecord,
  SponsorGrantRecord,
} from '../use-cases/index.js';

export interface PublicProductRecord {
  readonly merchant: Merchant;
  readonly product: Product;
  readonly availabilityObservedAt: string;
  readonly projectionStale: boolean;
}

export interface CheckoutSnapshotRecord {
  readonly session: CheckoutSessionRecord;
  readonly order?: OrderRecord;
  readonly attempt?: PaymentAttemptRecord;
}

export interface OrderSnapshotRecord {
  readonly order: OrderRecord;
  readonly merchant: Merchant;
  readonly product: Product;
  readonly attempt?: PaymentAttemptRecord;
  readonly receipt?: {
    readonly status: 'expected' | 'issued' | 'revoked' | 'orphaned';
    readonly tokenId?: string;
  };
  readonly pendingRefund?: ApiOperationResult;
  readonly refundOperation?: ContractOperationRecord;
}

export interface PaymentWorkflowRecord {
  readonly attempt: PaymentAttemptRecord;
  readonly order: OrderRecord;
  readonly receipt?: OrderSnapshotRecord['receipt'];
  readonly canonicalOrderPaid?: {
    readonly eventName: 'OrderPaid';
    readonly canonical: true;
    readonly transactionHash: string;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly logIndex: string;
    readonly confirmations: string;
    readonly requiredConfirmations: string;
    readonly observedAt: string;
  };
}

export interface MerchantSummaryRecord {
  readonly merchant: Merchant;
  readonly grossBaseUnits: string;
  readonly refundedBaseUnits: string;
  readonly pendingBaseUnits: string;
  readonly withdrawableBaseUnits: string;
  readonly withdrawnBaseUnits: string;
  readonly loyaltyMembers: string;
  readonly observedAt: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface MerchantOrderListItem {
  readonly order: OrderRecord;
  readonly productTitle: string;
}

export interface CustomerOrderListItem {
  readonly order: OrderRecord;
  readonly merchantDisplayName: string;
  readonly merchantSlug: string;
  readonly product: Product;
}

export interface SplitCapabilityRecord {
  readonly split: Split;
  readonly invitation: {
    readonly id: string;
    readonly participantLabel: string;
    readonly amountBaseUnits: string;
    readonly status: string;
    readonly expiresAt: string;
  };
  readonly existingPayment?: ApiOperationResult;
  readonly operation?: ContractOperationRecord;
}

export interface BackendApiQueryPort {
  getMerchantCatalog(slug: string): Promise<
    | {
        merchant: Merchant;
        products: readonly Product[];
        observedAt: string;
      }
    | undefined
  >;
  getPublicProductById(productId: ProductId): Promise<PublicProductRecord | undefined>;
  getPublicProductBySlugs(
    merchantSlug: string,
    productSlug: string,
  ): Promise<PublicProductRecord | undefined>;
  getPassMetadataProduct(productId: ProductId): Promise<
    | {
        product: Product;
        merchant: Merchant;
      }
    | undefined
  >;
  getCheckoutForActor(
    checkoutSessionId: string,
    actor?: CurrentUser,
  ): Promise<CheckoutSnapshotRecord | undefined>;
  getAttemptForActor(
    paymentAttemptId: string,
    actor: CurrentUser,
  ): Promise<PaymentAttemptRecord | undefined>;
  getPaymentWorkflowForActor(
    paymentAttemptId: string,
    actor: CurrentUser,
  ): Promise<PaymentWorkflowRecord | undefined>;
  getOrderForActor(orderId: OrderId, actor: CurrentUser): Promise<OrderSnapshotRecord | undefined>;
  getMerchantSummary(
    actor: CurrentUser,
    merchantId?: MerchantId,
  ): Promise<MerchantSummaryRecord | undefined>;
  listMerchantOrders(input: {
    actor: CurrentUser;
    merchantId?: MerchantId;
    cursor?: string;
    limit: number;
    status?: OrderRecord['status'];
    productId?: ProductId;
  }): Promise<CursorPage<MerchantOrderListItem>>;
  listCustomerOrders(input: {
    actor: CurrentUser;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<CustomerOrderListItem>>;
  listMerchantProducts(input: {
    actor: CurrentUser;
    merchantId?: MerchantId;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<Product>>;
  getMerchantProductForActor(input: { actor: CurrentUser; productId: ProductId }): Promise<
    | {
        product: Product;
        optimisticVersion: string;
        chainSyncStatus:
          | 'not_required'
          | 'pending'
          | 'submitted'
          | 'confirmed'
          | 'mismatch'
          | 'failed';
        operation?: ContractOperationRecord;
      }
    | undefined
  >;
  getSplitByCapability(
    reference: string,
    now: Date,
    actor?: CurrentUser,
  ): Promise<SplitCapabilityRecord | undefined>;
  getJudgeProof(orderId: OrderId, shareToken?: string): Promise<PublicJudgeProof | undefined>;
  getSponsorGrantForActor(id: string, actor: CurrentUser): Promise<SponsorGrantRecord | undefined>;
}

export interface WalletReadinessQueryPort {
  getReadiness(actor: CurrentUser): Promise<Readonly<Record<string, unknown>>>;
  recordDelegationEvidence(input: {
    actor: CurrentUser;
    transactionHash: string;
    evidenceDigest: string;
  }): Promise<Readonly<Record<string, unknown>>>;
}

export interface SplitAttemptCommandPort {
  prepare(input: {
    actor: CurrentUser;
    splitId: string;
    capabilityReference: string;
    idempotencyKeyHash: string;
    requestHash: string;
  }): Promise<Readonly<Record<string, unknown>>>;
}

export interface ProductUpdateCommandPort {
  update(input: {
    actor: CurrentUser;
    productId: ProductId;
    expectedVersion: string;
    patch: Readonly<Record<string, unknown>>;
    idempotencyKeyHash: string;
    requestHash: string;
  }): Promise<Product>;
}

export interface ApiMutationContext {
  readonly actor: CurrentUser;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
  readonly requestId: string;
}

export type ApiOperationResult = Readonly<Record<string, unknown>>;

export interface ContractOperationRecord {
  readonly id: string;
  readonly kind:
    | 'merchant_mutation'
    | 'product_mutation'
    | 'refund'
    | 'withdrawal'
    | 'split_reimbursement'
    | 'split_revocation';
  readonly aggregateType:
    | 'merchant'
    | 'product'
    | 'refund'
    | 'withdrawal'
    | 'split_payment'
    | 'split';
  readonly aggregateId: string;
  readonly binding: Readonly<Record<string, unknown>>;
  readonly template: BoundOperationTemplate;
  readonly bindingDigest: string;
  readonly status:
    | 'prepared'
    | 'submission_started'
    | 'submitted'
    | 'submitted_unknown'
    | 'confirming'
    | 'confirmed'
    | 'failed'
    | 'orphaned';
  readonly providerOperationId?: string;
  readonly transactionHash?: string;
  readonly canonicalEventName?: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContractOperationPreparedResult {
  readonly operation: ContractOperationRecord;
}

/** Stable response contracts consumed by the browser application boundary. */
export interface CheckoutSessionCreatedResult {
  readonly sessionId: CheckoutSessionId;
  readonly expiresAt: string;
}

export interface CheckoutSessionBoundResult {
  readonly session: CheckoutSessionRecord;
}

export interface CheckoutQuoteResult {
  readonly checkoutSessionId: CheckoutSessionId;
  readonly refreshVersion: string;
  readonly expiresAt: string;
}

export interface PaymentAttemptCreatedResult {
  readonly binding: CheckoutBinding;
}

export interface PaymentAttemptMutationResult {
  readonly attempt: PaymentAttemptRecord;
}

export interface WalletReadinessRecord {
  readonly ownerAddress: EvmAddress;
  readonly universalAccountAddress: EvmAddress;
  readonly ownerMatches: boolean;
  readonly delegation: DelegationStatus;
  readonly ready: boolean;
  readonly blockers: readonly (
    | 'owner_mismatch'
    | 'delegation_required'
    | 'delegation_target_mismatch'
    | 'balance_unavailable'
  )[];
  readonly observedAt: string;
}

export interface WalletBalanceRecord {
  readonly balance: UnifiedBalance;
}

export interface BootstrapEligibilityRecord {
  readonly eligible: boolean;
  readonly recipient: EvmAddress;
  readonly targetWei: BaseUnitAmount;
  readonly confirmedBalanceWei: BaseUnitAmount;
  readonly pendingAmountWei: BaseUnitAmount;
  readonly deficitWei: BaseUnitAmount;
  readonly reason?:
    | 'eligible'
    | 'already_prepared'
    | 'sufficient_balance'
    | 'policy_disabled'
    | 'risk_rejected';
  readonly observedAt: string;
}

export interface SponsorGrantResult {
  readonly grant: SponsorGrantRecord;
}

export interface PublicBrowserConfig {
  readonly applicationReleaseId: string;
  readonly liveAcceptanceConfigDigest?: string;
  readonly magic: { readonly publishableKey: string; readonly rpcUrl: string };
  readonly challenge: { readonly turnstileSiteKey?: string };
  readonly particle: {
    readonly projectId: string;
    readonly projectClientKey: string;
    readonly projectAppUuid: string;
    readonly expectedImplementationAddress: string;
    readonly expectedImplementationCodeHash: string;
    readonly slippageBps: number;
    readonly maxFeeUsdMicros: string;
    readonly allowedSourceChainIds: readonly string[];
    readonly allowedSourceAssets: readonly ('USDC' | 'USDT' | 'ETH')[];
    readonly allowedSourceTokens: readonly {
      readonly chainId: string;
      readonly asset: 'USDC' | 'USDT' | 'ETH';
      readonly address: string;
    }[];
    readonly sourceCallProfiles: readonly {
      readonly profileId: string;
      readonly chainId: string;
      readonly asset: 'USDC' | 'USDT' | 'ETH';
      readonly tokenAddress: string;
      readonly sourceAmount: string;
      readonly fixtureDigest: string;
      readonly calls: readonly {
        readonly uaType: string;
        readonly to: string;
        readonly data: string;
        readonly valueWei: string;
      }[];
    }[];
    readonly rpcUrl?: string;
    readonly responseProfile: {
      readonly profileId: string;
      readonly provenance: 'deterministic' | 'recorded_live';
      readonly deploymentsFixtureDigest: string;
      readonly authFixtureDigest: string;
      readonly submissionFixtureDigest: string;
      readonly statusFixtureDigest: string;
      readonly magicAuthorizationNonceOffset: 0 | 1;
      readonly delegationPlanTtlSeconds: number;
    };
  };
  readonly environment: string;
  readonly media: { readonly allowedOrigins: readonly string[] };
  readonly features: {
    readonly checkout: boolean;
    readonly bootstrapGas: boolean;
    readonly splits: boolean;
    readonly loyalty: boolean;
    readonly judgeMode: boolean;
  };
}

/**
 * Resource-specific HTTP application boundary. Implementations compose the
 * domain use cases above; route handlers never call persistence or vendors.
 */
export interface BackendApiCommandPort {
  createMerchant(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  updateMerchantProfile(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  onboardMerchant(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  createProduct(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  updateProduct(
    input: ApiMutationContext & { productId: ProductId; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  changeProductStatus(
    input: ApiMutationContext & {
      productId: ProductId;
      status: 'publishing' | 'paused' | 'archived';
    },
  ): Promise<ApiOperationResult>;
  createCheckoutLink(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  createCheckoutSession(
    input: Omit<ApiMutationContext, 'actor'> & { actor?: CurrentUser; body: ApiOperationResult },
  ): Promise<CheckoutSessionCreatedResult>;
  bindCheckoutSession(
    input: ApiMutationContext & { checkoutSessionId: string; body: ApiOperationResult },
  ): Promise<CheckoutSessionBoundResult>;
  refreshCheckoutQuote(
    input: ApiMutationContext & { checkoutSessionId: string; body: ApiOperationResult },
  ): Promise<CheckoutQuoteResult>;
  createPaymentAttempt(
    input: ApiMutationContext & { checkoutSessionId: string },
  ): Promise<PaymentAttemptCreatedResult>;
  recordPreparedPayment(
    input: ApiMutationContext & { paymentAttemptId: string; body: ApiOperationResult },
  ): Promise<PaymentAttemptMutationResult>;
  startPaymentSubmission(
    input: ApiMutationContext & { paymentAttemptId: string; body: ApiOperationResult },
  ): Promise<PaymentAttemptMutationResult>;
  registerPaymentSubmission(
    input: ApiMutationContext & { paymentAttemptId: string; body: ApiOperationResult },
  ): Promise<PaymentAttemptMutationResult>;
  recoverPaymentAttempt(
    input: ApiMutationContext & { paymentAttemptId: string; body: ApiOperationResult },
  ): Promise<PaymentWorkflowRecord>;
  recordDelegationEvidence(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<WalletReadinessRecord>;
  evaluateBootstrapEligibility(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<BootstrapEligibilityRecord>;
  requestBootstrapGrant(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<SponsorGrantResult>;
  prepareRefund(
    input: ApiMutationContext & { orderId: OrderId; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  registerRefundSubmission(
    input: ApiMutationContext & { refundId: string; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  prepareWithdrawal(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  registerWithdrawalSubmission(
    input: ApiMutationContext & { withdrawalId: string; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  updateLoyalty(
    input: ApiMutationContext & { body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  createSplit(
    input: ApiMutationContext & { orderId: OrderId; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  inviteSplitParticipants(
    input: ApiMutationContext & { splitId: string; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  revokeSplit(
    input: ApiMutationContext & { splitId: string; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  prepareSplitPayment(
    input: ApiMutationContext & { splitId: string; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  registerSplitPaymentSubmission(
    input: ApiMutationContext & { splitPaymentAttemptId: string; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  registerContractOperationSubmission(
    input: ApiMutationContext & { operationId: string; body: ApiOperationResult },
  ): Promise<ContractOperationPreparedResult>;
  materializeJudgeEvidence(
    input: ApiMutationContext & { orderId: OrderId },
  ): Promise<ApiOperationResult>;
  publishJudgeEvidence(
    input: ApiMutationContext & { orderId: OrderId; body: ApiOperationResult },
  ): Promise<ApiOperationResult>;
  revokeJudgeEvidence(
    input: ApiMutationContext & { orderId: OrderId },
  ): Promise<ApiOperationResult>;
}

export interface BackendApiResourceQueryPort {
  getPublicConfig(): Promise<PublicBrowserConfig>;
  getMerchantProfile(actor: CurrentUser): Promise<ApiOperationResult | undefined>;
  getMerchantMembership(actor: CurrentUser): Promise<ApiOperationResult>;
  getCheckoutLink(reference: string, actor?: CurrentUser): Promise<ApiOperationResult | undefined>;
  getWalletReadiness(actor: CurrentUser): Promise<WalletReadinessRecord>;
  getWalletBalance(actor: CurrentUser): Promise<WalletBalanceRecord>;
  getPaymentRecovery(
    paymentAttemptId: string,
    actor: CurrentUser,
  ): Promise<PaymentWorkflowRecord | undefined>;
  getReceipt(orderId: OrderId, actor: CurrentUser): Promise<OrderSnapshotRecord | undefined>;
  getRefund(refundId: string, actor: CurrentUser): Promise<ApiOperationResult | undefined>;
  getSettlement(actor: CurrentUser): Promise<ApiOperationResult>;
  getWithdrawal(withdrawalId: string, actor: CurrentUser): Promise<ApiOperationResult | undefined>;
  getLoyaltyStatus(actor: CurrentUser): Promise<ApiOperationResult>;
  getSplitPayment(
    splitPaymentAttemptId: string,
    actor: CurrentUser,
  ): Promise<ApiOperationResult | undefined>;
  getContractOperation(
    operationId: string,
    actor: CurrentUser,
  ): Promise<ContractOperationRecord | undefined>;
  getHealth(): Promise<ApiOperationResult>;
  getReadiness(): Promise<ApiOperationResult>;
}
