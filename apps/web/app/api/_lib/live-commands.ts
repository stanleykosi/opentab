import type {
  ArbitrumReadPort,
  AttachSubmissionUseCase,
  BackendApiCommandPort,
  BackendApiQueryPort,
  CheckoutWorkflowStorePort,
  CreateCheckoutSessionUseCase,
  CreateMerchantUseCase,
  CreatePaymentAttemptUseCase,
  CreateProductUseCase,
  CreateRefundUseCase,
  CreateSplitUseCase,
  CreateWithdrawalUseCase,
  DistributedLockPort,
  HumanChallengeVerifierPort,
  IdempotencyRepositoryPort,
  OrderIntentSignerPort,
  RecordPreparedAttemptUseCase,
  RequestBootstrapGrantUseCase,
  SponsorGrantStorePort,
  StartSubmissionUseCase,
} from '@opentab/application';
import type { PostgresBackendApiStore, PostgresJudgeEvidenceManager } from '@opentab/db';
import {
  type AwsKmsSplitRevocationSender,
  createMerchantProductOperationTemplate,
  createRefundOperationTemplate,
  createSplitReimbursementOperationTemplate,
  createSplitRevocationOperation,
  createWithdrawalOperationTemplate,
  digestUnknown,
  MerchantProductOperationBindingSchema,
  RefundOperationBindingSchema,
  SplitReimbursementOperationBindingSchema,
  SplitRevocationOperationBindingSchema,
  WithdrawalOperationBindingSchema,
} from '@opentab/integrations/server';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  BoundOperationTemplateSchema,
  CheckoutSessionIdSchema,
  type CurrentUser,
  DelegationStatusSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  isAppError,
  MerchantSchema,
  PaymentAttemptIdSchema,
  type SplitReimbursementIntent,
  SplitReimbursementIntentSchema,
  sameEvmAddress,
  TransactionHashSchema,
  UnsignedIntegerStringSchema,
} from '@opentab/shared';
import {
  canonicalMetadataDigest,
  canonicalProductPassMetadata,
  productMetadataDigest,
} from './product-metadata.js';
import {
  BindCheckoutBodySchema,
  CheckoutLinkBodySchema,
  CheckoutSessionBodySchema,
  ContractOperationSubmissionBodySchema,
  DelegationEvidenceBodySchema,
  FinancialSubmissionBodySchema,
  JudgeEvidencePublishBodySchema,
  LoyaltyBodySchema,
  MerchantBodySchema,
  MerchantPatchBodySchema,
  PreparedPaymentBodySchema,
  ProductBodySchema,
  ProductPatchBodySchema,
  RecoveryBodySchema,
  RefundBodySchema,
  RegisterSubmissionBodySchema,
  SplitBodySchema,
  SplitInvitationBodySchema,
  SplitPrepareBodySchema,
  SplitRevokeBodySchema,
  SplitSubmissionBodySchema,
  SponsorEligibilityCommandBodySchema,
  SponsorGrantCommandBodySchema,
  StartSubmissionBodySchema,
  WithdrawalBodySchema,
} from './schemas.js';

type Context = Parameters<BackendApiCommandPort['createMerchant']>[0];

interface SubmissionRegistrationState {
  readonly status: string;
  readonly providerOperationId?: string;
  readonly transactionHash?: string;
}

function submissionRegistrationState(
  value: unknown,
  resourceLabel: string,
): SubmissionRegistrationState {
  if (value === undefined) {
    throw new AppError('NOT_FOUND', `${resourceLabel} was not found.`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new AppError('INTERNAL_ERROR', `${resourceLabel} state is invalid.`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const status = record.status;
  const providerOperationId = record.providerOperationId;
  const transactionHash = record.transactionHash;
  if (
    typeof status !== 'string' ||
    (providerOperationId !== undefined && typeof providerOperationId !== 'string') ||
    (transactionHash !== undefined && typeof transactionHash !== 'string')
  ) {
    throw new AppError('INTERNAL_ERROR', `${resourceLabel} state is invalid.`);
  }
  return {
    status,
    ...(providerOperationId === undefined ? {} : { providerOperationId }),
    ...(transactionHash === undefined ? {} : { transactionHash }),
  };
}

function assertExistingSubmissionRegistration(input: {
  readonly current: unknown;
  readonly resourceLabel: string;
  readonly requestedStatus: 'submitted' | 'submitted_unknown';
  readonly submittedStatus?: 'submitted' | 'confirming';
  readonly requestedProviderOperationId?: string;
  readonly requestedTransactionHash?: string;
  readonly allowedTransitionStatuses?: readonly string[];
}): { readonly idempotent: boolean } {
  const current = submissionRegistrationState(input.current, input.resourceLabel);
  if (
    input.requestedTransactionHash !== undefined &&
    current.transactionHash !== undefined &&
    current.transactionHash.toLowerCase() !== input.requestedTransactionHash.toLowerCase()
  ) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      `A different transaction is already attached to ${input.resourceLabel}.`,
    );
  }
  const settledStatus =
    input.requestedStatus === 'submitted'
      ? (input.submittedStatus ?? 'submitted')
      : 'submitted_unknown';
  if (current.status === settledStatus) {
    if (
      input.requestedProviderOperationId !== undefined &&
      current.providerOperationId !== input.requestedProviderOperationId
    ) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        `A different provider operation is already attached to ${input.resourceLabel}.`,
      );
    }
    if (current.providerOperationId === undefined) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        `${input.resourceLabel} has no persisted provider operation.`,
      );
    }
    return { idempotent: true };
  }
  const allowedTransitionStatuses = input.allowedTransitionStatuses ?? ['submission_started'];
  if (!allowedTransitionStatuses.includes(current.status)) {
    throw new AppError(
      'PAYMENT_ALREADY_SUBMITTED',
      `${input.resourceLabel} was not at the authorized submission boundary.`,
      { submissionPossible: current.status !== 'prepared' && current.status !== 'created' },
    );
  }
  if (current.providerOperationId === undefined) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      `${input.resourceLabel} has no persisted provider operation.`,
    );
  }
  if (
    input.requestedProviderOperationId !== undefined &&
    current.providerOperationId !== input.requestedProviderOperationId
  ) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      `The provider operation does not match ${input.resourceLabel}.`,
    );
  }
  return { idempotent: false };
}

/**
 * Concrete HTTP-to-use-case composition. It deliberately contains no vendor
 * SDK calls; browser-owned Particle preparation is persisted through the
 * typed preparation/submission boundaries below.
 */
