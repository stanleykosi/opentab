import type {
  BackendApiQueryPort,
  CheckoutSnapshotRecord,
  ContractOperationRecord,
  CursorPage,
  CustomerOrderListItem,
  MerchantOrderListItem,
  MerchantSummaryRecord,
  OrderSnapshotRecord,
  PublicProductRecord,
  SplitCapabilityRecord,
} from '@opentab/application';
import {
  AppError,
  BaseUnitAmountSchema,
  BoundOperationTemplateSchema,
  CheckoutSessionIdSchema,
  type CurrentUser,
  type MerchantId,
  MerchantIdSchema,
  type OrderId,
  OrderIdSchema,
  PaymentAttemptIdSchema,
  type Product,
  type ProductId,
  ProductIdSchema,
  SplitIdSchema,
} from '@opentab/shared';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  DrizzleJudgeEvidenceRepository,
  DrizzleMerchantRepository,
  DrizzleProductRepository,
  DrizzleSplitRepository,
} from './repositories.js';
import {
  bootstrapGrants,
  canonicalLogs,
  checkoutSessions,
  contractOperations,
  indexerCursors,
  loyaltyBalances,
  loyaltyPrograms,
  merchants,
  orders,
  paymentAttempts,
  products,
  receipts,
  refunds,
  settlementCredits,
  splitPayments,
  withdrawals,
} from './schema/index.js';
import { PostgresSplitCapabilityStore } from './split-capabilities.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';
import {
  toCheckoutSessionRecord,
  toOrderRecord,
  toPaymentAttemptRecord,
} from './workflow-store.js';

interface CursorPayload {
  readonly createdAt: string;
  readonly id: string;
}

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): CursorPayload | undefined {
  if (value === undefined) return undefined;
  if (value.length < 4 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError('VALIDATION_FAILED', 'The pagination cursor is invalid.');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const record = parsed as Readonly<Record<string, unknown>>;
    if (
      typeof record['createdAt'] !== 'string' ||
      !Number.isFinite(new Date(record['createdAt']).getTime()) ||
      typeof record['id'] !== 'string' ||
      record['id'].length > 128
    ) {
      throw new Error();
    }
    return { createdAt: record['createdAt'], id: record['id'] };
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The pagination cursor is invalid.');
  }
}

function actorMerchantId(actor: CurrentUser, requested?: MerchantId): MerchantId {
  const membership =
    requested === undefined
      ? actor.merchantMemberships[0]
      : actor.merchantMemberships.find((entry) => entry.merchantId === requested);
  if (membership === undefined) {
    throw new AppError('AUTH_FORBIDDEN', 'You are not authorized to access this merchant.');
  }
  return membership.merchantId;
}

function canReadOrder(actor: CurrentUser, order: { userId: string; merchantId: string }): boolean {
  return (
    order.userId === actor.id ||
    actor.merchantMemberships.some((entry) => entry.merchantId === order.merchantId)
  );
}

