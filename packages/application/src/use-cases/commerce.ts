import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  applyBasisPointsFloor,
  type BaseUnitAmount,
  BaseUnitAmountSchema,
  BasisPointsSchema,
  type CheckoutBinding,
  CheckoutBindingSchema,
  CheckoutSessionIdSchema,
  type CurrentUser,
  type EvidenceDigest,
  EvidenceDigestSchema,
  type Merchant,
  type MerchantId,
  MerchantIdSchema,
  MerchantSchema,
  multiplyBaseUnits,
  type OrderId,
  OrderIdSchema,
  OrderIntentSchema,
  PaymentAttemptIdSchema,
  type Product,
  type ProductId,
  ProductIdSchema,
  ProductSchema,
  ProviderOperationIdSchema,
  QuantitySchema,
  RefundIdSchema,
  SplitIdSchema,
  sameEvmAddress,
  validateSplitAllocation,
  WithdrawalIdSchema,
} from '@opentab/shared';
import type {
  ClockPort,
  IdempotencyRepositoryPort,
  MerchantRepositoryPort,
  OrderIntentSignerPort,
  ProductRepositoryPort,
  RandomPort,
  UnitOfWorkPort,
  UserRepositoryPort,
} from '../ports/index.js';
import type {
  AuthoritativeProduct,
  CheckoutSessionRecord,
  CheckoutWorkflowStorePort,
  FinancialWorkflowStorePort,
  SplitCapabilityIssuerPort,
} from './contracts.js';

function assertActiveUser(user: CurrentUser | undefined): asserts user is CurrentUser {
  if (user === undefined) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
  if (user.status !== 'active') throw new AppError('AUTH_FORBIDDEN', 'This account is not active.');
}

function assertMerchantRole(
  user: CurrentUser,
  merchantId: MerchantId,
  roles: readonly ('owner' | 'admin' | 'operator' | 'viewer')[],
): void {
  const membership = user.merchantMemberships.find((entry) => entry.merchantId === merchantId);
  if (membership === undefined || !roles.includes(membership.role)) {
    throw new AppError('AUTH_FORBIDDEN', 'You are not authorized to manage this merchant.');
  }
}

function secondsSinceEpoch(date: Date): string {
  return (BigInt(date.getTime()) / 1_000n).toString();
}

export class CreateMerchantUseCase {
  constructor(
    private readonly dependencies: {
      users: UserRepositoryPort;
      merchants: MerchantRepositoryPort;
      idempotency: IdempotencyRepositoryPort;
      unitOfWork: UnitOfWorkPort;
      random: RandomPort;
      clock: ClockPort;
    },
  ) {}

  async execute(input: {
    actorUserId: string;
    slug: string;
    displayName: string;
    supportContact?: string;
    payoutAddress: Merchant['payoutAddress'];
    idempotencyKeyHash: string;
    requestHash: string;
  }): Promise<Merchant> {
    const user = await this.dependencies.users.findCurrentUserById(input.actorUserId);
    assertActiveUser(user);
    if (!sameEvmAddress(user.walletAddress, input.payoutAddress)) {
      throw new AppError(
        'WALLET_ADDRESS_MISMATCH',
        'The payout address must match your verified wallet.',
      );
    }
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.idempotency.execute({
      scope: `merchant:create:${user.id}`,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      operation: () =>
        this.dependencies.unitOfWork.transaction(async () => {
          const merchant = MerchantSchema.parse({
            id: MerchantIdSchema.parse(this.dependencies.random.opaqueId('mer')),
            ownerUserId: user.id,
            slug: input.slug,
            displayName: input.displayName,
            ...(input.supportContact === undefined ? {} : { supportContact: input.supportContact }),
            payoutAddress: input.payoutAddress,
            status: 'draft',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          });
          await this.dependencies.merchants.save(merchant);
          return merchant;
        }),
    });
    return MerchantSchema.parse(result.value);
  }
}

export class CreateProductUseCase {
  constructor(
    private readonly dependencies: {
      users: UserRepositoryPort;
      merchants: MerchantRepositoryPort;
      products: ProductRepositoryPort;
      idempotency: IdempotencyRepositoryPort;
      unitOfWork: UnitOfWorkPort;
      random: RandomPort;
      clock: ClockPort;
    },
  ) {}