export class LiveBackendApiCommands implements BackendApiCommandPort {
  constructor(
    private readonly dependencies: {
      readonly createMerchant: CreateMerchantUseCase;
      readonly createProduct: CreateProductUseCase;
      readonly createCheckoutSession: CreateCheckoutSessionUseCase;
      readonly createPaymentAttempt: CreatePaymentAttemptUseCase;
      readonly authorizePaymentSubmission?: (input: {
        readonly actor: CurrentUser;
        readonly workflow: NonNullable<
          Awaited<ReturnType<BackendApiQueryPort['getPaymentWorkflowForActor']>>
        >;
      }) => void | Promise<void>;
      readonly recordPreparedAttempt: RecordPreparedAttemptUseCase;
      readonly startSubmission: StartSubmissionUseCase;
      readonly attachSubmission: AttachSubmissionUseCase;
      readonly createRefund: CreateRefundUseCase;
      readonly createWithdrawal: CreateWithdrawalUseCase;
      readonly createSplit: CreateSplitUseCase;
      readonly workflow: CheckoutWorkflowStorePort;
      readonly queries: BackendApiQueryPort;
      readonly idempotency: IdempotencyRepositoryPort;
      readonly backend: PostgresBackendApiStore;
      readonly judgeEvidence?: PostgresJudgeEvidenceManager;
      readonly chain: ArbitrumReadPort;
      readonly expectedDelegationImplementation?: ReturnType<typeof EvmAddressSchema.parse>;
      readonly expectedDelegationCodeHash?: `0x${string}`;
      readonly checkoutAddress: ReturnType<typeof EvmAddressSchema.parse>;
      readonly splitAddress: ReturnType<typeof EvmAddressSchema.parse>;
      readonly tokenAddress: ReturnType<typeof EvmAddressSchema.parse>;
      readonly appOrigin: string;
      readonly allowedMediaOrigins: ReadonlySet<string>;
      readonly operationTtlSeconds: number;
      readonly checkoutPreviewPolicy: {
        readonly providerMode: 'deterministic' | 'live';
        readonly particleLiveEnabled: boolean;
        readonly submissionEnabled: boolean;
        readonly maxSlippageBps: number;
        readonly maxFeeUsdMicros: string;
        readonly allowedSourceChainIds: readonly string[];
        readonly allowedSourceAssets: readonly ('USDC' | 'USDT' | 'ETH')[];
      };
      readonly submissionPolicy: {
        readonly merchantMutations: boolean;
        readonly refunds: boolean;
        readonly withdrawals: boolean;
        readonly splits: boolean;
      };
      readonly splitSigner?: OrderIntentSignerPort<SplitReimbursementIntent>;
      readonly splitSignerKeyId?: string;
      readonly splitSignerAddress?: ReturnType<typeof EvmAddressSchema.parse>;
      readonly splitRevocationSender?: Pick<AwsKmsSplitRevocationSender, 'submit'>;
      readonly managedSignerLocks?: DistributedLockPort;
      readonly environment:
        | 'local'
        | 'test'
        | 'preview'
        | 'staging'
        | 'demo-mainnet'
        | 'production';
      readonly evidenceProvenance: 'deterministic' | 'recorded_live' | 'live' | 'staging';
      readonly challengeVerifier?: HumanChallengeVerifierPort;
      readonly sponsorGrants?: SponsorGrantStorePort;
      readonly requestBootstrapGrant?: RequestBootstrapGrantUseCase;
      readonly sponsorPolicy?: {
        readonly targetWei: bigint;
        readonly minimumGrantWei: bigint;
        readonly allowedRecipients?: ReadonlySet<string>;
      };
      readonly now: () => Date;
    },
  ) {}

