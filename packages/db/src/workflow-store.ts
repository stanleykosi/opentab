import type {
  AuthoritativeProduct,
  CheckoutSessionRecord,
  CheckoutWorkflowStorePort,
  FinancialWorkflowStorePort,
  OrderRecord,
  PaymentAttemptRecord,
} from '@opentab/application';
import {
  AppError,
  type BaseUnitAmount,
  BaseUnitAmountSchema,
  type CheckoutBinding,
  type CheckoutSessionId,
  CheckoutSessionIdSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  type OrderId,
  OrderIdSchema,
  OrderKeySchema,
  type PaymentAttemptId,
  PaymentAttemptIdSchema,
  type ProductId,
  ProductIdSchema,
  ProviderOperationIdSchema,
  QuantitySchema,
  type RefundId,
  RefundIdSchema,
  TransactionHashSchema,
  UserIdSchema,
  type WithdrawalId,
  WithdrawalIdSchema,
} from '@opentab/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DrizzleMerchantRepository, DrizzleProductRepository } from './repositories.js';
import {
  checkoutSessions,
  merchants,
  orders,
  paymentAttempts,
  products,
  refunds,
  settlementCredits,
  signedOrderIntents,
  withdrawals,
} from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

function iso(value: Date): string {
  return value.toISOString();
}

