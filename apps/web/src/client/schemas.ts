import { z } from 'zod';

const unsigned = z.string().regex(/^(0|[1-9][0-9]*)$/);
const amount = unsigned;
const dateTime = z.string().datetime();

export const MerchantIdentityViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    displayName: z.string().min(2).max(100),
    monogram: z.string().min(1).max(4),
    supportContact: z.string().min(1).max(200),
    verified: z.boolean(),
  })
  .strict();

const ProductAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), remaining: unsigned.optional() }).strict(),
  z.object({ state: z.literal('scheduled'), startsAt: dateTime }).strict(),
  z.object({ state: z.enum(['sold_out', 'paused', 'ended']) }).strict(),
]);

export const ProductViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    slug: z.string().min(1).max(100),
    merchant: MerchantIdentityViewSchema,
    title: z.string().min(2).max(140),
    description: z.string().min(1).max(4_000),
    category: z.string().min(1).max(80),
    imagePath: z.union([z.string().startsWith('/'), z.string().url()]),
    imageAlt: z.string().min(1).max(240),
    unitPriceBaseUnits: amount,
    currency: z.literal('USDC'),
    maxPerOrder: z.string().regex(/^[1-9][0-9]*$/),
    availability: ProductAvailabilitySchema,
    availabilityCheckedAt: dateTime,
    projectionStale: z.boolean(),
    refundTerms: z.string().min(1).max(500),
    startsAt: dateTime,
    location: z.string().min(1).max(200),
    loyaltyPoints: unsigned,
  })
  .strict();

export const BalanceSourceViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(100),
    symbol: z.string().min(1).max(20),
    amount: z.string().min(1).max(100),
    amountUsd: z.string().min(1).max(100),
  })
  .strict();

export const QuoteViewSchema = z
  .object({
    productBaseUnits: amount,
    estimatedFeeUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    maximumTotalUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    availableUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    expiresAt: dateTime,
    slippageLabel: z.string().min(1).max(160),
    sources: z.array(BalanceSourceViewSchema).max(20),
  })
  .strict();

export const CanonicalConfirmationViewSchema = z
  .object({
    eventName: z.literal('OrderPaid'),
    canonical: z.literal(true),
    confirmations: unsigned,
    requiredConfirmations: unsigned,
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    blockNumber: unsigned,
    observedAt: dateTime,
  })
  .strict();

export const CheckoutSnapshotViewSchema = z
  .object({
    checkoutSessionId: z.string().min(1).max(128),
    orderId: z.string().min(1).max(128),
    supportReference: z.string().min(1).max(24),
    state: z.enum([
      'product_ready',
      'creating_session',
      'authenticating',
      'checking_readiness',
      'sponsor_required',
      'preparing_account',
      'loading_balance',
      'ready_to_pay',
      'preparing_payment',
      'preview_ready',
      'signing_root_hash',
      'submitting_particle',
      'waiting_for_particle',
      'waiting_for_arbitrum',
      'submitted_status_unknown',
      'confirmed',
      'retryable_failure',
      'terminal_failure',
      'expired',
    ]),
    product: ProductViewSchema,
    quantity: z.string().regex(/^[1-9][0-9]*$/),
    addressMasked: z.string().max(64).optional(),
    balanceUsd: z.string().max(100).optional(),
    quote: QuoteViewSchema.optional(),
    providerOperationId: z.string().max(256).optional(),
    canonicalConfirmation: CanonicalConfirmationViewSchema.optional(),
    submissionPossible: z.boolean(),
    updatedAt: dateTime,
  })
  .strict();

export const CommandReceiptSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    accepted: z.boolean(),
    resourceId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const ReceiptViewSchema = z
  .object({
    orderId: z.string().min(1).max(128),
    supportReference: z.string().min(1).max(24),
    status: z.enum([
      'submitted',
      'confirming',
      'paid',
      'partially_refunded',
      'refunded',
      'investigation',
    ]),
    product: ProductViewSchema,
    quantity: z.string().regex(/^[1-9][0-9]*$/),
    amountBaseUnits: amount,
    confirmedAt: dateTime.optional(),
    holderAlias: z.string().min(1).max(100),
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    refundBaseUnits: amount,
    passStatus: z.enum(['pending', 'valid', 'refunded', 'investigation']),
    loyalty: z
      .object({
        earned: unsigned,
        current: unsigned,
        target: z.string().regex(/^[1-9][0-9]*$/),
        rewardLabel: z.string().min(1).max(160),
      })
      .strict(),
  })
  .strict();

const SplitInvitationViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    participantLabel: z.string().min(1).max(80),
    amountBaseUnits: amount,
    status: z.enum(['unpaid', 'submitted_unknown', 'confirming', 'paid', 'expired', 'revoked']),
    shareToken: z.string().min(1).max(256),
    expiresAt: dateTime,
  })
  .strict();

export const SplitViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    orderId: z.string().min(1).max(128),
    purchaserAlias: z.string().min(1).max(80),
    productTitle: z.string().min(1).max(140),
    totalBaseUnits: amount,
    confirmedBaseUnits: amount,
    status: z.enum(['active', 'partially_paid', 'complete', 'expired', 'revoked']),
    invitations: z.array(SplitInvitationViewSchema).min(1).max(50),
    expiresAt: dateTime,
  })
  .strict();

const MerchantOrderViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    productTitle: z.string().min(1).max(140),
    customerAlias: z.string().min(1).max(80),
    amountBaseUnits: amount,
    paidBaseUnits: amount.optional(),
    refundedBaseUnits: amount.optional(),
    refundableUntil: dateTime.optional(),
    status: z.enum([
      'submitted',
      'confirming',
      'paid',
      'partially_refunded',
      'refunded',
      'investigation',
    ]),
    createdAt: dateTime,
    supportReference: z.string().min(1).max(24),
  })
  .strict();

const MerchantProductViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    slug: z.string().min(1).max(100),
    title: z.string().min(1).max(140),
    priceBaseUnits: amount,
    sold: unsigned,
    inventory: unsigned,
    status: z.enum([
      'draft',
      'publishing',
      'scheduled',
      'active',
      'paused',
      'sold_out',
      'ended',
      'archived',
    ]),
    checkoutUrl: z.string().startsWith('/'),
    updatedAt: dateTime,
  })
  .strict();

export const MerchantDashboardViewSchema = z
  .object({
    merchant: MerchantIdentityViewSchema,
    grossBaseUnits: amount,
    refundedBaseUnits: amount,
    pendingBaseUnits: amount,
    withdrawableBaseUnits: amount,
    withdrawnBaseUnits: amount,
    loyaltyMembers: unsigned,
    freshness: z
      .object({ state: z.enum(['fresh', 'stale', 'investigation']), checkedAt: dateTime })
      .strict(),
    products: z.array(MerchantProductViewSchema).max(10_000),
    orders: z.array(MerchantOrderViewSchema).max(10_000),
    salesSeries: z
      .array(
        z
          .object({
            label: z.string().min(1).max(32),
            amountBaseUnits: amount,
            orderCount: unsigned,
          })
          .strict(),
      )
      .max(366),
  })
  .strict();

export const JudgeProofViewSchema = z
  .object({
    evidenceId: z.string().min(1).max(128),
    orderId: z.string().min(1).max(128),
    provenance: z.enum(['deterministic', 'staging', 'recorded_live', 'live']),
    environment: z.enum(['local', 'preview', 'staging', 'demo-mainnet', 'production']),
    capturedAt: dateTime,
    refreshedAt: dateTime,
    versions: z
      .object({
        application: z.string().min(1).max(128),
        particleSdk: z.string().min(1).max(128),
        magicSdk: z.string().min(1).max(128),
        contracts: z.string().min(1).max(128),
      })
      .strict(),
    account: z
      .object({
        authMethod: z.enum(['Google', 'Email one-time code']),
        before: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        after: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        continuous: z.boolean(),
        continuityEvidence: z.enum(['evidenced', 'not_evidenced', 'deterministic_fixture']),
        delegationStatus: z.enum(['verified', 'unavailable']),
        delegationTarget: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .optional(),
        delegationTransaction: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .optional(),
      })
      .strict(),
    route: z
      .object({
        eip7702: z.boolean(),
        eip7702Evidence: z.enum(['evidenced', 'not_evidenced', 'deterministic_fixture']),
        routeEvidence: z.enum(['evidenced', 'not_evidenced', 'deterministic_fixture']),
        accountAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        totalUsd: z
          .string()
          .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
          .optional(),
        sources: z
          .array(
            BalanceSourceViewSchema.extend({
              chainId: z.string().regex(/^[1-9][0-9]*$/),
            }).strict(),
          )
          .max(20)
          .optional(),
        estimatedFeeUsd: z
          .string()
          .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
          .optional(),
        slippageBps: unsigned.optional(),
        quoteObservedAt: dateTime.optional(),
        previewDigest: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .optional(),
        operationId: z.string().min(1).max(256).optional(),
        activityUrl: z.string().url().optional(),
      })
      .strict(),
    settlement: z
      .object({
        chainId: z.string().regex(/^[1-9][0-9]*$/),
        checkoutAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        passAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        amountBaseUnits: amount,
        receiptId: z.string().min(1).max(128),
        passTokenId: z.string().regex(/^[1-9][0-9]*$/),
        observedEventName: z.enum([
          'OrderPaid',
          'OrderRefunded',
          'OrderFinalized',
          'MerchantWithdrawal',
          'SplitReimbursed',
        ]),
        event: z
          .object({
            eventName: z.literal('OrderPaid'),
            chainId: z.string().regex(/^[1-9][0-9]*$/),
            contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            blockNumber: unsigned,
            blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            logIndex: unsigned,
            confirmations: unsigned,
            canonical: z.boolean(),
            observedAt: dateTime,
            fields: z
              .object({
                orderKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
                merchantOnchainId: z.string().regex(/^[1-9][0-9]*$/),
                productOnchainId: z.string().regex(/^[1-9][0-9]*$/),
                payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
                recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
                token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
                quantity: z.string().regex(/^[1-9][0-9]*$/),
                amountBaseUnits: amount,
                platformFeeBaseUnits: amount,
                intentDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
                passTokenId: z.string().regex(/^[1-9][0-9]*$/),
                refundDeadline: unsigned,
              })
              .strict(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    recovery: z
      .object({
        persistedBeforeWait: z.boolean(),
        persistenceEvidence: z.enum(['evidenced', 'not_evidenced', 'deterministic_fixture']),
        reloadRecovered: z.boolean(),
        reloadEvidence: z.enum(['evidenced', 'not_evidenced', 'deterministic_fixture']),
        duplicatePrevented: z.boolean(),
        duplicateEvidence: z.enum(['evidenced', 'not_evidenced', 'deterministic_fixture']),
        timing: z
          .object({
            authenticationMs: unsigned.optional(),
            delegationMs: unsigned.optional(),
            routePreparationMs: unsigned.optional(),
            submissionToCanonicalMs: unsigned.optional(),
            recoveryVerificationMs: unsigned.optional(),
            totalDurationMs: unsigned,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