  #operationExpiry(): string {
    return new Date(
      this.dependencies.now().getTime() + this.dependencies.operationTtlSeconds * 1_000,
    ).toISOString();
  }

  #assertOperationSubmissionEnabled(
    operation: Awaited<ReturnType<PostgresBackendApiStore['getContractOperation']>>,
  ): void {
    if (operation === undefined) {
      throw new AppError('NOT_FOUND', 'The contract operation was not found.');
    }
    const policy = this.dependencies.submissionPolicy;
    const enabled =
      operation.kind === 'merchant_mutation' || operation.kind === 'product_mutation'
        ? policy.merchantMutations
        : operation.kind === 'refund'
          ? policy.refunds
          : operation.kind === 'withdrawal'
            ? policy.withdrawals
            : policy.splits;
    if (!enabled) {
      throw new AppError(
        'FEATURE_DISABLED',
        'New submission authorization for this operation is disabled.',
      );
    }
  }

  #productImageUrl(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      !this.dependencies.allowedMediaOrigins.has(url.origin)
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The product image must use an approved secure media origin.',
      );
    }
    return url.href;
  }

  #productOperationBinding(input: {
    actor: Context['actor'];
    product: Awaited<ReturnType<PostgresBackendApiStore['getProductForActor']>>;
    merchantOnchainId: string;
    productOnchainId?: string;
    action: 'create_product' | 'update_product';
  }) {
    const product = input.product;
    const configuration = {
      unitPriceBaseUnits: product.unitPriceBaseUnits,
      startsAt: (BigInt(new Date(product.startsAt).getTime()) / 1_000n).toString(),
      endsAt:
        product.endsAt === undefined
          ? '0'
          : (BigInt(new Date(product.endsAt).getTime()) / 1_000n).toString(),
      maxSupply: product.maxSupply ?? '0',
      maxPerWallet: product.maxPerOrder,
      loyaltyPoints: product.loyaltyPoints,
      refundWindowSeconds: product.refundWindowSeconds,
      metadataHash: product.metadataHash,
      passUri: new URL(
        `/api/v1/metadata/products/${encodeURIComponent(product.id)}`,
        this.dependencies.appOrigin,
      ).href,
    };
    return MerchantProductOperationBindingSchema.parse(
      input.action === 'create_product'
        ? {
            ownerAddress: input.actor.walletAddress,
            chainId: ARBITRUM_ONE_CHAIN_ID,
            checkoutAddress: this.dependencies.checkoutAddress,
            expiresAt: this.#operationExpiry(),
            mutation: {
              action: 'create_product' as const,
              merchantOnchainId: input.merchantOnchainId,
              product: configuration,
            },
          }
        : {
            ownerAddress: input.actor.walletAddress,
            chainId: ARBITRUM_ONE_CHAIN_ID,
            checkoutAddress: this.dependencies.checkoutAddress,
            expiresAt: this.#operationExpiry(),
            mutation: {
              action: 'update_product' as const,
              merchantOnchainId: input.merchantOnchainId,
              productOnchainId: input.productOnchainId ?? '0',
              product: configuration,
            },
          },
    );
  }

  async #idempotent<T>(
    input: Pick<Context, 'idempotencyKeyHash' | 'requestHash'>,
    scope: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = await this.dependencies.idempotency.execute({
      scope,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      expiresAt: new Date(this.dependencies.now().getTime() + 24 * 60 * 60 * 1_000),
      operation,
    });
    return result.value;
  }

  async createMerchant(input: Parameters<BackendApiCommandPort['createMerchant']>[0]) {
    const body = MerchantBodySchema.parse(input.body);
    return this.#idempotent(input, `merchant:profile:create:${input.actor.id}`, async () => {
      const existingProfile = await this.dependencies.backend.getMerchantProfile(input.actor);
      const merchant =
        existingProfile === undefined
          ? await this.dependencies.createMerchant.execute({
              actorUserId: input.actor.id,
              slug: body.slug,
              displayName: body.displayName,
              payoutAddress: body.payoutAddress,
              ...(body.supportContact === undefined ? {} : { supportContact: body.supportContact }),
              idempotencyKeyHash: input.idempotencyKeyHash,
              requestHash: input.requestHash,
            })
          : MerchantSchema.parse(existingProfile.merchant);
      if (
        existingProfile !== undefined &&
        (merchant.slug !== body.slug ||
          merchant.displayName !== body.displayName ||
          (merchant.supportContact ?? '') !== (body.supportContact ?? '') ||
          !sameEvmAddress(merchant.payoutAddress, body.payoutAddress))
      ) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The existing merchant profile does not match this activation request.',
        );
      }
      if (existingProfile !== undefined && !['draft', 'pending'].includes(merchant.status)) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The existing merchant no longer requires a registration operation.',
        );
      }
      const binding = MerchantProductOperationBindingSchema.parse({
        ownerAddress: input.actor.walletAddress,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        checkoutAddress: this.dependencies.checkoutAddress,
        expiresAt: this.#operationExpiry(),
        mutation: {
          action: 'create_merchant' as const,
          payoutAddress: merchant.payoutAddress,
          metadataHash: canonicalMetadataDigest({
            schema: 'opentab-merchant-profile-v1',
            slug: merchant.slug,
            displayName: merchant.displayName,
            supportContact: merchant.supportContact ?? '',
          }),
        },
      });
      const operation = await this.dependencies.backend.prepareContractOperation({
        actor: input.actor,
        requestId: input.requestId,
        kind: 'merchant_mutation',
        aggregateType: 'merchant',
        aggregateId: merchant.id,
        binding,
        template: createMerchantProductOperationTemplate(binding),
      });
      return { merchant, operation };
    });
  }

  updateMerchantProfile(input: Parameters<BackendApiCommandPort['updateMerchantProfile']>[0]) {
    const body = MerchantPatchBodySchema.parse(input.body);
    const patch = {
      ...(body.slug === undefined ? {} : { slug: body.slug }),
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.supportContact === undefined ? {} : { supportContact: body.supportContact }),
    };
    return this.#idempotent(input, `merchant:update:${input.actor.id}`, async () => {
      const chainContext =
        body.payoutAddress === undefined
          ? undefined
          : await this.dependencies.backend.getMerchantChainContext(input.actor);
      if (
        body.payoutAddress !== undefined &&
        chainContext !== undefined &&
        sameEvmAddress(body.payoutAddress, chainContext.payoutAddress)
      ) {
        throw new AppError('VALIDATION_FAILED', 'The payout destination is already current.');
      }
      if (body.payoutAddress !== undefined && chainContext?.merchantOnchainId === undefined) {
        throw new AppError(
          'OPERATION_PLAN_INVALID',
          'The merchant must be canonically registered before changing payout.',
        );
      }
      const result = await this.dependencies.backend.updateMerchantProfile({
        actor: input.actor,
        expectedVersion: body.expectedVersion,
        patch,
      });
      if (body.payoutAddress === undefined || chainContext?.merchantOnchainId === undefined) {
        return result;
      }
      const binding = MerchantProductOperationBindingSchema.parse({
        ownerAddress: input.actor.walletAddress,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        checkoutAddress: this.dependencies.checkoutAddress,
        expiresAt: this.#operationExpiry(),
        mutation: {
          action: 'update_merchant_payout' as const,
          merchantOnchainId: chainContext.merchantOnchainId,
          payoutAddress: body.payoutAddress,
        },
      });
      const operation = await this.dependencies.backend.prepareContractOperation({
        actor: input.actor,
        requestId: input.requestId,
        kind: 'merchant_mutation',
        aggregateType: 'merchant',
        aggregateId: result.merchant.id,
        binding,
        template: createMerchantProductOperationTemplate(binding),
      });
      return { ...result, operation };
    });
  }

  onboardMerchant(input: Parameters<BackendApiCommandPort['onboardMerchant']>[0]) {
    return this.#idempotent(input, `merchant:onboard:${input.actor.id}`, () =>
      this.dependencies.backend.onboardMerchant(input.actor),
    );
  }

  async createProduct(input: Parameters<BackendApiCommandPort['createProduct']>[0]) {
    const body = ProductBodySchema.parse(input.body);
    const imageUrl = this.#productImageUrl(body.imageUrl);
    const merchantContext = await this.dependencies.backend.getMerchantChainContext(
      input.actor,
      body.merchantId,
    );
    if (merchantContext.merchantOnchainId === undefined) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The merchant must be canonically registered before creating a product.',
      );
    }
    const metadataHash = productMetadataDigest(
      canonicalProductPassMetadata({
        title: body.title,
        description: body.description,
        ...(imageUrl === undefined ? {} : { imageUrl }),
        unitPriceBaseUnits: body.unitPriceBaseUnits,
        ...(body.maxSupply === undefined ? {} : { maxSupply: body.maxSupply }),
        maxPerOrder: body.maxPerOrder,
        startsAt: body.startsAt,
        ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt }),
        refundWindowSeconds: body.refundWindowSeconds,
        loyaltyPoints: body.loyaltyPoints,
      }),
    );
    const product = await this.dependencies.createProduct.execute({
      actorUserId: input.actor.id,
      merchantId: body.merchantId,
      slug: body.slug,
      title: body.title,
      description: body.description,
      ...(imageUrl === undefined ? {} : { imageUrl }),
      unitPriceBaseUnits: body.unitPriceBaseUnits,
      ...(body.maxSupply === undefined ? {} : { maxSupply: body.maxSupply }),
      maxPerOrder: body.maxPerOrder,
      startsAt: body.startsAt,
      ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt }),
      refundWindowSeconds: body.refundWindowSeconds,
      loyaltyPoints: body.loyaltyPoints,
      metadataHash,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
    });
    const binding = this.#productOperationBinding({
      actor: input.actor,
      product,
      merchantOnchainId: merchantContext.merchantOnchainId,
      action: 'create_product',
    });
    const operation = await this.dependencies.backend.prepareContractOperation({
      actor: input.actor,
      requestId: input.requestId,
      kind: 'product_mutation',
      aggregateType: 'product',
      aggregateId: product.id,
      binding,
      template: createMerchantProductOperationTemplate(binding),
    });
    return { product, optimisticVersion: product.version, operation };
  }

  async updateProduct(input: Parameters<BackendApiCommandPort['updateProduct']>[0]) {
    const body = ProductPatchBodySchema.parse(input.body);
    const current = await this.dependencies.backend.getProductForActor(
      input.actor,
      input.productId,
    );
    const context = await this.dependencies.backend.getProductChainContext(
      input.actor,
      input.productId,
    );
    if (
      context.merchant.merchantOnchainId === undefined ||
      context.product.onchainProductId === undefined
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The product must have a canonical contract mapping before it can be updated.',
      );
    }
    const { expectedVersion, ...bodyPatch } = body;
    const imageUrl = this.#productImageUrl(body.imageUrl);
    const resolvedImageUrl = imageUrl ?? current.imageUrl;
    const resolvedMaxSupply = body.maxSupply ?? current.maxSupply;
    const resolvedEndsAt = body.endsAt ?? current.endsAt;
    const patch = {
      ...bodyPatch,
      ...(imageUrl === undefined ? {} : { imageUrl }),
      metadataHash: productMetadataDigest(
        canonicalProductPassMetadata({
          title: body.title ?? current.title,
          description: body.description ?? current.description,
          ...(resolvedImageUrl === undefined ? {} : { imageUrl: resolvedImageUrl }),
          unitPriceBaseUnits: body.unitPriceBaseUnits ?? current.unitPriceBaseUnits,
          ...(resolvedMaxSupply === undefined ? {} : { maxSupply: resolvedMaxSupply }),
          maxPerOrder: body.maxPerOrder ?? current.maxPerOrder,
          startsAt: body.startsAt ?? current.startsAt,
          ...(resolvedEndsAt === undefined ? {} : { endsAt: resolvedEndsAt }),
          refundWindowSeconds: body.refundWindowSeconds ?? current.refundWindowSeconds,
          loyaltyPoints: body.loyaltyPoints ?? current.loyaltyPoints,
        }),
      ),
    };
    const result = await this.#idempotent(input, `product:update:${input.productId}`, () =>
      this.dependencies.backend.updateProduct({
        actor: input.actor,
        productId: input.productId,
        expectedVersion,
        patch,
      }),
    );
    const binding = this.#productOperationBinding({
      actor: input.actor,
      product: result.product,
      merchantOnchainId: context.merchant.merchantOnchainId,
      productOnchainId: context.product.onchainProductId,
      action: 'update_product',
    });
    const operation = await this.dependencies.backend.prepareContractOperation({
      actor: input.actor,
      requestId: input.requestId,
      kind: 'product_mutation',
      aggregateType: 'product',
      aggregateId: input.productId,
      binding,
      template: createMerchantProductOperationTemplate(binding),
    });
    return { ...result, optimisticVersion: result.product.version, operation };
  }

  async changeProductStatus(input: Parameters<BackendApiCommandPort['changeProductStatus']>[0]) {
    const context = await this.dependencies.backend.getProductChainContext(
      input.actor,
      input.productId,
    );
    if (
      context.merchant.merchantOnchainId === undefined ||
      context.product.onchainProductId === undefined
    ) {
      throw new AppError('OPERATION_PLAN_INVALID', 'The canonical product mapping is unavailable.');
    }
    const changed = await this.#idempotent(
      input,
      `product:status:${input.productId}:${input.status}`,
      () =>
        this.dependencies.backend.changeProductStatus({
          actor: input.actor,
          productId: input.productId,
          status: input.status,
        }),
    );
    const binding = MerchantProductOperationBindingSchema.parse({
      ownerAddress: input.actor.walletAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      checkoutAddress: this.dependencies.checkoutAddress,
      expiresAt: this.#operationExpiry(),
      mutation: {
        action: 'set_product_active' as const,
        merchantOnchainId: context.merchant.merchantOnchainId,
        productOnchainId: context.product.onchainProductId,
        active: input.status === 'publishing',
      },
    });
    const operation = await this.dependencies.backend.prepareContractOperation({
      actor: input.actor,
      requestId: input.requestId,
      kind: 'product_mutation',
      aggregateType: 'product',
      aggregateId: input.productId,
      binding,
      template: createMerchantProductOperationTemplate(binding),
    });
    return { ...changed, operation };
  }

  createCheckoutLink(input: Parameters<BackendApiCommandPort['createCheckoutLink']>[0]) {
    const body = CheckoutLinkBodySchema.parse(input.body);
    return this.#idempotent(input, `checkout-link:create:${body.productId}`, () =>
      this.dependencies.backend.createCheckoutLink({
        actor: input.actor,
        productId: body.productId,
        ...(body.campaign === undefined ? {} : { campaign: body.campaign }),
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      }),
    );
  }

  createCheckoutSession(input: Parameters<BackendApiCommandPort['createCheckoutSession']>[0]) {
    const body = CheckoutSessionBodySchema.parse(input.body);
    return this.dependencies.createCheckoutSession.execute({
      productId: body.productId,
      quantity: body.quantity,
      ...(input.actor === undefined ? {} : { user: input.actor }),
      ...(body.receiptRecipient === undefined ? {} : { receiptRecipient: body.receiptRecipient }),
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
    });
  }

  async bindCheckoutSession(input: Parameters<BackendApiCommandPort['bindCheckoutSession']>[0]) {
    const body = BindCheckoutBodySchema.parse(input.body);
    const checkoutSessionId = CheckoutSessionIdSchema.parse(input.checkoutSessionId);
    return this.#idempotent(
      input,
      `checkout-session:bind:${input.actor.id}:${checkoutSessionId}`,
      async () => {
        const current =
          await this.dependencies.workflow.findCheckoutSessionForUpdate(checkoutSessionId);
        if (current === undefined)
          throw new AppError('NOT_FOUND', 'The checkout session was not found.');
        const session = await this.dependencies.workflow.bindCheckoutSession({
          id: checkoutSessionId,
          userId: input.actor.id,
          receiptRecipient: body.receiptRecipient ?? input.actor.walletAddress,
          bindingDigest: EvidenceDigestSchema.parse(`0x${input.requestHash}`),
          now: this.dependencies.now(),
        });
        return { session };
      },
    );
  }

  async refreshCheckoutQuote(input: Parameters<BackendApiCommandPort['refreshCheckoutQuote']>[0]) {
    const id = CheckoutSessionIdSchema.parse(input.checkoutSessionId);
    const session = await this.dependencies.workflow.findCheckoutSessionForUpdate(id);
    if (session === undefined || session.userId !== input.actor.id) {
      throw new AppError('NOT_FOUND', 'The checkout session was not found.');
    }
    if (new Date(session.expiresAt) <= this.dependencies.now()) {
      throw new AppError('CHECKOUT_EXPIRED', 'This checkout has expired.');
    }
    return {
      checkoutSessionId: id,
      refreshVersion: input.requestHash,
      expiresAt: session.expiresAt,
      protectedPreview: {
        kind: 'non_spending_policy_preview' as const,
        providerMode: this.dependencies.checkoutPreviewPolicy.providerMode,
        particleLiveEnabled: this.dependencies.checkoutPreviewPolicy.particleLiveEnabled,
        eip7702: true,
        destinationChainId: ARBITRUM_ONE_CHAIN_ID,
        destinationContract: this.dependencies.checkoutAddress,
        tokenAddress: this.dependencies.tokenAddress,
        maxSlippageBps: this.dependencies.checkoutPreviewPolicy.maxSlippageBps,
        maxFeeUsdMicros: this.dependencies.checkoutPreviewPolicy.maxFeeUsdMicros,
        allowedSourceChainIds: this.dependencies.checkoutPreviewPolicy.allowedSourceChainIds,
        allowedSourceAssets: this.dependencies.checkoutPreviewPolicy.allowedSourceAssets,
        signedOrderIntentIssued: false,
        operationPlanAuthorized: false,
        submissionAuthorized: false,
        submissionEndpointEnabled: this.dependencies.checkoutPreviewPolicy.submissionEnabled,
      },
    };
  }

  async createPaymentAttempt(input: Parameters<BackendApiCommandPort['createPaymentAttempt']>[0]) {
    try {
      const binding = await this.dependencies.createPaymentAttempt.execute({
        checkoutSessionId: input.checkoutSessionId,
        user: input.actor,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestHash: input.requestHash,
      });
      return { binding };
    } catch (error) {
      if (isAppError(error)) throw error;
      throw new AppError(
        'INTERNAL_ERROR',
        'OpenTab could not persist the server-approved payment attempt.',
        { cause: error },
      );
    }
  }

  async recordPreparedPayment(
    input: Parameters<BackendApiCommandPort['recordPreparedPayment']>[0],
  ) {
    const body = PreparedPaymentBodySchema.parse(input.body);
    const attemptId = PaymentAttemptIdSchema.parse(input.paymentAttemptId);
    return this.#idempotent(
      input,
      `payment-attempt:prepared:${input.actor.id}:${attemptId}`,
      async () => ({
        attempt: await this.dependencies.recordPreparedAttempt.execute({
          attemptId,
          actor: input.actor,
          ...body,
        }),
      }),
    );
  }

  async startPaymentSubmission(
    input: Parameters<BackendApiCommandPort['startPaymentSubmission']>[0],
  ) {
    const body = StartSubmissionBodySchema.parse(input.body);
    const attemptId = PaymentAttemptIdSchema.parse(input.paymentAttemptId);
    return this.#idempotent(
      input,
      `payment-submission:start:${input.actor.id}:${attemptId}`,
      async () => {
        const workflow = await this.dependencies.queries.getPaymentWorkflowForActor(
          attemptId,
          input.actor,
        );
        if (workflow === undefined) {
          throw new AppError('NOT_FOUND', 'The payment attempt was not found.');
        }
        await this.dependencies.authorizePaymentSubmission?.({
          actor: input.actor,
          workflow,
        });
        return {
          attempt: await this.dependencies.startSubmission.execute({
            attemptId,
            actor: input.actor,
            ...body,
          }),
        };
      },
    );
  }

  async registerPaymentSubmission(
    input: Parameters<BackendApiCommandPort['registerPaymentSubmission']>[0],
  ) {
    const body = RegisterSubmissionBodySchema.parse(input.body);
    const attemptId = PaymentAttemptIdSchema.parse(input.paymentAttemptId);
    return this.#idempotent(
      input,
      `payment-submission:result:${input.actor.id}:${attemptId}`,
      async () => {
        const current = await this.dependencies.queries.getAttemptForActor(attemptId, input.actor);
        if (current === undefined) {
          throw new AppError('NOT_FOUND', 'The payment attempt was not found.');
        }
        const boundary = assertExistingSubmissionRegistration({
          current,
          resourceLabel: 'The payment attempt',
          requestedStatus: body.status,
          ...(body.status === 'submitted'
            ? { requestedProviderOperationId: body.providerOperationId }
            : {}),
        });
        if (boundary.idempotent) return { attempt: current };
        return {
          attempt: await this.dependencies.attachSubmission.execute({
            attemptId,
            actor: input.actor,
            ...body,
          }),
        };
      },
    );
  }

  async recoverPaymentAttempt(
    input: Parameters<BackendApiCommandPort['recoverPaymentAttempt']>[0],
  ) {
    RecoveryBodySchema.parse(input.body);
    const attemptId = PaymentAttemptIdSchema.parse(input.paymentAttemptId);
    const workflow = await this.dependencies.queries.getPaymentWorkflowForActor(
      attemptId,
      input.actor,
    );
    if (workflow === undefined)
      throw new AppError('NOT_FOUND', 'The payment attempt was not found.');
    return workflow;
  }

  async recordDelegationEvidence(
    input: Parameters<BackendApiCommandPort['recordDelegationEvidence']>[0],
  ) {
    const body = DelegationEvidenceBodySchema.parse(input.body);
    const expectedDelegationImplementation = this.dependencies.expectedDelegationImplementation;
    const expectedDelegationCodeHash = this.dependencies.expectedDelegationCodeHash;
    if (
      expectedDelegationImplementation === undefined ||
      expectedDelegationCodeHash === undefined
    ) {
      throw new AppError(
        'FEATURE_DISABLED',
        'Delegation evidence is disabled until Particle is configured.',
      );
    }
    return this.#idempotent(input, `wallet:delegation-evidence:${input.actor.id}`, async () => {
      const readAuthorizationEvidence = this.dependencies.chain.getEip7702AuthorizationEvidence;
      if (readAuthorizationEvidence === undefined) {
        throw new AppError(
          'CONFIGURATION_INVALID',
          'Canonical EIP-7702 authorization verification is unavailable.',
        );
      }
      const authorizationEvidence = await readAuthorizationEvidence.call(this.dependencies.chain, {
        transactionHash: body.transactionHash,
        expectedAuthority: input.actor.walletAddress,
        expectedDelegate: expectedDelegationImplementation,
      });
      const evidenceTransactionHash = TransactionHashSchema.safeParse(
        authorizationEvidence.transactionHash,
      );
      const evidenceTransactionFrom = EvmAddressSchema.safeParse(
        authorizationEvidence.transactionFrom,
      );
      const evidenceAuthority = EvmAddressSchema.safeParse(authorizationEvidence.authority);
      const evidenceDelegate = EvmAddressSchema.safeParse(authorizationEvidence.delegate);
      const evidenceBlockNumber = UnsignedIntegerStringSchema.safeParse(
        authorizationEvidence.blockNumber,
      );
      const evidenceBlockHash = EvidenceDigestSchema.safeParse(authorizationEvidence.blockHash);
      const authorizationNonce = UnsignedIntegerStringSchema.safeParse(
        authorizationEvidence.authorizationNonce,
      );
      if (
        !evidenceTransactionHash.success ||
        !evidenceTransactionFrom.success ||
        !evidenceAuthority.success ||
        !evidenceDelegate.success ||
        !evidenceBlockNumber.success ||
        !evidenceBlockHash.success ||
        !authorizationNonce.success ||
        evidenceTransactionHash.data.toLowerCase() !== body.transactionHash.toLowerCase() ||
        !sameEvmAddress(evidenceTransactionFrom.data, input.actor.walletAddress) ||
        !sameEvmAddress(evidenceAuthority.data, input.actor.walletAddress) ||
        !sameEvmAddress(evidenceDelegate.data, expectedDelegationImplementation) ||
        authorizationEvidence.chainId !== ARBITRUM_ONE_CHAIN_ID ||
        authorizationEvidence.transactionType !== 'eip7702' ||
        authorizationEvidence.authorizationIndex !== 0 ||
        authorizationEvidence.canonical !== true
      ) {
        throw new AppError(
          'UA_CONFIGURATION_INVALID',
          'The EIP-7702 authorization evidence does not match this wallet.',
        );
      }
      const receipt = await this.dependencies.chain.getTransactionReceipt(body.transactionHash);
      if (!receipt.success) {
        throw new AppError('UA_DELEGATION_REQUIRED', 'The delegation transaction reverted.');
      }
      if (
        receipt.blockNumber !== evidenceBlockNumber.data ||
        receipt.blockHash.toLowerCase() !== evidenceBlockHash.data.toLowerCase()
      ) {
        throw new AppError(
          'UA_CONFIGURATION_INVALID',
          'The EIP-7702 authorization receipt does not match its canonical evidence.',
        );
      }
      const canonicalBlock = await this.dependencies.chain.getBlock(receipt.blockNumber);
      if (canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'The delegation transaction is not canonical.');
      }
      const delegation = await this.dependencies.chain.getDelegationCode(input.actor.walletAddress);
      if (
        delegation.accountType !== 'delegated_eoa' ||
        delegation.implementation === undefined ||
        !sameEvmAddress(delegation.implementation, expectedDelegationImplementation)
      ) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'The expected EIP-7702 delegation is not active.',
        );
      }
      const readCodeHash = this.dependencies.chain.getCodeHash;
      if (readCodeHash === undefined) {
        throw new AppError(
          'CONFIGURATION_INVALID',
          'Implementation code verification is unavailable.',
        );
      }
      const implementationCodeHash = await readCodeHash.call(
        this.dependencies.chain,
        delegation.implementation,
      );
      if (implementationCodeHash.toLowerCase() !== expectedDelegationCodeHash.toLowerCase()) {
        throw new AppError(
          'UA_CONFIGURATION_INVALID',
          'The EIP-7702 implementation code is invalid.',
        );
      }
      const serverEvidenceDigest = digestUnknown({
        schemaVersion: 2,
        environment: this.dependencies.environment,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        owner: input.actor.walletAddress.toLowerCase(),
        implementation: delegation.implementation.toLowerCase(),
        implementationCodeHash: implementationCodeHash.toLowerCase(),
        transactionHash: evidenceTransactionHash.data.toLowerCase(),
        transactionFrom: evidenceTransactionFrom.data.toLowerCase(),
        transactionType: authorizationEvidence.transactionType,
        blockNumber: evidenceBlockNumber.data,
        blockHash: evidenceBlockHash.data.toLowerCase(),
        authorizationAuthority: evidenceAuthority.data.toLowerCase(),
        authorizationDelegate: evidenceDelegate.data.toLowerCase(),
        authorizationIndex: authorizationEvidence.authorizationIndex,
        authorizationNonce: authorizationNonce.data,
        clientPlanBindingDigest: body.evidenceDigest.toLowerCase(),
      });
      const observedAt = this.dependencies.now();
      await this.dependencies.backend.recordDelegationEvidence({
        actor: input.actor,
        environment: this.dependencies.environment,
        implementationAddress: delegation.implementation,
        implementationCodeHash,
        transactionHash: evidenceTransactionHash.data,
        blockNumber: evidenceBlockNumber.data,
        blockHash: authorizationEvidence.blockHash,
        evidenceDigest: serverEvidenceDigest,
        observedAt,
      });
      return {
        ownerAddress: input.actor.walletAddress,
        universalAccountAddress: input.actor.walletAddress,
        ownerMatches: true,
        delegation: DelegationStatusSchema.parse({
          ownerAddress: input.actor.walletAddress,
          chainId: ARBITRUM_ONE_CHAIN_ID,
          delegated: true,
          implementationAddress: delegation.implementation,
          implementationCodeHash,
          transactionHash: evidenceTransactionHash.data,
          evidence: {
            adapter: 'viem-arbitrum-eip7702-authorization',
            packageVersion: '2.55.0',
            schemaVersion: 2,
            environment: this.dependencies.environment,
            observedAt: observedAt.toISOString(),
            evidenceDigest: serverEvidenceDigest,
            provenance: this.dependencies.evidenceProvenance,
          },
        }),
        ready: true,
        blockers: [],
        observedAt: observedAt.toISOString(),
      };
    });
  }

  async evaluateBootstrapEligibility(
    input: Parameters<BackendApiCommandPort['evaluateBootstrapEligibility']>[0],
  ) {
    const body = SponsorEligibilityCommandBodySchema.parse(input.body);
    const sponsor = this.#sponsorDependencies(input.actor.walletAddress);
    return this.#idempotent(input, `bootstrap-eligibility:${input.actor.id}`, async () => {
      await sponsor.challengeVerifier.verify(body.challengeToken);
      const delegation = await this.dependencies.chain.getDelegationCode(input.actor.walletAddress);
      const confirmedBalanceWei = BigInt(
        await this.dependencies.chain.getNativeBalance(input.actor.walletAddress),
      );
      if (confirmedBalanceWei < 0n) {
        throw new AppError('INTERNAL_ERROR', 'The confirmed wallet balance is invalid.');
      }
      const pendingAmountWei = await sponsor.grants.pendingAmountWei({
        environment: this.dependencies.environment,
        recipient: input.actor.walletAddress,
      });
      const rawDeficit = sponsor.policy.targetWei - confirmedBalanceWei - pendingAmountWei;
      const deficitWei = rawDeficit > 0n ? rawDeficit : 0n;
      const alreadyPrepared =
        delegation.accountType !== 'eoa' || delegation.implementation !== undefined;
      const eligible = !alreadyPrepared && deficitWei >= sponsor.policy.minimumGrantWei;
      return {
        eligible,
        recipient: input.actor.walletAddress,
        targetWei: BaseUnitAmountSchema.parse(sponsor.policy.targetWei.toString()),
        confirmedBalanceWei: BaseUnitAmountSchema.parse(confirmedBalanceWei.toString()),
        pendingAmountWei: BaseUnitAmountSchema.parse(pendingAmountWei.toString()),
        deficitWei: BaseUnitAmountSchema.parse(deficitWei.toString()),
        reason: alreadyPrepared
          ? ('already_prepared' as const)
          : eligible
            ? ('eligible' as const)
            : ('sufficient_balance' as const),
        observedAt: this.dependencies.now().toISOString(),
      };
    });
  }

  async requestBootstrapGrant(
    input: Parameters<BackendApiCommandPort['requestBootstrapGrant']>[0],
  ) {
    const body = SponsorGrantCommandBodySchema.parse(input.body);
    const sponsor = this.#sponsorDependencies(body.recipient);
    await sponsor.challengeVerifier.verify(body.challengeToken);
    const grant = await sponsor.request.execute({
      user: input.actor,
      recipient: body.recipient,
      identitySubjectHash: body.identitySubjectHash,
      addressSubjectHash: body.addressSubjectHash,
      networkSubjectHash: body.networkSubjectHash,
      deviceSubjectHash: body.deviceSubjectHash,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      requestId: input.requestId,
    });
    return {
      grant: {
        id: grant.id,
        userId: grant.userId,
        recipient: grant.recipient,
        amountWei: grant.amountWei,
        status: grant.status,
        ...(grant.transactionHash === undefined ? {} : { transactionHash: grant.transactionHash }),
        createdAt: grant.createdAt,
      },
    };
  }

  #sponsorDependencies(recipient: ReturnType<typeof EvmAddressSchema.parse>) {
    const challengeVerifier = this.dependencies.challengeVerifier;
    const grants = this.dependencies.sponsorGrants;
    const request = this.dependencies.requestBootstrapGrant;
    const policy = this.dependencies.sponsorPolicy;
    if (
      challengeVerifier === undefined ||
      grants === undefined ||
      request === undefined ||
      policy === undefined
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'Bootstrap sponsorship is not composed.');
    }
    if (
      policy.allowedRecipients !== undefined &&
      !policy.allowedRecipients.has(recipient.toLowerCase())
    ) {
      throw new AppError('SPONSOR_INELIGIBLE', 'This wallet is not eligible for preparation.');
    }
    return { challengeVerifier, grants, request, policy };
  }

  async prepareRefund(input: Parameters<BackendApiCommandPort['prepareRefund']>[0]) {
    const body = RefundBodySchema.parse(input.body);
    const refund = await this.dependencies.createRefund.execute({
      actorUserId: input.actor.id,
      orderId: input.orderId,
      amountBaseUnits: body.amountBaseUnits,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
    });
    const context = await this.dependencies.backend.getRefundChainContext(input.actor, refund.id);
    const binding = RefundOperationBindingSchema.parse({
      ownerAddress: input.actor.walletAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      checkoutAddress: this.dependencies.checkoutAddress,
      expiresAt: this.#operationExpiry(),
      refundId: refund.id,
      orderId: input.orderId,
      orderKey: context.orderKey,
      merchantOnchainId: context.merchantOnchainId,
      productOnchainId: context.productOnchainId,
      tokenAddress: context.tokenAddress,
      amountBaseUnits: refund.amountBaseUnits,
    });
    const operation = await this.dependencies.backend.prepareContractOperation({
      actor: input.actor,
      requestId: input.requestId,
      kind: 'refund',
      aggregateType: 'refund',
      aggregateId: refund.id,
      binding,
      template: createRefundOperationTemplate(binding),
    });
    return { refund, operation };
  }

  async registerRefundSubmission(
    input: Parameters<BackendApiCommandPort['registerRefundSubmission']>[0],
  ) {
    const body = FinancialSubmissionBodySchema.parse(input.body);
    return this.#idempotent(input, `refund:submission:${input.refundId}`, async () => {
      const current = await this.dependencies.backend.getRefund(input.refundId, input.actor);
      const boundary = assertExistingSubmissionRegistration({
        current,
        resourceLabel: 'The refund',
        requestedStatus: body.status,
        ...(body.status === 'submitted'
          ? { requestedProviderOperationId: body.providerOperationId }
          : {}),
      });
      if (boundary.idempotent) return { refund: current };
      return this.dependencies.backend
        .registerRefundSubmission({
          actor: input.actor,
          refundId: input.refundId,
          ...body,
        })
        .then((refund) => ({ refund }));
    });
  }

  async prepareWithdrawal(input: Parameters<BackendApiCommandPort['prepareWithdrawal']>[0]) {
    const body = WithdrawalBodySchema.parse(input.body);
    const withdrawal = await this.dependencies.createWithdrawal.execute({
      actorUserId: input.actor.id,
      ...body,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
    });
    const context = await this.dependencies.backend.getWithdrawalChainContext(
      input.actor,
      withdrawal.id,
    );
    const binding = WithdrawalOperationBindingSchema.parse({
      ownerAddress: input.actor.walletAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      checkoutAddress: this.dependencies.checkoutAddress,
      expiresAt: this.#operationExpiry(),
      withdrawalId: withdrawal.id,
      merchantOnchainId: context.merchantOnchainId,
      payoutAddress: context.withdrawal.recipient,
      tokenAddress: this.dependencies.tokenAddress,
      amountBaseUnits: context.withdrawal.amountBaseUnits,
    });
    const operation = await this.dependencies.backend.prepareContractOperation({
      actor: input.actor,
      requestId: input.requestId,
      kind: 'withdrawal',
      aggregateType: 'withdrawal',
      aggregateId: withdrawal.id,
      binding,
      template: createWithdrawalOperationTemplate(binding),
    });
    return { withdrawal, operation };
  }

  async registerWithdrawalSubmission(
    input: Parameters<BackendApiCommandPort['registerWithdrawalSubmission']>[0],
  ) {
    const body = FinancialSubmissionBodySchema.parse(input.body);
    return this.#idempotent(input, `withdrawal:submission:${input.withdrawalId}`, async () => {
      const current = await this.dependencies.backend.getWithdrawal(
        input.withdrawalId,
        input.actor,
      );
      const boundary = assertExistingSubmissionRegistration({
        current,
        resourceLabel: 'The withdrawal',
        requestedStatus: body.status,
        ...(body.status === 'submitted'
          ? { requestedProviderOperationId: body.providerOperationId }
          : {}),
      });
      if (boundary.idempotent) return { withdrawal: current };
      return this.dependencies.backend
        .registerWithdrawalSubmission({
          actor: input.actor,
          withdrawalId: input.withdrawalId,
          ...body,
        })
        .then((withdrawal) => ({ withdrawal }));
    });
  }

  updateLoyalty(input: Parameters<BackendApiCommandPort['updateLoyalty']>[0]) {
    const body = LoyaltyBodySchema.parse(input.body);
    return this.#idempotent(input, `loyalty:update:${body.merchantId}`, () =>
      this.dependencies.backend
        .updateLoyalty({ actor: input.actor, ...body })
        .then((program) => ({ program })),
    );
  }

  async createSplit(input: Parameters<BackendApiCommandPort['createSplit']>[0]) {
    const body = SplitBodySchema.parse(input.body);
    return this.dependencies.createSplit.execute({
      actorUserId: input.actor.id,
      orderId: input.orderId,
      ...body,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
    });
  }

  inviteSplitParticipants(input: Parameters<BackendApiCommandPort['inviteSplitParticipants']>[0]) {
    const body = SplitInvitationBodySchema.parse(input.body);
    return this.#idempotent(input, `split:invite:${input.splitId}`, () =>
      this.dependencies.backend.inviteSplitParticipants({
        actor: input.actor,
        splitId: input.splitId as never,
        participants: body.participants,
      }),
    );
  }

  async revokeSplit(input: Parameters<BackendApiCommandPort['revokeSplit']>[0]) {
    const body = SplitRevokeBodySchema.parse(input.body);
    const prepared = await this.dependencies.backend.prepareSplitRevocation({
      actor: input.actor,
      splitId: input.splitId,
      reason: body.reason,
      requestId: input.requestId,
    });
    if (prepared.status === 'revoked') {
      return { splitId: prepared.splitId, status: prepared.status, reason: prepared.reason };
    }
    const sender = this.dependencies.splitRevocationSender;
    const locks = this.dependencies.managedSignerLocks;
    const signerAddress = this.dependencies.splitSignerAddress;
    if (sender === undefined || locks === undefined || signerAddress === undefined) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Managed split revocation is unavailable for an issued payment key.',
      );
    }
    const operations = await locks.withLock(
      `split-revocation-signer:${signerAddress.toLowerCase()}`,
      60_000,
      async (signal) => {
        const results = [];
        for (const payment of prepared.paymentRevocations) {
          if (signal.aborted) {
            throw new AppError('PAYMENT_SUBMITTED_UNKNOWN', 'The signer lock was lost.', {
              retryable: true,
              submissionPossible: true,
            });
          }
          let persisted = payment.existingOperation;
          if (
            persisted?.status === 'prepared' &&
            new Date(persisted.expiresAt) <= this.dependencies.now()
          ) {
            persisted = await this.dependencies.backend.failManagedSplitRevocationSubmission({
              actor: input.actor,
              operationId: persisted.id,
            });
          }
          if (persisted !== undefined && persisted.status !== 'failed') {
            if (persisted.status !== 'prepared') {
              results.push(persisted);
              continue;
            }
          }
          const binding =
            persisted?.status === 'prepared'
              ? SplitRevocationOperationBindingSchema.parse(persisted.binding)
              : SplitRevocationOperationBindingSchema.parse({
                  invitationId: payment.invitationId,
                  signerAddress,
                  chainId: ARBITRUM_ONE_CHAIN_ID,
                  splitContractAddress: this.dependencies.splitAddress,
                  paymentKey: payment.paymentKey,
                  splitDigest: payment.splitDigest,
                  expiresAt: this.#operationExpiry(),
                });
          const managedOperation = createSplitRevocationOperation(binding);
          const template = BoundOperationTemplateSchema.parse({
            kind: 'split_revocation',
            ownerAddress: managedOperation.signerAddress,
            chainId: managedOperation.chainId,
            calls: [managedOperation.call],
            bindingDigest: managedOperation.bindingDigest,
            expiresAt: managedOperation.expiresAt,
          });
          if (persisted?.status === 'prepared') {
            if (
              persisted.bindingDigest !== template.bindingDigest ||
              digestUnknown(persisted.template) !== digestUnknown(template)
            ) {
              throw new AppError(
                'OPERATION_PLAN_INVALID',
                'The persisted split revocation operation does not match its binding.',
              );
            }
          } else {
            persisted = await this.dependencies.backend.prepareManagedSplitRevocationOperation({
              actor: input.actor,
              aggregateId: payment.paymentId,
              signerAddress,
              binding,
              template,
              requestId: input.requestId,
            });
          }
          const started = await this.dependencies.backend.startManagedSplitRevocationSubmission({
            actor: input.actor,
            operationId: persisted.id,
          });
          if (started.status !== 'submission_started') {
            results.push(started);
            continue;
          }
          try {
            const submission = await sender.submit({ binding, operation: managedOperation });
            results.push(
              await this.dependencies.backend.recordManagedSplitRevocationSubmission({
                actor: input.actor,
                operationId: started.id,
                status: submission.status,
                signerNonce: submission.signerNonce,
                ...(submission.status === 'submitted'
                  ? { transactionHash: submission.transactionHash }
                  : {}),
              }),
            );
          } catch (error) {
            await this.dependencies.backend.failManagedSplitRevocationSubmission({
              actor: input.actor,
              operationId: started.id,
            });
            throw error;
          }
        }
        return results;
      },
    );
    return {
      splitId: prepared.splitId,
      status: 'revoking' as const,
      reason: prepared.reason,
      operations,
    };
  }

  async prepareSplitPayment(input: Parameters<BackendApiCommandPort['prepareSplitPayment']>[0]) {
    const body = SplitPrepareBodySchema.parse(input.body);
    const capability = await this.dependencies.queries.getSplitByCapability(
      body.capabilityReference,
      this.dependencies.now(),
    );
    if (capability === undefined || capability.split.id !== input.splitId) {
      throw new AppError('NOT_FOUND', 'The split invitation was not found.');
    }
    const prepared = await this.#idempotent(
      input,
      `split:payment:prepare:${capability.invitation.id}`,
      () =>
        this.dependencies.backend.prepareSplitPayment({
          actor: input.actor,
          splitId: input.splitId,
          invitationId: capability.invitation.id,
          capabilityReference: body.capabilityReference,
          amountBaseUnits: capability.invitation.amountBaseUnits,
        }),
    );
    const splitSigner = this.dependencies.splitSigner;
    const splitSignerAddress = this.dependencies.splitSignerAddress;
    const splitSignerKeyId = this.dependencies.splitSignerKeyId;
    if (
      splitSigner === undefined ||
      splitSignerAddress === undefined ||
      splitSignerKeyId === undefined
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'The split intent signer is not configured.');
    }
    const now = this.dependencies.now();
    const boundedExpiry = new Date(
      Math.min(
        new Date(prepared.binding.expiresAt).getTime(),
        now.getTime() + Math.min(this.dependencies.operationTtlSeconds, 86_400) * 1_000,
      ),
    );
    const intent = SplitReimbursementIntentSchema.parse({
      paymentKey: prepared.binding.paymentKey,
      splitDigest: prepared.binding.splitDigest,
      originalOrderKey: prepared.binding.originalOrderKey,
      payer: input.actor.walletAddress,
      beneficiary: prepared.binding.beneficiary,
      token: prepared.binding.token,
      amountBaseUnits: prepared.binding.amountBaseUnits,
      validAfter: (BigInt(now.getTime()) / 1_000n).toString(),
      validUntil: (BigInt(boundedExpiry.getTime()) / 1_000n).toString(),
      metadataHash: canonicalMetadataDigest({
        schema: 'opentab-split-payment-v1',
        splitId: input.splitId,
        invitationId: capability.invitation.id,
        amountBaseUnits: prepared.binding.amountBaseUnits,
        beneficiary: prepared.binding.beneficiary,
        originalOrderKey: prepared.binding.originalOrderKey,
      }),
    });
    const signed = await splitSigner.signIntent(intent);
    if (signed.signerKeyId !== splitSignerKeyId) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The split signer key did not match configuration.',
      );
    }
    const binding = SplitReimbursementOperationBindingSchema.parse({
      invitationId: capability.invitation.id,
      ownerAddress: input.actor.walletAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      splitContractAddress: this.dependencies.splitAddress,
      tokenAddress: this.dependencies.tokenAddress,
      authorizedSignerAddress: splitSignerAddress,
      intent,
      intentDigest: signed.digest,
      signature: signed.signature,
      expiresAt: boundedExpiry.toISOString(),
    });
    await this.dependencies.backend.recordSplitIntent({
      actor: input.actor,
      splitPaymentId: prepared.payment.id,
      intentDigest: signed.digest,
    });
    const operation = await this.dependencies.backend.prepareContractOperation({
      actor: input.actor,
      requestId: input.requestId,
      kind: 'split_reimbursement',
      aggregateType: 'split_payment',
      aggregateId: prepared.payment.id,
      binding,
      template: createSplitReimbursementOperationTemplate(binding),
    });
    return { payment: prepared.payment, binding, operation };
  }

  async registerSplitPaymentSubmission(
    input: Parameters<BackendApiCommandPort['registerSplitPaymentSubmission']>[0],
  ) {
    const body = SplitSubmissionBodySchema.parse(input.body);
    return this.#idempotent(
      input,
      `split:payment:submission:${input.splitPaymentAttemptId}`,
      async () => {
        const current = await this.dependencies.backend.getSplitPayment(
          input.splitPaymentAttemptId,
          input.actor,
        );
        const boundary = assertExistingSubmissionRegistration({
          current,
          resourceLabel: 'The split payment',
          requestedStatus: body.status,
          submittedStatus: 'confirming',
          ...(body.status === 'submitted'
            ? { requestedProviderOperationId: body.providerOperationId }
            : {}),
        });
        if (boundary.idempotent) return { payment: current };
        return this.dependencies.backend
          .registerSplitPaymentSubmission({
            actor: input.actor,
            splitPaymentAttemptId: input.splitPaymentAttemptId,
            ...body,
          })
          .then((payment) => ({ payment }));
      },
    );
  }

  async registerContractOperationSubmission(
    input: Parameters<BackendApiCommandPort['registerContractOperationSubmission']>[0],
  ) {
    const body = ContractOperationSubmissionBodySchema.parse(input.body);
    const expectedMagicDirectId = `magic-direct:${input.operationId}`;
    if (
      body.providerOperationId.startsWith('magic-direct:') &&
      body.providerOperationId !== expectedMagicDirectId
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The Magic transaction reference does not match the contract operation.',
      );
    }
    if (
      body.status !== 'submission_started' &&
      body.providerOperationId === expectedMagicDirectId &&
      body.transactionHash === undefined
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'A Magic-direct submission must persist its transaction hash.',
      );
    }
    return this.#idempotent(
      input,
      `contract-operation:submission:${input.operationId}:${body.status}`,
      async () => {
        const current = await this.dependencies.backend.getContractOperation(
          input.operationId,
          input.actor,
        );
        if (current === undefined) {
          throw new AppError('NOT_FOUND', 'The contract operation was not found.');
        }
        if (body.status === 'submission_started') {
          if (current.status === 'submission_started') {
            if (current.providerOperationId !== body.providerOperationId) {
              throw new AppError(
                'IDEMPOTENCY_CONFLICT',
                'The provider operation does not match the contract operation.',
              );
            }
            return { operation: current };
          }
          if (current.status !== 'prepared') {
            throw new AppError(
              'PAYMENT_ALREADY_SUBMITTED',
              'The contract operation is already in progress.',
              { submissionPossible: true },
            );
          }
          this.#assertOperationSubmissionEnabled(current);
        } else {
          const boundary = assertExistingSubmissionRegistration({
            current,
            resourceLabel: 'The contract operation',
            requestedStatus: body.status,
            requestedProviderOperationId: body.providerOperationId,
            ...(body.transactionHash === undefined
              ? {}
              : { requestedTransactionHash: body.transactionHash }),
            ...(body.status === 'submitted'
              ? { allowedTransitionStatuses: ['submission_started', 'submitted_unknown'] }
              : {}),
          });
          if (boundary.idempotent) return { operation: current };
        }
        return this.dependencies.backend
          .registerContractOperationSubmission({
            actor: input.actor,
            operationId: input.operationId,
            ...body,
          })
          .then((operation) => ({ operation }));
      },
    );
  }

  materializeJudgeEvidence(
    input: Parameters<BackendApiCommandPort['materializeJudgeEvidence']>[0],
  ) {
    const manager = this.#judgeEvidenceManager();
    return this.#idempotent(input, `judge-evidence:materialize:${input.orderId}`, () =>
      manager.materialize(input.actor, input.orderId),
    );
  }

  publishJudgeEvidence(input: Parameters<BackendApiCommandPort['publishJudgeEvidence']>[0]) {
    const body = JudgeEvidencePublishBodySchema.parse(input.body);
    const manager = this.#judgeEvidenceManager();
    return this.#idempotent(input, `judge-evidence:publish:${input.orderId}`, () =>
      manager.publish(input.actor, input.orderId, {
        protected: body.protected,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      }),
    );
  }

  revokeJudgeEvidence(input: Parameters<BackendApiCommandPort['revokeJudgeEvidence']>[0]) {
    const manager = this.#judgeEvidenceManager();
    return this.#idempotent(input, `judge-evidence:revoke:${input.orderId}`, () =>
      manager.revoke(input.actor, input.orderId),
    );
  }

  #judgeEvidenceManager(): PostgresJudgeEvidenceManager {
    const manager = this.dependencies.judgeEvidence;
    if (manager === undefined) {
      throw new AppError('FEATURE_DISABLED', 'Judge evidence publishing is disabled.');
    }
    return manager;
  }
}