  async execute(input: {
    actorUserId: string;
    merchantId: MerchantId;
    slug: string;
    title: string;
    description: string;
    imageUrl?: string;
    unitPriceBaseUnits: BaseUnitAmount;
    maxSupply?: string;
    maxPerOrder: string;
    startsAt: string;
    endsAt?: string;
    refundWindowSeconds: string;
    loyaltyPoints: BaseUnitAmount;
    metadataHash: EvidenceDigest;
    idempotencyKeyHash: string;
    requestHash: string;
  }): Promise<Product> {
    const user = await this.dependencies.users.findCurrentUserById(input.actorUserId);
    assertActiveUser(user);
    assertMerchantRole(user, input.merchantId, ['owner', 'admin', 'operator']);
    const merchant = await this.dependencies.merchants.findById(input.merchantId);
    if (merchant === undefined || merchant.status === 'archived') {
      throw new AppError('NOT_FOUND', 'The merchant was not found.');
    }
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.idempotency.execute({
      scope: `product:create:${input.merchantId}`,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      operation: () =>
        this.dependencies.unitOfWork.transaction(async () => {
          const product = ProductSchema.parse({
            id: ProductIdSchema.parse(this.dependencies.random.opaqueId('prd')),
            merchantId: input.merchantId,
            version: '1',
            slug: input.slug,
            title: input.title,
            description: input.description,
            ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl }),
            unitPriceBaseUnits: input.unitPriceBaseUnits,
            ...(input.maxSupply === undefined ? {} : { maxSupply: input.maxSupply }),
            sold: '0',
            maxPerOrder: input.maxPerOrder,
            startsAt: input.startsAt,
            ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
            refundWindowSeconds: input.refundWindowSeconds,
            loyaltyPoints: input.loyaltyPoints,
            metadataHash: input.metadataHash,
            status: 'draft',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          });
          await this.dependencies.products.save(product);
          return product;
        }),
    });
    return ProductSchema.parse(result.value);
  }
}

export class CreateCheckoutSessionUseCase {
  constructor(
    private readonly dependencies: {
      store: CheckoutWorkflowStorePort;
      idempotency: IdempotencyRepositoryPort;
      random: RandomPort;
      clock: ClockPort;
      ttlSeconds: number;
    },
  ) {}

  async execute(input: {
    productId: ProductId;
    quantity: string;
    user?: CurrentUser;
    receiptRecipient?: CurrentUser['walletAddress'];
    idempotencyKeyHash: string;
    requestHash: string;
  }): Promise<{ sessionId: ReturnType<typeof CheckoutSessionIdSchema.parse>; expiresAt: string }> {
    const authoritative = await this.dependencies.store.findAuthoritativeProduct(input.productId);
    if (
      authoritative === undefined ||
      !authoritative.active ||
      authoritative.product.status !== 'active'
    ) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'This item is not available.');
    }
    const now = this.dependencies.clock.now();
    const startsAt = new Date(authoritative.product.startsAt);
    const endsAt =
      authoritative.product.endsAt === undefined
        ? undefined
        : new Date(authoritative.product.endsAt);
    if (startsAt > now || (endsAt !== undefined && endsAt <= now)) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'This item is not available right now.');
    }
    const quantity = QuantitySchema.parse(input.quantity);
    if (BigInt(quantity) > BigInt(authoritative.product.maxPerOrder)) {
      throw new AppError('VALIDATION_FAILED', 'The selected quantity exceeds the purchase limit.');
    }
    if (
      authoritative.product.maxSupply !== undefined &&
      BigInt(authoritative.product.sold) + BigInt(quantity) >
        BigInt(authoritative.product.maxSupply)
    ) {
      throw new AppError('PRODUCT_SOLD_OUT', 'This item is sold out.');
    }
    const amountBaseUnits = multiplyBaseUnits(authoritative.product.unitPriceBaseUnits, quantity);
    if (BigInt(amountBaseUnits) <= 0n) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'This item has an invalid price.');
    }
    const result = await this.dependencies.idempotency.execute({
      scope: `checkout-session:create:${input.user?.id ?? 'anonymous'}:${input.productId}`,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt: new Date(now.getTime() + this.dependencies.ttlSeconds * 1_000),
      operation: async () => {
        const expiresAt = new Date(now.getTime() + this.dependencies.ttlSeconds * 1_000);
        const session = await this.dependencies.store.createCheckoutSession({
          id: CheckoutSessionIdSchema.parse(this.dependencies.random.opaqueId('chk')),
          ...(input.user === undefined ? {} : { userId: input.user.id }),
          productId: authoritative.product.id,
          productVersion: authoritative.product.version,
          quantity,
          ...(input.receiptRecipient === undefined
            ? {}
            : { receiptRecipient: input.receiptRecipient }),
          amountBaseUnits,
          orderKey: this.dependencies.random.bytes32() as never,
          expiresAt,
          now,
        });
        return { sessionId: session.id, expiresAt: session.expiresAt };
      },
    });
    return result.value;
  }
}