function toContractOperationRecord(
  operation: typeof contractOperations.$inferSelect,
): ContractOperationRecord {
  return {
    id: operation.id,
    kind: operation.kind as ContractOperationRecord['kind'],
    aggregateType: operation.aggregateType as ContractOperationRecord['aggregateType'],
    aggregateId: operation.aggregateId,
    binding: operation.binding,
    template: BoundOperationTemplateSchema.parse(operation.template),
    bindingDigest: operation.bindingDigest,
    status: operation.status as ContractOperationRecord['status'],
    ...(operation.providerOperationId === null
      ? {}
      : { providerOperationId: operation.providerOperationId }),
    ...(operation.transactionHash === null ? {} : { transactionHash: operation.transactionHash }),
    ...(operation.canonicalEventName === null
      ? {}
      : { canonicalEventName: operation.canonicalEventName }),
    expiresAt: operation.expiresAt.toISOString(),
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

export class PostgresBackendApiQueryStore implements BackendApiQueryPort {
  readonly #merchants: DrizzleMerchantRepository;
  readonly #products: DrizzleProductRepository;
  readonly #splits: DrizzleSplitRepository;
  readonly #capabilities: PostgresSplitCapabilityStore;
  readonly #judge: DrizzleJudgeEvidenceRepository;

  constructor(
    private readonly uow: PostgresUnitOfWork,
    capabilityPepper: string,
    judgeShareTokenPepper?: string,
    liveAcceptanceAttestationSecret?: string,
    liveAcceptanceDeploymentConfigDigest?: string,
  ) {
    this.#merchants = new DrizzleMerchantRepository(uow);
    this.#products = new DrizzleProductRepository(uow);
    this.#splits = new DrizzleSplitRepository(uow);
    this.#capabilities = new PostgresSplitCapabilityStore(uow, capabilityPepper);
    this.#judge = new DrizzleJudgeEvidenceRepository(
      uow,
      judgeShareTokenPepper,
      liveAcceptanceAttestationSecret,
      liveAcceptanceDeploymentConfigDigest,
    );
  }

  async getMerchantCatalog(slug: string) {
    const [record] = await this.uow
      .current()
      .select({ id: merchants.id, updatedAt: merchants.updatedAt })
      .from(merchants)
      .where(and(eq(merchants.slug, slug), eq(merchants.status, 'active')))
      .limit(1);
    if (record === undefined) return undefined;
    const merchant = await this.#merchants.findById(MerchantIdSchema.parse(record.id));
    if (merchant === undefined) return undefined;
    const rows = await this.uow
      .current()
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.merchantId, merchant.id),
          inArray(products.status, ['scheduled', 'active', 'sold_out', 'ended']),
        ),
      )
      .orderBy(asc(products.startsAt), asc(products.id))
      .limit(1_000);
    const catalog: Product[] = [];
    for (const row of rows) {
      const product = await this.#products.findById(ProductIdSchema.parse(row.id));
      if (product !== undefined) catalog.push(product);
    }
    return { merchant, products: catalog, observedAt: record.updatedAt.toISOString() };
  }

  async getPublicProductById(productId: ProductId): Promise<PublicProductRecord | undefined> {
    const product = await this.#products.findById(productId);
    if (product === undefined || product.status === 'draft' || product.status === 'archived') {
      return undefined;
    }
    const merchant = await this.#merchants.findById(product.merchantId);
    if (merchant === undefined || merchant.status !== 'active') return undefined;
    const [projection] = await this.uow
      .current()
      .select({ sync: products.chainSyncStatus, observedAt: products.updatedAt })
      .from(products)
      .where(eq(products.id, product.id))
      .limit(1);
    if (projection === undefined) return undefined;
    return {
      merchant,
      product,
      availabilityObservedAt: projection.observedAt.toISOString(),
      projectionStale: projection.sync !== 'confirmed',
    };
  }

  async getPublicProductBySlugs(
    merchantSlug: string,
    productSlug: string,
  ): Promise<PublicProductRecord | undefined> {
    const [record] = await this.uow
      .current()
      .select({ productId: products.id })
      .from(products)
      .innerJoin(merchants, eq(merchants.id, products.merchantId))
      .where(and(eq(merchants.slug, merchantSlug), eq(products.slug, productSlug)))
      .limit(1);
    return record === undefined
      ? undefined
      : this.getPublicProductById(ProductIdSchema.parse(record.productId));
  }

  async getPassMetadataProduct(productId: ProductId) {
    const product = await this.#products.findById(productId);
    if (product === undefined) return undefined;
    const [projection] = await this.uow
      .current()
      .select({
        onchainProductId: products.onchainProductId,
        chainSyncStatus: products.chainSyncStatus,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (
      projection === undefined ||
      projection.onchainProductId === null ||
      projection.chainSyncStatus !== 'confirmed'
    ) {
      return undefined;
    }
    const merchant = await this.#merchants.findById(product.merchantId);
    return merchant === undefined ? undefined : { product, merchant };
  }

  async getCheckoutForActor(
    checkoutSessionId: string,
    actor?: CurrentUser,
  ): Promise<CheckoutSnapshotRecord | undefined> {
    const id = CheckoutSessionIdSchema.parse(checkoutSessionId);
    const [session] = await this.uow
      .current()
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, id))
      .limit(1);
    if (session === undefined) return undefined;
    if (session.userId !== null && session.userId !== actor?.id) return undefined;
    const [order] = await this.uow
      .current()
      .select()
      .from(orders)
      .where(eq(orders.checkoutSessionId, id))
      .limit(1);
    const [attempt] =
      order === undefined
        ? [undefined]
        : await this.uow
            .current()
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.orderId, order.id))
            .orderBy(desc(paymentAttempts.attemptNumber))
            .limit(1);
    return {
      session: toCheckoutSessionRecord(session),
      ...(order === undefined ? {} : { order: toOrderRecord(order) }),
      ...(attempt === undefined ? {} : { attempt: toPaymentAttemptRecord(attempt) }),
    };
  }

  async getAttemptForActor(paymentAttemptId: string, actor: CurrentUser) {
    const id = PaymentAttemptIdSchema.parse(paymentAttemptId);
    const [record] = await this.uow
      .current()
      .select({ attempt: paymentAttempts, order: orders })
      .from(paymentAttempts)
      .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
      .where(eq(paymentAttempts.id, id))
      .limit(1);
    if (record === undefined || !canReadOrder(actor, record.order)) return undefined;
    return toPaymentAttemptRecord(record.attempt);
  }

  async getPaymentWorkflowForActor(paymentAttemptId: string, actor: CurrentUser) {
    const id = PaymentAttemptIdSchema.parse(paymentAttemptId);
    const [record] = await this.uow
      .current()
      .select({ attempt: paymentAttempts, order: orders })
      .from(paymentAttempts)
      .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
      .where(eq(paymentAttempts.id, id))
      .limit(1);
    if (record === undefined || !canReadOrder(actor, record.order)) return undefined;
    const [receipt] = await this.uow
      .current()
      .select({ status: receipts.status, tokenId: receipts.tokenId })
      .from(receipts)
      .where(eq(receipts.orderId, record.order.id))
      .limit(1);
    const [canonical] =
      record.order.transactionHash === null || record.order.logIndex === null
        ? [undefined]
        : await this.uow
            .current()
            .select({
              eventName: canonicalLogs.eventName,
              chainId: canonicalLogs.chainId,
              stream: canonicalLogs.stream,
              transactionHash: canonicalLogs.transactionHash,
              blockNumber: canonicalLogs.blockNumber,
              blockHash: canonicalLogs.blockHash,
              logIndex: canonicalLogs.logIndex,
              decodedPayload: canonicalLogs.decodedPayload,
              observedAt: canonicalLogs.observedAt,
            })
            .from(canonicalLogs)
            .where(
              and(
                eq(canonicalLogs.transactionHash, record.order.transactionHash),
                eq(canonicalLogs.logIndex, record.order.logIndex),
                eq(canonicalLogs.eventName, 'OrderPaid'),
                eq(canonicalLogs.canonical, true),
              ),
            )
            .limit(1);
    const [cursor] =
      canonical === undefined
        ? [undefined]
        : await this.uow
            .current()
            .select({ confirmationDepth: indexerCursors.confirmationDepth })
            .from(indexerCursors)
            .where(
              and(
                eq(indexerCursors.chainId, canonical.chainId),
                eq(indexerCursors.stream, canonical.stream),
              ),
            )
            .limit(1);
    const confirmations =
      canonical !== undefined &&
      typeof canonical.decodedPayload === 'object' &&
      canonical.decodedPayload !== null &&
      typeof canonical.decodedPayload['confirmations'] === 'string'
        ? canonical.decodedPayload['confirmations']
        : '0';
    return {
      attempt: toPaymentAttemptRecord(record.attempt),
      order: toOrderRecord(record.order),
      ...(receipt === undefined
        ? {}
        : {
            receipt: {
              status: receipt.status,
              ...(receipt.tokenId === null ? {} : { tokenId: receipt.tokenId }),
            },
          }),
      ...(canonical === undefined || cursor === undefined
        ? {}
        : {
            canonicalOrderPaid: {
              eventName: 'OrderPaid' as const,
              canonical: true as const,
              transactionHash: canonical.transactionHash,
              blockNumber: canonical.blockNumber.toString(),
              blockHash: canonical.blockHash,
              logIndex: canonical.logIndex.toString(),
              confirmations,
              requiredConfirmations: cursor.confirmationDepth.toString(),
              observedAt: canonical.observedAt.toISOString(),
            },
          }),
    };
  }

  async getOrderForActor(
    orderId: OrderId,
    actor: CurrentUser,
  ): Promise<OrderSnapshotRecord | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (record === undefined || !canReadOrder(actor, record)) return undefined;
    const [merchant, product] = await Promise.all([
      this.#merchants.findById(MerchantIdSchema.parse(record.merchantId)),
      this.#products.findById(ProductIdSchema.parse(record.productId)),
    ]);
    if (merchant === undefined || product === undefined) return undefined;
    const [[attempt], [receipt]] = await Promise.all([
      this.uow
        .current()
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, orderId))
        .orderBy(desc(paymentAttempts.attemptNumber))
        .limit(1),
      this.uow.current().select().from(receipts).where(eq(receipts.orderId, orderId)).limit(1),
    ]);
    const merchantActor = actor.merchantMemberships.some(
      (entry) => entry.merchantId === record.merchantId,
    );
    const [pendingRefund] = merchantActor
      ? await this.uow
          .current()
          .select()
          .from(refunds)
          .where(
            and(
              eq(refunds.orderId, orderId),
              inArray(refunds.status, [
                'created',
                'prepared',
                'submission_started',
                'submitted',
                'submitted_unknown',
                'confirming',
              ]),
            ),
          )
          .orderBy(desc(refunds.createdAt))
          .limit(1)
      : [undefined];
    const [refundOperation] =
      pendingRefund === undefined
        ? [undefined]
        : await this.uow
            .current()
            .select()
            .from(contractOperations)
            .where(
              and(
                eq(contractOperations.aggregateType, 'refund'),
                eq(contractOperations.aggregateId, pendingRefund.id),
                eq(contractOperations.actorUserId, actor.id),
              ),
            )
            .orderBy(desc(contractOperations.createdAt))
            .limit(1);
    return {
      order: toOrderRecord(record),
      merchant,
      product,
      ...(attempt === undefined ? {} : { attempt: toPaymentAttemptRecord(attempt) }),
      ...(receipt === undefined
        ? {}
        : {
            receipt: {
              status: receipt.status,
              ...(receipt.tokenId === null ? {} : { tokenId: receipt.tokenId }),
            },
          }),
      ...(pendingRefund === undefined
        ? {}
        : {
            pendingRefund: {
              id: pendingRefund.id,
              orderId: pendingRefund.orderId,
              amountBaseUnits: pendingRefund.amountBaseUnits,
              status: pendingRefund.status,
              ...(pendingRefund.providerOperationId === null
                ? {}
                : { providerOperationId: pendingRefund.providerOperationId }),
              createdAt: pendingRefund.createdAt.toISOString(),
              updatedAt: pendingRefund.updatedAt.toISOString(),
            },
          }),
      ...(refundOperation === undefined
        ? {}
        : { refundOperation: toContractOperationRecord(refundOperation) }),
    };
  }

  async getMerchantSummary(
    actor: CurrentUser,
    requestedMerchantId?: MerchantId,
  ): Promise<MerchantSummaryRecord | undefined> {
    const merchantId = actorMerchantId(actor, requestedMerchantId);
    const merchant = await this.#merchants.findById(merchantId);
    if (merchant === undefined) return undefined;
    const [[orderTotals], [creditTotals], [withdrawalTotals], [loyaltyTotals]] = await Promise.all([
      this.uow
        .current()
        .select({
          gross: sql<string>`coalesce(sum(${orders.paidAmountBaseUnits}), 0)::text`,
          refunded: sql<string>`coalesce(sum(${orders.refundedAmountBaseUnits}), 0)::text`,
          pending: sql<string>`coalesce(sum(case when ${orders.status} in ('submitted','executing') then ${orders.amountBaseUnits} else 0 end), 0)::text`,
        })
        .from(orders)
        .where(eq(orders.merchantId, merchantId)),
      this.uow
        .current()
        .select({
          available: sql<string>`coalesce(sum(${settlementCredits.amountBaseUnits} - ${settlementCredits.withdrawnBaseUnits}), 0)::text`,
        })
        .from(settlementCredits)
        .where(
          and(
            eq(settlementCredits.merchantId, merchantId),
            inArray(settlementCredits.status, ['matured', 'withdrawn']),
          ),
        ),
      this.uow
        .current()
        .select({ amount: sql<string>`coalesce(sum(${withdrawals.amountBaseUnits}), 0)::text` })
        .from(withdrawals)
        .where(and(eq(withdrawals.merchantId, merchantId), eq(withdrawals.status, 'confirmed'))),
      this.uow
        .current()
        .select({ count: sql<string>`count(distinct ${loyaltyBalances.userId})::text` })
        .from(loyaltyBalances)
        .innerJoin(loyaltyPrograms, eq(loyaltyPrograms.id, loyaltyBalances.programId))
        .where(eq(loyaltyPrograms.merchantId, merchantId)),
    ]);
    return {
      merchant,
      grossBaseUnits: BaseUnitAmountSchema.parse(orderTotals?.gross ?? '0'),
      refundedBaseUnits: BaseUnitAmountSchema.parse(orderTotals?.refunded ?? '0'),
      pendingBaseUnits: BaseUnitAmountSchema.parse(orderTotals?.pending ?? '0'),
      withdrawableBaseUnits: BaseUnitAmountSchema.parse(creditTotals?.available ?? '0'),
      withdrawnBaseUnits: BaseUnitAmountSchema.parse(withdrawalTotals?.amount ?? '0'),
      loyaltyMembers: BaseUnitAmountSchema.parse(loyaltyTotals?.count ?? '0'),
      observedAt: merchant.updatedAt,
    };
  }

  async listMerchantOrders(input: {
    actor: CurrentUser;
    merchantId?: MerchantId;
    cursor?: string;
    limit: number;
    status?: ReturnType<typeof toOrderRecord>['status'];
    productId?: ProductId;
  }): Promise<CursorPage<MerchantOrderListItem>> {
    const merchantId = actorMerchantId(input.actor, input.merchantId);
    const cursor = decodeCursor(input.cursor);
    const predicates = [eq(orders.merchantId, merchantId)];
    if (input.status !== undefined) predicates.push(eq(orders.status, input.status));
    if (input.productId !== undefined) predicates.push(eq(orders.productId, input.productId));
    if (cursor !== undefined) {
      const at = new Date(cursor.createdAt);
      const pagePredicate = or(
        lt(orders.createdAt, at),
        and(eq(orders.createdAt, at), lt(orders.id, cursor.id)),
      );
      if (pagePredicate !== undefined) predicates.push(pagePredicate);
    }
    const rows = await this.uow
      .current()
      .select({ order: orders, productTitle: products.title })
      .from(orders)
      .innerJoin(products, eq(products.id, orders.productId))
      .where(and(...predicates))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        order: toOrderRecord(row.order),
        productTitle: row.productTitle,
      })),
      ...(hasMore && last !== undefined
        ? {
            nextCursor: encodeCursor({
              createdAt: last.order.createdAt.toISOString(),
              id: last.order.id,
            }),
          }
        : {}),
    };
  }

  async listCustomerOrders(input: {
    actor: CurrentUser;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<CustomerOrderListItem>> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new AppError('VALIDATION_FAILED', 'The order page size is invalid.');
    }
    const cursor = decodeCursor(input.cursor);
    const predicates = [eq(orders.userId, input.actor.id)];
    if (cursor !== undefined) {
      const at = new Date(cursor.createdAt);
      const pagePredicate = or(
        lt(orders.createdAt, at),
        and(eq(orders.createdAt, at), lt(orders.id, cursor.id)),
      );
      if (pagePredicate !== undefined) predicates.push(pagePredicate);
    }
    const rows = await this.uow
      .current()
      .select({
        order: orders,
        merchantDisplayName: merchants.displayName,
        merchantSlug: merchants.slug,
        productId: products.id,
      })
      .from(orders)
      .innerJoin(merchants, eq(merchants.id, orders.merchantId))
      .innerJoin(products, eq(products.id, orders.productId))
      .where(and(...predicates))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const items: CustomerOrderListItem[] = [];
    for (const row of page) {
      const product = await this.#products.findById(ProductIdSchema.parse(row.productId));
      if (product !== undefined) {
        items.push({
          order: toOrderRecord(row.order),
          merchantDisplayName: row.merchantDisplayName,
          merchantSlug: row.merchantSlug,
          product,
        });
      }
    }
    const last = page.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined
        ? {
            nextCursor: encodeCursor({
              createdAt: last.order.createdAt.toISOString(),
              id: last.order.id,
            }),
          }
        : {}),
    };
  }

  async getMerchantProductForActor(input: { actor: CurrentUser; productId: ProductId }) {
    const [row] = await this.uow
      .current()
      .select({
        merchantId: products.merchantId,
        version: products.version,
        chainSyncStatus: products.chainSyncStatus,
      })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    if (
      row === undefined ||
      !input.actor.merchantMemberships.some((entry) => entry.merchantId === row.merchantId)
    ) {
      return undefined;
    }
    const product = await this.#products.findById(input.productId);
    const [operation] = await this.uow
      .current()
      .select()
      .from(contractOperations)
      .where(
        and(
          eq(contractOperations.aggregateType, 'product'),
          eq(contractOperations.aggregateId, input.productId),
          eq(contractOperations.actorUserId, input.actor.id),
        ),
      )
      .orderBy(desc(contractOperations.createdAt))
      .limit(1);
    return product === undefined
      ? undefined
      : {
          product,
          optimisticVersion: row.version.toString(),
          chainSyncStatus: row.chainSyncStatus,
          ...(operation === undefined
            ? {}
            : {
                operation: {
                  ...toContractOperationRecord(operation),
                },
              }),
        };
  }

  async listMerchantProducts(input: {
    actor: CurrentUser;
    merchantId?: MerchantId;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<Product>> {
    const merchantId = actorMerchantId(input.actor, input.merchantId);
    const cursor = decodeCursor(input.cursor);
    const predicates = [eq(products.merchantId, merchantId)];
    if (cursor !== undefined) {
      const at = new Date(cursor.createdAt);
      const pagePredicate = or(
        lt(products.createdAt, at),
        and(eq(products.createdAt, at), lt(products.id, cursor.id)),
      );
      if (pagePredicate !== undefined) predicates.push(pagePredicate);
    }
    const rows = await this.uow
      .current()
      .select({ id: products.id, createdAt: products.createdAt })
      .from(products)
      .where(and(...predicates))
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const items: Product[] = [];
    for (const row of page) {
      const product = await this.#products.findById(ProductIdSchema.parse(row.id));
      if (product !== undefined) items.push(product);
    }
    const last = page.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) }
        : {}),
    };
  }

  async getSplitByCapability(
    reference: string,
    now: Date,
    actor?: CurrentUser,
  ): Promise<SplitCapabilityRecord | undefined> {
    const separator = reference.indexOf('.');
    if (separator < 1 || separator === reference.length - 1) return undefined;
    const invitationId = reference.slice(0, separator);
    const capabilityToken = reference.slice(separator + 1);
    try {
      const invitation = await this.#capabilities.resolve({ invitationId, capabilityToken, now });
      const split = await this.#splits.findById(SplitIdSchema.parse(invitation.splitId));
      if (split === undefined) return undefined;
      const [payment] =
        actor === undefined
          ? [undefined]
          : await this.uow
              .current()
              .select()
              .from(splitPayments)
              .where(
                and(
                  eq(splitPayments.invitationId, invitation.id),
                  eq(splitPayments.payerUserId, actor.id),
                ),
              )
              .limit(1);
      const [operation] =
        payment === undefined
          ? [undefined]
          : await this.uow
              .current()
              .select()
              .from(contractOperations)
              .where(
                and(
                  eq(contractOperations.aggregateType, 'split_payment'),
                  eq(contractOperations.aggregateId, payment.id),
                  eq(contractOperations.actorUserId, actor?.id ?? ''),
                ),
              )
              .orderBy(desc(contractOperations.createdAt))
              .limit(1);
      return {
        split,
        invitation,
        ...(payment === undefined
          ? {}
          : {
              existingPayment: {
                id: payment.id,
                splitId: payment.splitId,
                invitationId: payment.invitationId,
                amountBaseUnits: payment.amountBaseUnits,
                status: payment.status,
                ...(payment.providerOperationId === null
                  ? {}
                  : { providerOperationId: payment.providerOperationId }),
                ...(payment.transactionHash === null
                  ? {}
                  : { transactionHash: payment.transactionHash }),
                createdAt: payment.createdAt.toISOString(),
                updatedAt: payment.updatedAt.toISOString(),
              },
            }),
        ...(operation === undefined ? {} : { operation: toContractOperationRecord(operation) }),
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  getJudgeProof(orderId: OrderId, shareToken?: string) {
    return this.#judge.getPublicProof(OrderIdSchema.parse(orderId), shareToken);
  }

  async getSponsorGrantForActor(id: string, actor: CurrentUser) {
    const [record] = await this.uow
      .current()
      .select()
      .from(bootstrapGrants)
      .where(and(eq(bootstrapGrants.id, id), eq(bootstrapGrants.userId, actor.id)))
      .limit(1);
    if (record === undefined) return undefined;
    return {
      id: record.id,
      userId: record.userId,
      recipient: record.recipientAddressLower as CurrentUser['walletAddress'],
      amountWei: BaseUnitAmountSchema.parse(record.amountWei),
      status: record.status,
      ...(record.transactionHash === null ? {} : { transactionHash: record.transactionHash }),
      createdAt: record.createdAt.toISOString(),
    };
  }
}
