import type {
  BaseUnitAmount,
  CheckoutBinding,
  CheckoutSessionId,
  CurrentUser,
  EvidenceDigest,
  EvmAddress,
  Merchant,
  MerchantId,
  OrderId,
  OrderKey,
  PaymentAttemptId,
  PaymentAttemptStatus,
  Product,
  ProductId,
  ProviderOperationId,
  Quantity,
  RefundId,
  SplitId,
  TransactionHash,
  UserId,
  WithdrawalId,
} from '@opentab/shared';

/**
 * Application-shaped persistence records. They intentionally contain no ORM,
 * Redis, HTTP, or provider objects so adapters remain replaceable.
 */
export interface CheckoutSessionRecord {
  readonly id: CheckoutSessionId;
  readonly userId?: UserId;
  readonly productId: ProductId;
  readonly productVersion: string;
  readonly quantity: Quantity;
  readonly receiptRecipient?: EvmAddress;
  readonly amountBaseUnits: BaseUnitAmount;
  readonly orderKey: OrderKey;
  readonly status: 'active' | 'bound' | 'consumed' | 'expired' | 'cancelled';
  readonly expiresAt: string;
  readonly bindingDigest?: EvidenceDigest;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderRecord {
  readonly id: OrderId;
  readonly checkoutSessionId: CheckoutSessionId;
  readonly orderKey: OrderKey;
  readonly userId: UserId;
  readonly merchantId: MerchantId;
  readonly productId: ProductId;
  readonly payer: EvmAddress;
  readonly recipient: EvmAddress;
  readonly quantity: Quantity;
  readonly amountBaseUnits: BaseUnitAmount;
  readonly paidAmountBaseUnits: BaseUnitAmount;
  readonly refundedAmountBaseUnits: BaseUnitAmount;
  readonly status:
    | 'created'
    | 'submitted'
    | 'executing'
    | 'paid'
    | 'partially_refunded'
    | 'refunded'
    | 'failed_confirmed'
    | 'mismatch'
    | 'orphaned';
  readonly providerOperationId?: ProviderOperationId;
  readonly transactionHash?: TransactionHash;
  readonly confirmedAt?: string;
  readonly refundableUntil: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaymentAttemptRecord {
  readonly id: PaymentAttemptId;
  readonly orderId: OrderId;
  readonly checkoutSessionId: CheckoutSessionId;
  readonly attemptNumber: string;
  readonly status: PaymentAttemptStatus;
  readonly bindingDigest: EvidenceDigest;
  readonly providerOperationId?: ProviderOperationId;
  readonly destinationTransactionHash?: TransactionHash;
  readonly preparedExpiresAt?: string;
  readonly reconciliationRequired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthoritativeProduct {
  readonly product: Product;
  readonly merchant: Merchant;
  readonly merchantOnchainId: string;
  readonly productOnchainId: string;
  readonly active: boolean;
  readonly observedAt: string;
}

export interface CheckoutWorkflowStorePort {
  findAuthoritativeProduct(productId: ProductId): Promise<AuthoritativeProduct | undefined>;
  createCheckoutSession(input: {
    id: CheckoutSessionId;
    userId?: UserId;
    productId: ProductId;
    productVersion: string;
    quantity: Quantity;
    receiptRecipient?: EvmAddress;
    amountBaseUnits: BaseUnitAmount;
    orderKey: OrderKey;
    capabilityHash?: string;
    expiresAt: Date;
    now: Date;
  }): Promise<CheckoutSessionRecord>;
  findCheckoutSessionForUpdate(id: CheckoutSessionId): Promise<CheckoutSessionRecord | undefined>;
  bindCheckoutSession(input: {
    id: CheckoutSessionId;
    userId: UserId;
    receiptRecipient: EvmAddress;
    bindingDigest: EvidenceDigest;
    now: Date;
  }): Promise<CheckoutSessionRecord>;
  createOrderAttempt(input: {
    orderId: OrderId;
    attemptId: PaymentAttemptId;
    session: CheckoutSessionRecord;
    user: CurrentUser;
    merchantId: MerchantId;
    tokenAddress: EvmAddress;
    intentDigest: EvidenceDigest;
    intentSignerAddress: EvmAddress;
    refundableUntil: Date;
    binding: CheckoutBinding;
    now: Date;
  }): Promise<{ order: OrderRecord; attempt: PaymentAttemptRecord }>;
  recordPreparedAttempt(input: {
    attemptId: PaymentAttemptId;
    actorUserId: UserId;
    actorWalletAddress: EvmAddress;
    providerOperationId: ProviderOperationId;
    rootHashDigest: EvidenceDigest;
    previewDigest: EvidenceDigest;
    quoteSummary: Readonly<Record<string, unknown>>;
    expiresAt: Date;
    now: Date;
  }): Promise<PaymentAttemptRecord>;
  startSubmission(input: {
    attemptId: PaymentAttemptId;
    actorUserId: UserId;
    actorWalletAddress: EvmAddress;
    expectedBindingDigest: EvidenceDigest;
    now: Date;
  }): Promise<PaymentAttemptRecord>;
  attachSubmission(input: {
    attemptId: PaymentAttemptId;
    actorUserId: UserId;
    actorWalletAddress: EvmAddress;
    providerOperationId?: ProviderOperationId;
    status: 'submitted' | 'submitted_unknown';
    now: Date;
  }): Promise<PaymentAttemptRecord>;
  findOrder(id: OrderId): Promise<OrderRecord | undefined>;
  findAttempt(id: PaymentAttemptId): Promise<PaymentAttemptRecord | undefined>;
}

export interface FinancialWorkflowStorePort {
  createRefund(input: {
    id: RefundId;
    orderId: OrderId;
    merchantId: MerchantId;
    requestedByUserId: UserId;
    amountBaseUnits: BaseUnitAmount;
    idempotencyKeyHash: string;
    now: Date;
  }): Promise<{ id: RefundId; status: 'created'; amountBaseUnits: BaseUnitAmount }>;
  createWithdrawal(input: {
    id: WithdrawalId;
    merchantId: MerchantId;
    requestedByUserId: UserId;
    recipient: EvmAddress;
    amountBaseUnits: BaseUnitAmount;
    idempotencyKeyHash: string;
    now: Date;
  }): Promise<{ id: WithdrawalId; status: 'created'; amountBaseUnits: BaseUnitAmount }>;
}

export interface SplitCapabilityIssuerPort {
  create(input: {
    orderId: OrderId;
    creatorUserId: UserId;
    beneficiary: EvmAddress;
    totalBaseUnits: BaseUnitAmount;
    expiresAt: Date;
    participants: readonly { label: string; amountBaseUnits: BaseUnitAmount }[];
  }): Promise<{
    splitId: SplitId;
    invitations: readonly {
      invitationId: string;
      participantLabel: string;
      amountBaseUnits: string;
      capabilityToken: string;
      expiresAt: string;
    }[];
  }>;
}