export class CreatePaymentAttemptUseCase {
  constructor(
    private readonly dependencies: {
      store: CheckoutWorkflowStorePort;
      signer: OrderIntentSignerPort<ReturnType<typeof OrderIntentSchema.parse>>;
      idempotency: IdempotencyRepositoryPort;
      unitOfWork: UnitOfWorkPort;
      random: RandomPort;
      clock: ClockPort;
      checkoutAddress: CurrentUser['walletAddress'];
      tokenAddress: CurrentUser['walletAddress'];
      platformFeeBps: string;
      signerKeyId: string;
      attemptTtlSeconds: number;
      /**
       * Server-authoritative release/canary policy. This runs after the
       * checkout and product projections have been locked and validated, but
       * before an order intent is signed or any payment rows are created.
       */
      authorize?: (input: {
        user: CurrentUser;
        session: CheckoutSessionRecord;
        authoritative: AuthoritativeProduct;
      }) => void | Promise<void>;
    },
  ) {}

  async execute(input: {
    checkoutSessionId: string;
    user: CurrentUser;
    idempotencyKeyHash: string;
    requestHash: string;
  }): Promise<CheckoutBinding> {
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.idempotency.execute({
      scope: `payment-attempt:create:${input.user.id}:${input.checkoutSessionId}`,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt: new Date(now.getTime() + this.dependencies.attemptTtlSeconds * 1_000),
      operation: () => this.dependencies.unitOfWork.transaction(() => this.#execute(input, now)),
    });
    return CheckoutBindingSchema.parse(result.value);
  }

  async #execute(
    input: { checkoutSessionId: string; user: CurrentUser },
    now: Date,
  ): Promise<CheckoutBinding> {
    assertActiveUser(input.user);
    const sessionId = CheckoutSessionIdSchema.parse(input.checkoutSessionId);
    const session = await this.dependencies.store.findCheckoutSessionForUpdate(sessionId);
    if (session === undefined)
      throw new AppError('NOT_FOUND', 'The checkout session was not found.');
    if (
      new Date(session.expiresAt) <= now ||
      ['expired', 'cancelled', 'consumed'].includes(session.status)
    ) {
      throw new AppError('CHECKOUT_EXPIRED', 'This checkout has expired.');
    }
    if (session.userId !== undefined && session.userId !== input.user.id) {
      throw new AppError('AUTH_FORBIDDEN', 'This checkout belongs to another account.');
    }
    const authoritative = await this.dependencies.store.findAuthoritativeProduct(session.productId);
    if (authoritative === undefined || !authoritative.active) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'This item is no longer available.');
    }
    if (
      authoritative.product.version !== session.productVersion ||
      authoritative.product.unitPriceBaseUnits !==
        BaseUnitAmountSchema.parse(
          (BigInt(session.amountBaseUnits) / BigInt(session.quantity)).toString(),
        )
    ) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'The item details changed. Start a new checkout.');
    }
    await this.dependencies.authorize?.({
      user: input.user,
      session,
      authoritative,
    });
    const recipient = session.receiptRecipient ?? input.user.walletAddress;
    const attemptId = PaymentAttemptIdSchema.parse(this.dependencies.random.opaqueId('pay'));
    const orderId = OrderIdSchema.parse(this.dependencies.random.opaqueId('ord'));
    const validUntil = new Date(now.getTime() + this.dependencies.attemptTtlSeconds * 1_000);
    const refundWindowSeconds = BigInt(authoritative.product.refundWindowSeconds);
    if (refundWindowSeconds > 315_360_000n) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'The product refund window is invalid.');
    }
    const refundableUntil =
      refundWindowSeconds === 0n
        ? new Date(0)
        : new Date(validUntil.getTime() + Number(refundWindowSeconds * 1_000n));
    const intent = OrderIntentSchema.parse({
      orderKey: session.orderKey,
      payer: input.user.walletAddress,
      recipient,
      merchantOnchainId: authoritative.merchantOnchainId,
      productOnchainId: authoritative.productOnchainId,
      productVersion: authoritative.product.version,
      token: this.dependencies.tokenAddress,
      amountBaseUnits: session.amountBaseUnits,
      platformFeeBps: this.dependencies.platformFeeBps,
      platformFeeBaseUnits: applyBasisPointsFloor(
        session.amountBaseUnits,
        BasisPointsSchema.parse(this.dependencies.platformFeeBps),
      ),
      quantity: session.quantity,
      validAfter: secondsSinceEpoch(now),
      validUntil: secondsSinceEpoch(validUntil),
      refundDeadline: refundWindowSeconds === 0n ? '0' : secondsSinceEpoch(refundableUntil),
      metadataHash: authoritative.product.metadataHash,
    });
    const signed = await this.dependencies.signer.signIntent(intent);
    if (signed.signerKeyId !== this.dependencies.signerKeyId) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The order signer key did not match the configured plan.',
      );
    }
    const signedIntent = intent;
    const bindingDigest = EvidenceDigestSchema.parse(signed.digest);
    const binding = CheckoutBindingSchema.parse({
      checkoutSessionId: session.id,
      attemptId,
      orderId,
      orderIntent: signedIntent,
      orderIntentDigest: bindingDigest,
      orderIntentSignature: signed.signature,
      signerKeyId: signed.signerKeyId,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      usdcAddress: this.dependencies.tokenAddress,
      checkoutAddress: this.dependencies.checkoutAddress,
      expiresAt: validUntil.toISOString(),
      bindingDigest,
    });
    await this.dependencies.store.bindCheckoutSession({
      id: session.id,
      userId: input.user.id,
      receiptRecipient: recipient,
      bindingDigest,
      now,
    });
    await this.dependencies.store.createOrderAttempt({
      orderId,
      attemptId,
      session: { ...session, userId: input.user.id, receiptRecipient: recipient, bindingDigest },
      user: input.user,
      merchantId: authoritative.merchant.id,
      tokenAddress: this.dependencies.tokenAddress,
      intentDigest: bindingDigest,
      intentSignerAddress: signed.signerAddress,
      refundableUntil,
      binding,
      now,
    });
    return binding;
  }
}

