export type PresentationMode = 'deterministic' | 'live-unavailable' | 'live';
export type EvidenceProvenance = 'deterministic' | 'staging' | 'recorded_live' | 'live';

export interface MerchantIdentityView {
  id: string;
  slug: string;
  displayName: string;
  monogram: string;
  supportContact?: string | undefined;
  verified: boolean;
}

export type ProductAvailability =
  | { state: 'available'; remaining?: string | undefined }
  | { state: 'scheduled'; startsAt: string }
  | { state: 'sold_out' | 'paused' | 'ended' };

export interface ProductView {
  id: string;
  slug: string;
  merchant: MerchantIdentityView;
  title: string;
  description: string;
  category?: string | undefined;
  imagePath: string;
  imageAlt: string;
  unitPriceBaseUnits: string;
  currency: 'USDC';
  maxPerOrder: string;
  availability: ProductAvailability;
  availabilityCheckedAt: string;
  projectionStale: boolean;
  refundTerms: string;
  startsAt: string;
  location?: string | undefined;
  loyaltyPoints: string;
}

export interface BalanceSourceView {
  id: string;
  label: string;
  symbol: string;
  amount: string;
  amountUsd: string;
}

export interface QuoteView {
  productBaseUnits: string;
  estimatedFeeUsd: string;
  maximumTotalUsd: string;
  availableUsd: string;
  expiresAt: string;
  slippageLabel: string;
  sources: readonly BalanceSourceView[];
}

export type CheckoutState =
  | 'product_ready'
  | 'creating_session'
  | 'authenticating'
  | 'checking_readiness'
  | 'sponsor_required'
  | 'preparing_account'
  | 'loading_balance'
  | 'ready_to_pay'
  | 'preparing_payment'
  | 'preview_ready'
  | 'signing_root_hash'
  | 'submitting_particle'
  | 'waiting_for_particle'
  | 'waiting_for_arbitrum'
  | 'submitted_status_unknown'
  | 'confirmed'
  | 'retryable_failure'
  | 'terminal_failure'
  | 'expired';

export interface CanonicalConfirmationView {
  eventName: 'OrderPaid';
  canonical: true;
  confirmations: string;
  requiredConfirmations: string;
  transactionHash: string;
  blockNumber: string;
  observedAt: string;
}

export interface CheckoutSnapshotView {
  checkoutSessionId: string;
  orderId?: string | undefined;
  supportReference: string;
  state: CheckoutState;
  product: ProductView;
  quantity: string;
  addressMasked?: string | undefined;
  balanceUsd?: string | undefined;
  quote?: QuoteView | undefined;
  providerOperationId?: string | undefined;
  canonicalConfirmation?: CanonicalConfirmationView | undefined;
  submissionPossible: boolean;
  updatedAt: string;
}

export type OrderCanonicalStatus =
  | 'submitted'
  | 'confirming'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'investigation';

export interface ReceiptView {
  orderId: string;
  supportReference: string;
  status: OrderCanonicalStatus;
  product: ProductView;
  quantity: string;
  amountBaseUnits: string;
  confirmedAt?: string | undefined;
  holderAlias: string;
  transactionHash?: string | undefined;
  refundBaseUnits: string;
  passStatus: 'pending' | 'valid' | 'refunded' | 'investigation';
  loyalty: {
    earned: string;
    current: string;
    target: string;
    rewardLabel: string;
    rewardDetailsAvailable: boolean;
  };
}

export interface SplitInvitationView {
  id: string;
  participantLabel: string;
  amountBaseUnits: string;
  status: 'unpaid' | 'submitted_unknown' | 'confirming' | 'paid' | 'expired' | 'revoked';
  shareToken: string;
  expiresAt: string;
}

export interface SplitView {
  id: string;
  orderId: string;
  purchaserAlias: string;
  productTitle: string;
  totalBaseUnits: string;
  confirmedBaseUnits: string;
  status: 'active' | 'partially_paid' | 'complete' | 'expired' | 'revoking' | 'revoked';
  invitations: readonly SplitInvitationView[];
  expiresAt: string;
}

export interface MerchantOrderView {
  id: string;
  productTitle: string;
  customerAlias: string;
  amountBaseUnits: string;
  paidBaseUnits?: string | undefined;
  refundedBaseUnits?: string | undefined;
  refundableUntil?: string | undefined;
  status: OrderCanonicalStatus;
  createdAt: string;
  supportReference: string;
}