export function toCheckoutSessionRecord(
  record: typeof checkoutSessions.$inferSelect,
): CheckoutSessionRecord {
  return {
    id: CheckoutSessionIdSchema.parse(record.id),
    ...(record.userId === null ? {} : { userId: UserIdSchema.parse(record.userId) }),
    productId: ProductIdSchema.parse(record.productId),
    productVersion: record.productVersion.toString(),
    quantity: QuantitySchema.parse(record.quantity),
    ...(record.receiptRecipient === null
      ? {}
      : { receiptRecipient: EvmAddressSchema.parse(record.receiptRecipient) }),
    amountBaseUnits: BaseUnitAmountSchema.parse(record.amountBaseUnits),
    orderKey: OrderKeySchema.parse(record.orderKey),
    status: record.status,
    expiresAt: iso(record.expiresAt),
    ...(record.bindingDigest === null ? {} : { bindingDigest: record.bindingDigest as never }),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export function toOrderRecord(record: typeof orders.$inferSelect): OrderRecord {
  return {
    id: OrderIdSchema.parse(record.id),
    checkoutSessionId: CheckoutSessionIdSchema.parse(record.checkoutSessionId),
    orderKey: OrderKeySchema.parse(record.orderKey),
    userId: UserIdSchema.parse(record.userId),
    merchantId: MerchantIdSchema.parse(record.merchantId),
    productId: ProductIdSchema.parse(record.productId),
    payer: EvmAddressSchema.parse(record.payer),
    recipient: EvmAddressSchema.parse(record.recipient),
    quantity: QuantitySchema.parse(record.quantity),
    amountBaseUnits: BaseUnitAmountSchema.parse(record.amountBaseUnits),
    paidAmountBaseUnits: BaseUnitAmountSchema.parse(record.paidAmountBaseUnits),
    refundedAmountBaseUnits: BaseUnitAmountSchema.parse(record.refundedAmountBaseUnits),
    status: record.status,
    ...(record.providerOperationId === null
      ? {}
      : { providerOperationId: ProviderOperationIdSchema.parse(record.providerOperationId) }),
    ...(record.transactionHash === null
      ? {}
      : { transactionHash: TransactionHashSchema.parse(record.transactionHash) }),
    ...(record.confirmedAt === null ? {} : { confirmedAt: iso(record.confirmedAt) }),
    refundableUntil: iso(record.refundableUntil),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export function toPaymentAttemptRecord(
  record: typeof paymentAttempts.$inferSelect,
): PaymentAttemptRecord {
  return {
    id: PaymentAttemptIdSchema.parse(record.id),
    orderId: OrderIdSchema.parse(record.orderId),
    checkoutSessionId: CheckoutSessionIdSchema.parse(record.checkoutSessionId),
    attemptNumber: record.attemptNumber.toString(),
    status: record.status,
    bindingDigest: record.bindingDigest as never,
    ...(record.providerOperationId === null
      ? {}
      : { providerOperationId: ProviderOperationIdSchema.parse(record.providerOperationId) }),
    ...(record.destinationTransactionHash === null
      ? {}
      : {
          destinationTransactionHash: TransactionHashSchema.parse(
            record.destinationTransactionHash,
          ),
        }),
    ...(record.preparedExpiresAt === null
      ? {}
      : { preparedExpiresAt: iso(record.preparedExpiresAt) }),
    reconciliationRequired: record.reconciliationRequired,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class PostgresWorkflowStore
  implements CheckoutWorkflowStorePort, FinancialWorkflowStorePort
{
  readonly #merchants: DrizzleMerchantRepository;
  readonly #products: DrizzleProductRepository;

  constructor(private readonly uow: PostgresUnitOfWork) {
    this.#merchants = new DrizzleMerchantRepository(uow);
    this.#products = new DrizzleProductRepository(uow);
  }

  async findAuthoritativeProduct(productId: ProductId): Promise<AuthoritativeProduct | undefined> {
    const product = await this.#products.findById(productId);
    if (product === undefined || product.onchainProductId === undefined) return undefined;
    const merchant = await this.#merchants.findById(product.merchantId);
    if (merchant === undefined) return undefined;

    const [projection] = await this.uow
      .current()
      .select({
        productSync: products.chainSyncStatus,
        merchantOnchainId: merchants.onchainMerchantId,
        merchantSync: merchants.chainSyncStatus,
        observedAt: products.updatedAt,
      })
      .from(products)
      .innerJoin(merchants, eq(merchants.id, products.merchantId))
      .where(and(eq(products.id, productId), eq(merchants.id, product.merchantId)))
      .limit(1);
    if (projection?.merchantOnchainId === null || projection?.merchantOnchainId === undefined)
      return undefined;
    return {
      product,
      merchant,
      merchantOnchainId: projection.merchantOnchainId,
      productOnchainId: product.onchainProductId,
      active:
        projection.productSync === 'confirmed' &&
        projection.merchantSync === 'confirmed' &&
        merchant.status === 'active' &&
        product.status === 'active',
      observedAt: iso(projection.observedAt),
    };
  }

  async createCheckoutSession(
    input: Parameters<CheckoutWorkflowStorePort['createCheckoutSession']>[0],
  ): Promise<CheckoutSessionRecord> {
    const [created] = await this.uow
      .current()
      .insert(checkoutSessions)
      .values({
        id: input.id,
        ...(input.capabilityHash === undefined
          ? {}
          : { publicCapabilityHash: input.capabilityHash }),
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        productId: input.productId,
        productVersion: Number(input.productVersion),
        quantity: input.quantity,
        ...(input.receiptRecipient === undefined
          ? {}
          : { receiptRecipient: input.receiptRecipient }),
        amountBaseUnits: input.amountBaseUnits,
        orderKey: input.orderKey,
        status: input.userId === undefined ? 'active' : 'bound',
        expiresAt: input.expiresAt,
        ...(input.userId === undefined ? {} : { boundAt: input.now }),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    if (created === undefined) throw new Error('Failed to create checkout session');
    return toCheckoutSessionRecord(created);
  }

  async findCheckoutSessionForUpdate(
    id: CheckoutSessionId,
  ): Promise<CheckoutSessionRecord | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, id))
      .for('update')
      .limit(1);
    return record === undefined ? undefined : toCheckoutSessionRecord(record);
  }

  async bindCheckoutSession(
    input: Parameters<CheckoutWorkflowStorePort['bindCheckoutSession']>[0],
  ): Promise<CheckoutSessionRecord> {
    const [record] = await this.uow
      .current()
      .update(checkoutSessions)
      .set({
        userId: input.userId,
        receiptRecipient: input.receiptRecipient,
        bindingDigest: input.bindingDigest,
        status: 'bound',
        boundAt: input.now,
        updatedAt: input.now,
        version: sql`${checkoutSessions.version} + 1`,
      })
      .where(
        and(
          eq(checkoutSessions.id, input.id),
          inArray(checkoutSessions.status, ['active', 'bound']),
          sql`${checkoutSessions.expiresAt} > ${input.now}`,
          sql`(${checkoutSessions.userId} is null or ${checkoutSessions.userId} = ${input.userId})`,
        ),
      )
      .returning();
    if (record === undefined) {
      throw new AppError('CHECKOUT_EXPIRED', 'This checkout can no longer be bound.');
    }
    return toCheckoutSessionRecord(record);
  }

  async createOrderAttempt(
    input: Parameters<CheckoutWorkflowStorePort['createOrderAttempt']>[0],
  ): Promise<{ order: OrderRecord; attempt: PaymentAttemptRecord }> {
    const binding = input.binding as CheckoutBinding;
    return this.uow.transaction(async () => {
      const [existingOrder] = await this.uow
        .current()
        .select()
        .from(orders)
        .where(eq(orders.checkoutSessionId, input.session.id))
        .for('update')
        .limit(1);
      if (existingOrder !== undefined) {
        throw new AppError(
          'PAYMENT_ALREADY_SUBMITTED',
          'A payment attempt already exists for this checkout.',
          {
            submissionPossible: existingOrder.status !== 'created',
          },
        );
      }

      await this.uow
        .current()
        .insert(signedOrderIntents)
        .values({
          checkoutSessionId: input.session.id,
          orderKey: input.session.orderKey,
          digest: input.intentDigest,
          signerAddress: input.intentSignerAddress,
          signerKeyId: binding.signerKeyId,
          intent: Object.fromEntries(
            Object.entries(binding.orderIntent).map(([key, value]) => [key, String(value)]),
          ),
          signature: binding.orderIntentSignature,
          validAfter: new Date(Number(BigInt(binding.orderIntent.validAfter) * 1_000n)),
          validUntil: new Date(Number(BigInt(binding.orderIntent.validUntil) * 1_000n)),
          refundableUntil: input.refundableUntil,
          createdAt: input.now,
        });
      const [createdOrder] = await this.uow
        .current()
        .insert(orders)
        .values({
          id: input.orderId,
          checkoutSessionId: input.session.id,
          orderKey: input.session.orderKey,
          userId: input.user.id,
          merchantId: input.merchantId,
          productId: input.session.productId,
          payer: input.user.walletAddress,
          recipient: input.session.receiptRecipient ?? input.user.walletAddress,
          tokenAddress: input.tokenAddress,
          quantity: input.session.quantity,
          amountBaseUnits: input.session.amountBaseUnits,
          status: 'created',
          chainId: binding.chainId,
          intentDigest: input.intentDigest,
          refundableUntil: input.refundableUntil,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      const [createdAttempt] = await this.uow
        .current()
        .insert(paymentAttempts)
        .values({
          id: input.attemptId,
          orderId: input.orderId,
          checkoutSessionId: input.session.id,
          attemptNumber: 1,
          status: 'created',
          bindingDigest: input.binding.bindingDigest,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (createdOrder === undefined || createdAttempt === undefined) {
        throw new Error('Failed to create order payment attempt');
      }
      return {
        order: toOrderRecord(createdOrder),
        attempt: toPaymentAttemptRecord(createdAttempt),
      };
    });
  }

  async recordPreparedAttempt(
    input: Parameters<CheckoutWorkflowStorePort['recordPreparedAttempt']>[0],
  ): Promise<PaymentAttemptRecord> {
    return this.uow.transaction(async () => {
      const [owned] = await this.uow
        .current()
        .select({ attempt: paymentAttempts })
        .from(paymentAttempts)
        .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
        .where(
          and(
            eq(paymentAttempts.id, input.attemptId),
            eq(orders.userId, input.actorUserId),
            eq(orders.payer, input.actorWalletAddress),
          ),
        )
        .for('update', { of: paymentAttempts })
        .limit(1);
      const current = owned?.attempt;
      if (current === undefined)
        throw new AppError('NOT_FOUND', 'The payment attempt was not found.');
      if (current.status === 'prepared') {
        if (
          current.providerOperationId !== input.providerOperationId ||
          current.preparedRootHashDigest !== input.rootHashDigest ||
          current.previewDigest !== input.previewDigest
        ) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Different payment details were already prepared.',
          );
        }
        return toPaymentAttemptRecord(current);
      }
      if (current.status !== 'created') {
        throw new AppError(
          'PAYMENT_ALREADY_SUBMITTED',
          'The payment is already past preparation.',
          {
            submissionPossible: !['failed_pre_submission', 'expired'].includes(current.status),
          },
        );
      }
      const [updated] = await this.uow
        .current()
        .update(paymentAttempts)
        .set({
          status: 'prepared',
          providerOperationId: input.providerOperationId,
          preparedRootHashDigest: input.rootHashDigest,
          previewDigest: input.previewDigest,
          quoteSummary: { ...input.quoteSummary },
          preparedExpiresAt: input.expiresAt,
          updatedAt: input.now,
          version: sql`${paymentAttempts.version} + 1`,
        })
        .where(eq(paymentAttempts.id, input.attemptId))
        .returning();
      if (updated === undefined) throw new Error('Failed to record prepared payment');
      return toPaymentAttemptRecord(updated);
    });
  }

  async startSubmission(
    input: Parameters<CheckoutWorkflowStorePort['startSubmission']>[0],
  ): Promise<PaymentAttemptRecord> {
    return this.uow.transaction(async () => {
      const [owned] = await this.uow
        .current()
        .select({ attempt: paymentAttempts })
        .from(paymentAttempts)
        .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
        .where(
          and(
            eq(paymentAttempts.id, input.attemptId),
            eq(orders.userId, input.actorUserId),
            eq(orders.payer, input.actorWalletAddress),
          ),
        )
        .for('update', { of: paymentAttempts })
        .limit(1);
      const current = owned?.attempt;
      if (current === undefined)
        throw new AppError('NOT_FOUND', 'The payment attempt was not found.');
      if (current.bindingDigest !== input.expectedBindingDigest) {
        throw new AppError('OPERATION_PLAN_INVALID', 'The payment binding does not match.');
      }
      // Exact replay is handled by the HTTP/application idempotency record.
      // Reaching the store again means a different key/caller crossed the
      // irreversible boundary and must never receive permission to send.
      if (current.status === 'submission_started') {
        throw new AppError(
          'PAYMENT_SUBMITTED_UNKNOWN',
          'Payment submission has already started and must be reconciled.',
          { submissionPossible: true },
        );
      }
      if (current.status !== 'prepared') {
        throw new AppError('PAYMENT_ALREADY_SUBMITTED', 'The payment cannot be submitted again.', {
          submissionPossible: !['created', 'failed_pre_submission', 'expired'].includes(
            current.status,
          ),
        });
      }
      if (current.preparedExpiresAt === null || current.preparedExpiresAt <= input.now) {
        await this.uow
          .current()
          .update(paymentAttempts)
          .set({ status: 'expired', terminalAt: input.now, updatedAt: input.now })
          .where(eq(paymentAttempts.id, input.attemptId));
        throw new AppError('UA_QUOTE_EXPIRED', 'Payment details expired. Refresh and try again.', {
          retryable: true,
        });
      }
      const [updated] = await this.uow
        .current()
        .update(paymentAttempts)
        .set({
          status: 'submission_started',
          submissionStartedAt: input.now,
          reconciliationRequired: true,
          updatedAt: input.now,
          version: sql`${paymentAttempts.version} + 1`,
        })
        .where(eq(paymentAttempts.id, input.attemptId))
        .returning();
      if (updated === undefined) throw new Error('Failed to start payment submission');
      return toPaymentAttemptRecord(updated);
    });
  }

  async attachSubmission(
    input: Parameters<CheckoutWorkflowStorePort['attachSubmission']>[0],
  ): Promise<PaymentAttemptRecord> {
    return this.uow.transaction(async () => {
      const [owned] = await this.uow
        .current()
        .select({ attempt: paymentAttempts })
        .from(paymentAttempts)
        .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
        .where(
          and(
            eq(paymentAttempts.id, input.attemptId),
            eq(orders.userId, input.actorUserId),
            eq(orders.payer, input.actorWalletAddress),
          ),
        )
        .for('update', { of: paymentAttempts })
        .limit(1);
      const current = owned?.attempt;
      if (current === undefined)
        throw new AppError('NOT_FOUND', 'The payment attempt was not found.');
      if (current.status === input.status) {
        if (
          input.providerOperationId !== undefined &&
          current.providerOperationId !== input.providerOperationId
        ) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'A different provider operation is already attached.',
          );
        }
        return toPaymentAttemptRecord(current);
      }
      if (current.status !== 'submission_started') {
        throw new AppError(
          'PAYMENT_ALREADY_SUBMITTED',
          'The payment submission state cannot be changed.',
          {
            submissionPossible: true,
          },
        );
      }
      const [updated] = await this.uow
        .current()
        .update(paymentAttempts)
        .set({
          status: input.status,
          ...(input.providerOperationId === undefined
            ? {}
            : { providerOperationId: input.providerOperationId }),
          submittedAt: input.status === 'submitted' ? input.now : null,
          reconciliationRequired: true,
          updatedAt: input.now,
          version: sql`${paymentAttempts.version} + 1`,
        })
        .where(eq(paymentAttempts.id, input.attemptId))
        .returning();
      if (updated === undefined) throw new Error('Failed to attach payment submission');
      await this.uow
        .current()
        .update(orders)
        .set({
          status: 'submitted',
          ...(input.providerOperationId === undefined
            ? {}
            : { providerOperationId: input.providerOperationId }),
          updatedAt: input.now,
          version: sql`${orders.version} + 1`,
        })
        .where(eq(orders.id, current.orderId));
      return toPaymentAttemptRecord(updated);
    });
  }

  async findOrder(id: OrderId): Promise<OrderRecord | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    return record === undefined ? undefined : toOrderRecord(record);
  }

  async findAttempt(id: PaymentAttemptId): Promise<PaymentAttemptRecord | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, id))
      .limit(1);
    return record === undefined ? undefined : toPaymentAttemptRecord(record);
  }

  async createRefund(
    input: Parameters<FinancialWorkflowStorePort['createRefund']>[0],
  ): Promise<{ id: RefundId; status: 'created'; amountBaseUnits: BaseUnitAmount }> {
    return this.uow.transaction(async () => {
      const [order] = await this.uow
        .current()
        .select()
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for('update')
        .limit(1);
      if (order === undefined || order.merchantId !== input.merchantId) {
        throw new AppError('NOT_FOUND', 'The order was not found.');
      }
      if (
        !['paid', 'partially_refunded'].includes(order.status) ||
        input.now > order.refundableUntil
      ) {
        throw new AppError('REFUND_NOT_ALLOWED', 'This order is outside its refund window.');
      }
      const [reserved] = await this.uow
        .current()
        .select({ amount: sql<string>`coalesce(sum(${refunds.amountBaseUnits}), 0)::text` })
        .from(refunds)
        .where(
          and(
            eq(refunds.orderId, order.id),
            inArray(refunds.status, [
              'created',
              'prepared',
              'submission_started',
              'submitted',
              'submitted_unknown',
              'confirming',
              'confirmed',
              // Orphaned refund transactions remain reserved until
              // reconciliation confirms re-inclusion or failure.
              'orphaned',
            ]),
          ),
        );
      const remaining = BigInt(order.paidAmountBaseUnits) - BigInt(reserved?.amount ?? '0');
      if (BigInt(input.amountBaseUnits) <= 0n || BigInt(input.amountBaseUnits) > remaining) {
        throw new AppError(
          'REFUND_NOT_ALLOWED',
          'The refund exceeds the remaining refundable amount.',
        );
      }
      const [created] = await this.uow
        .current()
        .insert(refunds)
        .values({
          id: input.id,
          orderId: input.orderId,
          merchantId: input.merchantId,
          requestedByUserId: input.requestedByUserId,
          amountBaseUnits: input.amountBaseUnits,
          status: 'created',
          idempotencyKeyHash: input.idempotencyKeyHash,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      if (created === undefined) {
        const [existing] = await this.uow
          .current()
          .select()
          .from(refunds)
          .where(
            and(
              eq(refunds.merchantId, input.merchantId),
              eq(refunds.idempotencyKeyHash, input.idempotencyKeyHash),
            ),
          )
          .limit(1);
        if (existing === undefined || existing.amountBaseUnits !== input.amountBaseUnits) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'This refund key was already used.');
        }
        return {
          id: RefundIdSchema.parse(existing.id),
          status: 'created',
          amountBaseUnits: BaseUnitAmountSchema.parse(existing.amountBaseUnits),
        };
      }
      return {
        id: RefundIdSchema.parse(created.id),
        status: 'created',
        amountBaseUnits: BaseUnitAmountSchema.parse(created.amountBaseUnits),
      };
    });
  }

  async createWithdrawal(
    input: Parameters<FinancialWorkflowStorePort['createWithdrawal']>[0],
  ): Promise<{ id: WithdrawalId; status: 'created'; amountBaseUnits: BaseUnitAmount }> {
    return this.uow.transaction(async () => {
      await this.uow
        .current()
        .execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${input.merchantId}`}, 0))`,
        );
      const [credit] = await this.uow
        .current()
        .select({
          available: sql<string>`coalesce(sum(${settlementCredits.amountBaseUnits} - ${settlementCredits.withdrawnBaseUnits}), 0)::text`,
        })
        .from(settlementCredits)
        .where(
          and(
            eq(settlementCredits.merchantId, input.merchantId),
            inArray(settlementCredits.status, ['matured', 'withdrawn']),
          ),
        );
      const [pending] = await this.uow
        .current()
        .select({ amount: sql<string>`coalesce(sum(${withdrawals.amountBaseUnits}), 0)::text` })
        .from(withdrawals)
        .where(
          and(
            eq(withdrawals.merchantId, input.merchantId),
            inArray(withdrawals.status, [
              'created',
              'prepared',
              'submission_started',
              'submitted',
              'submitted_unknown',
              'confirming',
              // Confirmed withdrawals are already reflected in the credit's
              // withdrawn amount. An orphaned transaction remains reserved
              // until reconciliation confirms re-inclusion or failure.
              'orphaned',
            ]),
          ),
        );
      const spendable = BigInt(credit?.available ?? '0') - BigInt(pending?.amount ?? '0');
      if (BigInt(input.amountBaseUnits) <= 0n || BigInt(input.amountBaseUnits) > spendable) {
        throw new AppError('WITHDRAWAL_NOT_ALLOWED', 'The withdrawal exceeds the matured balance.');
      }
      const [created] = await this.uow
        .current()
        .insert(withdrawals)
        .values({
          id: input.id,
          merchantId: input.merchantId,
          requestedByUserId: input.requestedByUserId,
          recipient: input.recipient,
          amountBaseUnits: input.amountBaseUnits,
          status: 'created',
          idempotencyKeyHash: input.idempotencyKeyHash,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      if (created === undefined) {
        const [existing] = await this.uow
          .current()
          .select()
          .from(withdrawals)
          .where(
            and(
              eq(withdrawals.merchantId, input.merchantId),
              eq(withdrawals.idempotencyKeyHash, input.idempotencyKeyHash),
            ),
          )
          .limit(1);
        if (
          existing === undefined ||
          existing.amountBaseUnits !== input.amountBaseUnits ||
          existing.recipient.toLowerCase() !== input.recipient.toLowerCase()
        ) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'This withdrawal key was already used.');
        }
        return {
          id: WithdrawalIdSchema.parse(existing.id),
          status: 'created',
          amountBaseUnits: BaseUnitAmountSchema.parse(existing.amountBaseUnits),
        };
      }
      return {
        id: WithdrawalIdSchema.parse(created.id),
        status: 'created',
        amountBaseUnits: BaseUnitAmountSchema.parse(created.amountBaseUnits),
      };
    });
  }
}