export class RecordPreparedAttemptUseCase {
  constructor(
    private readonly dependencies: { store: CheckoutWorkflowStorePort; clock: ClockPort },
  ) {}

  execute(input: {
    attemptId: string;
    actor: CurrentUser;
    providerOperationId: string;
    rootHashDigest: string;
    previewDigest: string;
    quoteSummary: Readonly<Record<string, unknown>>;
    expiresAt: string;
  }) {
    const expiresAt = new Date(input.expiresAt);
    const now = this.dependencies.clock.now();
    if (expiresAt <= now)
      throw new AppError('UA_QUOTE_EXPIRED', 'Payment details expired.', { retryable: true });
    return this.dependencies.store.recordPreparedAttempt({
      attemptId: PaymentAttemptIdSchema.parse(input.attemptId),
      actorUserId: input.actor.id,
      actorWalletAddress: input.actor.walletAddress,
      providerOperationId: ProviderOperationIdSchema.parse(input.providerOperationId),
      rootHashDigest: EvidenceDigestSchema.parse(input.rootHashDigest),
      previewDigest: EvidenceDigestSchema.parse(input.previewDigest),
      quoteSummary: input.quoteSummary,
      expiresAt,
      now,
    });
  }
}

export class StartSubmissionUseCase {
  constructor(
    private readonly dependencies: { store: CheckoutWorkflowStorePort; clock: ClockPort },
  ) {}