export interface MerchantProductView {
  id: string;
  version?: string | undefined;
  slug: string;
  title: string;
  description?: string | undefined;
  imageUrl?: string | undefined;
  priceBaseUnits: string;
  sold: string;
  inventory?: string | undefined;
  status:
    | 'draft'
    | 'publishing'
    | 'scheduled'
    | 'active'
    | 'paused'
    | 'sold_out'
    | 'ended'
    | 'archived';
  checkoutUrl: string;
  updatedAt: string;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  refundWindowSeconds?: string | undefined;
  loyaltyPoints?: string | undefined;
  maxPerOrder?: string | undefined;
}

export interface CustomerOrderView {
  id: string;
  merchantDisplayName: string;
  merchantSlug: string;
  productTitle: string;
  amountBaseUnits: string;
  status: OrderCanonicalStatus;
  createdAt: string;
  supportReference: string;
}

export interface MerchantDashboardView {
  merchant: MerchantIdentityView;
  payoutAddress?: string | undefined;
  grossBaseUnits: string;
  refundedBaseUnits: string;
  pendingBaseUnits: string;
  withdrawableBaseUnits: string;
  withdrawnBaseUnits: string;
  loyaltyMembers: string;
  freshness: { state: 'fresh' | 'stale' | 'investigation'; checkedAt: string };
  products: readonly MerchantProductView[];
  orders: readonly MerchantOrderView[];
  salesSeries: readonly { label: string; amountBaseUnits: string; orderCount: string }[];
}

export type JudgeClaimEvidence = 'evidenced' | 'not_evidenced' | 'deterministic_fixture';

export interface JudgeRouteSourceView extends BalanceSourceView {
  chainId: string;
}

export interface JudgeOrderPaidEventView {
  eventName: 'OrderPaid';
  chainId: string;
  contractAddress: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  logIndex: string;
  confirmations: string;
  canonical: boolean;
  observedAt: string;
  fields: {
    orderKey: string;
    merchantOnchainId: string;
    productOnchainId: string;
    payer: string;
    recipient: string;
    token: string;
    quantity: string;
    amountBaseUnits: string;
    platformFeeBaseUnits: string;
    intentDigest: string;
    passTokenId: string;
    refundDeadline: string;
  };
}

export interface JudgeProofView {
  evidenceId: string;
  orderId: string;
  provenance: EvidenceProvenance;
  environment: 'local' | 'preview' | 'staging' | 'demo-mainnet' | 'production';
  capturedAt: string;
  refreshedAt: string;
  versions: { application: string; particleSdk: string; magicSdk: string; contracts: string };
  account: {
    authMethod: 'Google' | 'Email one-time code';
    before: string;
    after: string;
    continuous: boolean;
    continuityEvidence: JudgeClaimEvidence;
    delegationStatus: 'verified' | 'unavailable';
    delegationTarget?: string | undefined;
    delegationTransaction?: string | undefined;
  };
  route: {
    eip7702: boolean;
    eip7702Evidence: JudgeClaimEvidence;
    routeEvidence: JudgeClaimEvidence;
    accountAddress: string;
    totalUsd?: string | undefined;
    sources?: readonly JudgeRouteSourceView[] | undefined;
    estimatedFeeUsd?: string | undefined;
    slippageBps?: string | undefined;
    quoteObservedAt?: string | undefined;
    previewDigest?: string | undefined;
    operationId?: string | undefined;
    activityUrl?: string | undefined;
  };
  settlement: {
    chainId: string;
    checkoutAddress: string;
    passAddress: string;
    tokenAddress: string;
    amountBaseUnits: string;
    receiptId: string;
    passTokenId: string;
    observedEventName:
      | 'OrderPaid'
      | 'OrderRefunded'
      | 'OrderFinalized'
      | 'MerchantWithdrawal'
      | 'SplitReimbursed';
    event?: JudgeOrderPaidEventView | undefined;
  };
  recovery: {
    persistedBeforeWait: boolean;
    persistenceEvidence: JudgeClaimEvidence;
    reloadRecovered: boolean;
    reloadEvidence: JudgeClaimEvidence;
    duplicatePrevented: boolean;
    duplicateEvidence: JudgeClaimEvidence;
    timing: {
      authenticationMs?: string | undefined;
      delegationMs?: string | undefined;
      routePreparationMs?: string | undefined;
      submissionToCanonicalMs?: string | undefined;
      recoveryVerificationMs?: string | undefined;
      totalDurationMs: string;
    };
  };
}

export interface FrontendFeatureState {
  mode: PresentationMode;
  environment: string;
  payments: boolean;
  refunds: boolean;
  withdrawals: boolean;
  splits: boolean;
  judgeMode: boolean;
}