  execute(input: { attemptId: string; bindingDigest: string; actor: CurrentUser }) {
    return this.dependencies.store.startSubmission({
      attemptId: PaymentAttemptIdSchema.parse(input.attemptId),
      actorUserId: input.actor.id,
      actorWalletAddress: input.actor.walletAddress,
      expectedBindingDigest: EvidenceDigestSchema.parse(input.bindingDigest),
      now: this.dependencies.clock.now(),
    });
  }
}

export class AttachSubmissionUseCase {
  constructor(
    private readonly dependencies: { store: CheckoutWorkflowStorePort; clock: ClockPort },
  ) {}

  execute(
    input:
      | {
          attemptId: string;
          actor: CurrentUser;
          status: 'submitted';
          providerOperationId: string;
        }
      | { attemptId: string; actor: CurrentUser; status: 'submitted_unknown' },
  ) {
    return this.dependencies.store.attachSubmission({
      attemptId: PaymentAttemptIdSchema.parse(input.attemptId),
      actorUserId: input.actor.id,
      actorWalletAddress: input.actor.walletAddress,
      ...(input.status === 'submitted'
        ? { providerOperationId: input.providerOperationId as never }
        : {}),
      status: input.status,
      now: this.dependencies.clock.now(),
    });
  }
}

export class CreateRefundUseCase {
  constructor(
    private readonly dependencies: {
      users: UserRepositoryPort;
      store: CheckoutWorkflowStorePort & FinancialWorkflowStorePort;
      idempotency: IdempotencyRepositoryPort;
      random: RandomPort;
      clock: ClockPort;
    },
  ) {}

  async execute(input: {
    actorUserId: string;
    orderId: OrderId;
    amountBaseUnits: BaseUnitAmount;
    idempotencyKeyHash: string;
    requestHash: string;
  }) {
    const user = await this.dependencies.users.findCurrentUserById(input.actorUserId);
    assertActiveUser(user);
    const order = await this.dependencies.store.findOrder(input.orderId);
    if (order === undefined) throw new AppError('NOT_FOUND', 'The order was not found.');
    assertMerchantRole(user, order.merchantId, ['owner']);
    if (!['paid', 'partially_refunded'].includes(order.status)) {
      throw new AppError('REFUND_NOT_ALLOWED', 'This order is not refundable.');
    }
    if (
      BigInt(input.amountBaseUnits) >
      BigInt(order.paidAmountBaseUnits) - BigInt(order.refundedAmountBaseUnits)
    ) {
      throw new AppError('REFUND_NOT_ALLOWED', 'The refund exceeds the remaining paid amount.');
    }
    if (BigInt(input.amountBaseUnits) <= 0n) {
      throw new AppError('REFUND_NOT_ALLOWED', 'The refund amount must be positive.');
    }
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.idempotency.execute({
      scope: `refund:create:${user.id}:${order.id}`,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      operation: () =>
        this.dependencies.store.createRefund({
          id: RefundIdSchema.parse(this.dependencies.random.opaqueId('rfd')),
          orderId: order.id,
          merchantId: order.merchantId,
          requestedByUserId: user.id,
          amountBaseUnits: input.amountBaseUnits,
          idempotencyKeyHash: input.idempotencyKeyHash,
          now,
        }),
    });
    return result.value;
  }
}

export class CreateWithdrawalUseCase {
  constructor(
    private readonly dependencies: {
      users: UserRepositoryPort;
      merchants: MerchantRepositoryPort;
      store: FinancialWorkflowStorePort;
      idempotency: IdempotencyRepositoryPort;
      random: RandomPort;
      clock: ClockPort;
    },
  ) {}

  async execute(input: {
    actorUserId: string;
    merchantId: MerchantId;
    amountBaseUnits: BaseUnitAmount;
    idempotencyKeyHash: string;
    requestHash: string;
  }) {
    const user = await this.dependencies.users.findCurrentUserById(input.actorUserId);
    assertActiveUser(user);
    assertMerchantRole(user, input.merchantId, ['owner']);
    const merchant = await this.dependencies.merchants.findById(input.merchantId);
    if (merchant === undefined) throw new AppError('NOT_FOUND', 'The merchant was not found.');
    if (BigInt(input.amountBaseUnits) <= 0n) {
      throw new AppError('WITHDRAWAL_NOT_ALLOWED', 'The withdrawal amount must be positive.');
    }
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.idempotency.execute({
      scope: `withdrawal:create:${user.id}:${input.merchantId}`,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      operation: () =>
        this.dependencies.store.createWithdrawal({
          id: WithdrawalIdSchema.parse(this.dependencies.random.opaqueId('wdr')),
          merchantId: input.merchantId,
          requestedByUserId: user.id,
          recipient: merchant.payoutAddress,
          amountBaseUnits: input.amountBaseUnits,
          idempotencyKeyHash: input.idempotencyKeyHash,
          now,
        }),
    });
    return result.value;
  }
}

export class CreateSplitUseCase {
  constructor(
    private readonly dependencies: {
      users: UserRepositoryPort;
      orders: CheckoutWorkflowStorePort;
      capabilities: SplitCapabilityIssuerPort;
      idempotency: IdempotencyRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  async execute(input: {
    actorUserId: string;
    orderId: OrderId;
    beneficiary: CurrentUser['walletAddress'];
    totalBaseUnits: BaseUnitAmount;
    expiresAt: string;
    participants: readonly { label: string; amountBaseUnits: BaseUnitAmount }[];
    idempotencyKeyHash: string;
    requestHash: string;
  }) {
    const user = await this.dependencies.users.findCurrentUserById(input.actorUserId);
    assertActiveUser(user);
    const order = await this.dependencies.orders.findOrder(input.orderId);
    if (order === undefined || order.userId !== user.id) {
      throw new AppError('NOT_FOUND', 'The paid order was not found.');
    }
    if (!['paid', 'partially_refunded'].includes(order.status) || order.confirmedAt === undefined) {
      throw new AppError(
        'PAYMENT_NOT_CANONICAL',
        'The order must be confirmed before creating a split.',
      );
    }
    if (
      !sameEvmAddress(order.payer, input.beneficiary) ||
      !sameEvmAddress(user.walletAddress, input.beneficiary)
    ) {
      throw new AppError(
        'WALLET_ADDRESS_MISMATCH',
        'The split beneficiary must be the original purchaser.',
      );
    }
    const expiresAt = new Date(input.expiresAt);
    const now = this.dependencies.clock.now();
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
      throw new AppError('SPLIT_EXPIRED', 'The split expiry must be in the future.');
    }
    const netPaid = BigInt(order.paidAmountBaseUnits) - BigInt(order.refundedAmountBaseUnits);
    if (BigInt(input.totalBaseUnits) <= 0n || BigInt(input.totalBaseUnits) > netPaid) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The split total exceeds the confirmed purchase amount.',
      );
    }
    if (
      input.participants.length < 1 ||
      input.participants.length > 50 ||
      !validateSplitAllocation(
        input.participants.map((participant) => participant.amountBaseUnits),
        input.totalBaseUnits,
      )
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Split participant amounts must exactly equal the split total.',
      );
    }
    const result = await this.dependencies.idempotency.execute({
      scope: `split:create:${user.id}:${order.id}`,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt,
      operation: () =>
        this.dependencies.capabilities.create({
          orderId: order.id,
          creatorUserId: user.id,
          beneficiary: input.beneficiary,
          totalBaseUnits: input.totalBaseUnits,
          expiresAt,
          participants: input.participants,
        }),
    });
    return {
      splitId: SplitIdSchema.parse(result.value.splitId),
      invitations: result.value.invitations,
    };
  }
}

export type CheckoutProductReference = ProductId;
export type CheckoutOrderReference = OrderId;
