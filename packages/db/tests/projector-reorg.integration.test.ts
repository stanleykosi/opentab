import { fileURLToPath } from 'node:url';
import { ChainIdSchema } from '@opentab/shared';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { PostgresIndexerStore } from '../src/indexer-store.js';
import { PostgresCanonicalProjector } from '../src/projectors.js';
import {
  canonicalLogs,
  checkoutSessions,
  indexedBlocks,
  indexerCursors,
  loyaltyAwards,
  loyaltyBalances,
  loyaltyPrograms,
  merchants,
  orders,
  paymentAttempts,
  products,
  receipts,
  refunds,
  settlementCredits,
  signedOrderIntents,
  splitInvitations,
  splitParticipants,
  splitPayments,
  splits,
  users,
  withdrawals,
} from '../src/schema/index.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';
import { PostgresWorkflowStore } from '../src/workflow-store.js';

const databaseUrl = process.env['DATABASE_URL_TEST'];
const chainId = ChainIdSchema.parse('42161');
const checkoutAddress = address(90_001);
const passAddress = address(90_002);
const splitAddress = address(90_003);
const tokenAddress = address(90_004);
const zeroAddress = address(0);
const refundDeadline = new Date('2030-01-01T00:00:00.000Z');

function address(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(40, '0')}`;
}

function bytes32(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function observedAt(blockNumber: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, blockNumber));
}

interface SeededPaidOrder {
  readonly stream: string;
  readonly userId: string;
  readonly merchantId: string;
  readonly productId: string;
  readonly orderId: string;
  readonly attemptId: string;
  readonly orderKey: `0x${string}`;
  readonly intentDigest: `0x${string}`;
  readonly payer: `0x${string}`;
  readonly payout: `0x${string}`;
  readonly paymentTransactionHash: `0x${string}`;
  readonly paymentLogId: string;
  readonly merchantOnchainId: string;
  readonly productOnchainId: string;
}

let handle: DatabaseHandle | undefined;
let uow: PostgresUnitOfWork;
let store: PostgresIndexerStore;

async function addCanonicalLog(input: {
  seed: number;
  stream: string;
  eventName: string;
  fields: Readonly<Record<string, string>>;
  blockNumber: number;
  logIndex: number;
  transactionHash?: `0x${string}`;
  contractAddress?: `0x${string}`;
}): Promise<{ id: string; transactionHash: `0x${string}` }> {
  const transactionHash =
    input.transactionHash ??
    bytes32(input.seed * 10_000 + input.blockNumber * 100 + input.logIndex);
  const [record] = await uow
    .current()
    .insert(canonicalLogs)
    .values({
      chainId,
      stream: input.stream,
      contractAddress: input.contractAddress ?? checkoutAddress,
      eventName: input.eventName,
      transactionHash,
      blockNumber: BigInt(input.blockNumber),
      blockHash: bytes32(input.seed * 100 + input.blockNumber),
      logIndex: input.logIndex,
      canonical: true,
      decodedPayload: {
        decoderVersion: 'projector-reorg-test-v3',
        fields: { ...input.fields },
        confirmations: '3',
      },
      payloadDigest: bytes32(input.seed * 100 + input.logIndex + 50),
      projectionStatus: 'applied',
      observedAt: observedAt(input.blockNumber),
      projectedAt: observedAt(input.blockNumber),
      createdAt: observedAt(input.blockNumber),
    })
    .returning({ id: canonicalLogs.id });
  if (record === undefined) throw new Error('Failed to seed canonical log');
  return { id: record.id, transactionHash };
}

async function seedCursor(seed: number, stream: string): Promise<void> {
  await uow
    .current()
    .insert(indexedBlocks)
    .values([
      {
        chainId,
        stream,
        blockNumber: 9n,
        blockHash: bytes32(seed * 1000 + 9),
        parentHash: bytes32(seed * 1000 + 8),
        canonical: true,
        observedAt: observedAt(9),
      },
      {
        chainId,
        stream,
        blockNumber: 12n,
        blockHash: bytes32(seed * 1000 + 12),
        parentHash: bytes32(seed * 1000 + 11),
        canonical: true,
        observedAt: observedAt(12),
      },
    ]);
  await uow
    .current()
    .insert(indexerCursors)
    .values({
      chainId,
      stream,
      nextBlock: 13n,
      lastProcessedBlock: 12n,
      lastProcessedBlockHash: bytes32(seed * 1000 + 12),
      confirmationDepth: 2,
    });
}

async function seedPaidOrder(input: {
  seed: number;
  stream: string;
  paymentBlock: number;
}): Promise<SeededPaidOrder> {
  const suffix = input.seed.toString();
  const userId = `usr_reorg_${suffix}`;
  const merchantId = `mrc_reorg_${suffix}`;
  const productId = `prd_reorg_${suffix}`;
  const checkoutSessionId = `chk_reorg_${suffix}`;
  const orderId = `ord_reorg_${suffix}`;
  const attemptId = `pay_reorg_${suffix}`;
  const orderKey = bytes32(input.seed * 1000 + 1);
  const intentDigest = bytes32(input.seed * 1000 + 2);
  const payer = address(input.seed * 10 + 1);
  const payout = address(input.seed * 10 + 2);
  const merchantOnchainId = (input.seed * 10 + 1).toString();
  const productOnchainId = (input.seed * 10 + 2).toString();
  const paymentTransactionHash = bytes32(input.seed * 1000 + 3);
  const metadataHash = bytes32(input.seed * 1000 + 4);
  const bindingDigest = intentDigest;

  await uow
    .current()
    .insert(users)
    .values({
      id: userId,
      magicIssuerHash: bytes32(input.seed * 1000 + 5),
      walletAddressChecksum: payer,
      walletAddressLower: payer.toLowerCase(),
    });
  await uow
    .current()
    .insert(merchants)
    .values({
      id: merchantId,
      onchainMerchantId: merchantOnchainId,
      ownerUserId: userId,
      slug: `merchant-${suffix}`,
      displayName: `Merchant ${suffix}`,
      payoutAddress: payout,
      payoutAddressLower: payout.toLowerCase(),
      status: 'active',
      chainSyncStatus: 'confirmed',
    });
  await uow
    .current()
    .insert(products)
    .values({
      id: productId,
      merchantId,
      onchainProductId: productOnchainId,
      slug: `product-${suffix}`,
      title: `Product ${suffix}`,
      description: 'Reorg fixture',
      unitPriceBaseUnits: '1000',
      maxSupply: '100',
      sold: '1',
      maxPerOrder: '10',
      startsAt: new Date('2025-01-01T00:00:00.000Z'),
      refundWindowSeconds: '3600',
      loyaltyPoints: '100',
      metadataHash,
      status: 'active',
      chainSyncStatus: 'confirmed',
    });
  await uow
    .current()
    .insert(checkoutSessions)
    .values({
      id: checkoutSessionId,
      userId,
      productId,
      productVersion: 1,
      quantity: '1',
      receiptRecipient: payer,
      amountBaseUnits: '1000',
      orderKey,
      status: 'consumed',
      expiresAt: new Date('2029-01-01T00:00:00.000Z'),
      bindingDigest,
      boundAt: new Date('2026-01-01T00:00:00.000Z'),
      consumedAt: observedAt(input.paymentBlock),
    });
  await uow
    .current()
    .insert(signedOrderIntents)
    .values({
      checkoutSessionId,
      orderKey,
      digest: intentDigest,
      signerAddress: address(input.seed * 10 + 3),
      signerKeyId: 'test-order-key',
      intent: { platformFeeBaseUnits: '100' },
      signature: `0x${'11'.repeat(65)}`,
      validAfter: new Date('2026-01-01T00:00:00.000Z'),
      validUntil: new Date('2029-01-01T00:00:00.000Z'),
      refundableUntil: refundDeadline,
    });
  await uow
    .current()
    .insert(orders)
    .values({
      id: orderId,
      checkoutSessionId,
      orderKey,
      userId,
      merchantId,
      productId,
      payer,
      recipient: payer,
      tokenAddress,
      quantity: '1',
      amountBaseUnits: '1000',
      paidAmountBaseUnits: '1000',
      refundedAmountBaseUnits: '0',
      status: 'paid',
      chainId,
      transactionHash: paymentTransactionHash,
      blockNumber: BigInt(input.paymentBlock),
      blockHash: bytes32(input.seed * 100 + input.paymentBlock),
      logIndex: 3,
      intentDigest,
      refundableUntil: refundDeadline,
      confirmedAt: observedAt(input.paymentBlock),
    });
  await uow
    .current()
    .insert(paymentAttempts)
    .values({
      id: attemptId,
      orderId,
      checkoutSessionId,
      attemptNumber: 1,
      status: 'paid',
      bindingDigest,
      destinationTransactionHash: paymentTransactionHash,
      submissionStartedAt: observedAt(input.paymentBlock - 1),
      submittedAt: observedAt(input.paymentBlock - 1),
      terminalAt: observedAt(input.paymentBlock),
    });
  const payment = await addCanonicalLog({
    seed: input.seed,
    stream: input.stream,
    eventName: 'OrderPaid',
    blockNumber: input.paymentBlock,
    logIndex: 3,
    transactionHash: paymentTransactionHash,
    fields: {
      orderKey,
      merchantId: merchantOnchainId,
      productId: productOnchainId,
      payer,
      recipient: payer,
      token: tokenAddress,
      quantity: '1',
      amount: '1000',
      platformFee: '100',
      passTokenId: productOnchainId,
      refundDeadline: (BigInt(refundDeadline.getTime()) / 1000n).toString(),
      intentDigest,
    },
  });
  await uow
    .current()
    .insert(settlementCredits)
    .values({
      merchantId,
      orderId,
      amountBaseUnits: '900',
      withdrawnBaseUnits: '0',
      status: 'refundable',
      maturesAt: refundDeadline,
      createdAt: observedAt(input.paymentBlock),
      updatedAt: observedAt(input.paymentBlock),
    });
  await uow
    .current()
    .insert(receipts)
    .values({
      id: `rcp_reorg_${suffix}`,
      orderId,
      tokenId: productOnchainId,
      metadataHash,
      status: 'expected',
      chainEventId: payment.id,
      createdAt: observedAt(input.paymentBlock),
      updatedAt: observedAt(input.paymentBlock),
    });
  await seedCursor(input.seed, input.stream);
  return {
    stream: input.stream,
    userId,
    merchantId,
    productId,
    orderId,
    attemptId,
    orderKey,
    intentDigest,
    payer,
    payout,
    paymentTransactionHash,
    paymentLogId: payment.id,
    merchantOnchainId,
    productOnchainId,
  };
}

async function rewind(seed: number, stream: string): Promise<void> {
  await store.rewind({
    cursor: {
      chainId,
      stream,
      nextBlock: 13n,
      lastProcessedBlock: 12n,
      lastProcessedBlockHash: bytes32(seed * 1000 + 12),
      confirmationDepth: 2,
    },
    details: {
      detectedAtBlock: 12n,
      commonAncestorBlock: 9n,
      oldHeadHash: bytes32(seed * 1000 + 12),
      newHeadHash: bytes32(seed * 1000 + 99),
    },
    now: new Date('2026-02-01T00:00:00.000Z'),
  });
}

async function cleanupReorgFixtures(): Promise<void> {
  const statements = [
    sql`delete from split_payments where split_id like 'spl_reorg_%'`,
    sql`delete from split_invitations where split_id like 'spl_reorg_%'`,
    sql`delete from split_participants where split_id like 'spl_reorg_%'`,
    sql`delete from splits where id like 'spl_reorg_%'`,
    sql`delete from loyalty_awards where order_id like 'ord_reorg_%'`,
    sql`delete from loyalty_balances where program_id in (
      select id from loyalty_programs where merchant_id like 'mrc_reorg_%'
    )`,
    sql`delete from loyalty_programs where merchant_id like 'mrc_reorg_%'`,
    sql`delete from withdrawals where merchant_id like 'mrc_reorg_%'`,
    sql`delete from refunds where order_id like 'ord_reorg_%'`,
    sql`delete from receipts where order_id like 'ord_reorg_%'`,
    sql`delete from settlement_credits where order_id like 'ord_reorg_%'`,
    sql`delete from canonical_logs
      where stream like '%-reorg'
        or stream in ('order-paid-projector', 'sequential-withdrawals')`,
    sql`delete from indexer_cursors
      where stream like '%-reorg'
        or stream in ('order-paid-projector', 'sequential-withdrawals')`,
    sql`delete from indexed_blocks
      where stream like '%-reorg'
        or stream in ('order-paid-projector', 'sequential-withdrawals')`,
    sql`delete from payment_attempts where order_id like 'ord_reorg_%'`,
    sql`delete from orders where id like 'ord_reorg_%'`,
    sql`delete from signed_order_intents where checkout_session_id like 'chk_reorg_%'`,
    sql`delete from checkout_sessions where id like 'chk_reorg_%'`,
    sql`delete from products where id like 'prd_reorg_%'`,
    sql`delete from merchants where id like 'mrc_reorg_%'`,
    sql`delete from users where id like 'usr_reorg_%'`,
  ];
  for (const statement of statements) await uow.current().execute(statement);
}

describe.skipIf(databaseUrl === undefined)('canonical projector reorg reconstruction', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({ url: databaseUrl, applicationName: 'projector-reorg-tests' });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    uow = new PostgresUnitOfWork(handle.db);
    store = new PostgresIndexerStore(uow);
    await cleanupReorgFixtures();
  }, 30_000);

  afterAll(async () => {
    if (handle !== undefined) await cleanupReorgFixtures();
    await handle?.close();
  });

  it('applies the descriptive canonical-safety migration as validated constraints/indexes', async () => {
    const constraints = await uow.current().execute<{ name: string; validated: boolean }>(sql`
      select conname as name, convalidated as validated
      from pg_constraint
      where conname = 'split_payments_paid_proof_check'
    `);
    const indexes = await uow.current().execute<{ name: string; unique_index: boolean }>(sql`
      select indexrelid::regclass::text as name, indisunique as unique_index
      from pg_index
      where indexrelid::regclass::text in (
        'receipts_token_idx',
        'canonical_logs_one_canonical_identity_unique',
        'payment_attempts_one_active_per_order_unique',
        'bootstrap_grants_one_recipient_unique'
      )
    `);
    expect(constraints).toEqual([{ name: 'split_payments_paid_proof_check', validated: true }]);
    expect(indexes).toEqual(
      expect.arrayContaining([
        { name: 'receipts_token_idx', unique_index: false },
        { name: 'canonical_logs_one_canonical_identity_unique', unique_index: true },
        { name: 'payment_attempts_one_active_per_order_unique', unique_index: true },
        { name: 'bootstrap_grants_one_recipient_unique', unique_index: true },
      ]),
    );
  });

  it('projects a fully bound OrderPaid event and no earlier workflow state can declare success', async () => {
    const fixture = await seedPaidOrder({
      seed: 107,
      stream: 'order-paid-projector',
      paymentBlock: 5,
    });
    await uow.current().delete(receipts).where(eq(receipts.orderId, fixture.orderId));
    await uow
      .current()
      .delete(settlementCredits)
      .where(eq(settlementCredits.orderId, fixture.orderId));
    await uow
      .current()
      .update(products)
      .set({ sold: '0' })
      .where(eq(products.id, fixture.productId));
    await uow
      .current()
      .update(orders)
      .set({
        status: 'submitted',
        paidAmountBaseUnits: '0',
        transactionHash: null,
        blockNumber: null,
        blockHash: null,
        logIndex: null,
        confirmedAt: null,
      })
      .where(eq(orders.id, fixture.orderId));
    await uow
      .current()
      .update(paymentAttempts)
      .set({ status: 'confirming', terminalAt: null })
      .where(eq(paymentAttempts.id, fixture.attemptId));
    const projector = new PostgresCanonicalProjector(uow);
    const result = await uow.transaction(() =>
      projector.apply({
        canonicalLogId: fixture.paymentLogId,
        decoded: {
          eventName: 'OrderPaid',
          decoderVersion: 'projector-reorg-test-v3',
          fields: {
            orderKey: fixture.orderKey,
            merchantId: fixture.merchantOnchainId,
            productId: fixture.productOnchainId,
            payer: fixture.payer,
            recipient: fixture.payer,
            token: tokenAddress,
            quantity: '1',
            amount: '1000',
            platformFee: '100',
            passTokenId: fixture.productOnchainId,
            refundDeadline: (BigInt(refundDeadline.getTime()) / 1000n).toString(),
            intentDigest: fixture.intentDigest,
          },
        },
        position: {
          chainId,
          contractAddress: checkoutAddress,
          transactionHash: fixture.paymentTransactionHash,
          blockNumber: 5n,
          blockHash: bytes32(107 * 100 + 5),
          logIndex: 3,
          confirmations: 3n,
          observedAt: observedAt(5),
        },
      }),
    );
    const [order] = await uow.current().select().from(orders).where(eq(orders.id, fixture.orderId));
    const [attempt] = await uow
      .current()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, fixture.attemptId));
    const [credit] = await uow
      .current()
      .select()
      .from(settlementCredits)
      .where(eq(settlementCredits.orderId, fixture.orderId));
    expect(result).toEqual({ kind: 'applied' });
    expect(order).toMatchObject({ status: 'paid', paidAmountBaseUnits: '1000' });
    expect(attempt).toMatchObject({ status: 'paid', reconciliationRequired: false });
    expect(credit).toMatchObject({ status: 'refundable', amountBaseUnits: '900' });
  });

  it('updates payout only from a canonical event and restores it after a reorg', async () => {
    const fixture = await seedPaidOrder({
      seed: 109,
      stream: 'payout-projection-reorg',
      paymentBlock: 3,
    });
    const metadataHash = bytes32(109_004);
    await addCanonicalLog({
      seed: 109,
      stream: fixture.stream,
      eventName: 'MerchantCreated',
      blockNumber: 4,
      logIndex: 1,
      fields: {
        merchantId: fixture.merchantOnchainId,
        owner: fixture.payer,
        payout: fixture.payout,
        metadataHash,
      },
    });
    const nextPayout = address(109_999);
    const update = await addCanonicalLog({
      seed: 109,
      stream: fixture.stream,
      eventName: 'MerchantPayoutUpdated',
      blockNumber: 10,
      logIndex: 1,
      fields: {
        merchantId: fixture.merchantOnchainId,
        previousPayout: fixture.payout,
        newPayout: nextPayout,
      },
    });
    const projector = new PostgresCanonicalProjector(uow);
    await expect(
      uow.transaction(() =>
        projector.apply({
          canonicalLogId: update.id,
          decoded: {
            eventName: 'MerchantPayoutUpdated',
            decoderVersion: 'projector-reorg-test-v3',
            fields: {
              merchantId: fixture.merchantOnchainId,
              previousPayout: fixture.payout,
              newPayout: nextPayout,
            },
          },
          position: {
            chainId,
            contractAddress: checkoutAddress,
            transactionHash: update.transactionHash,
            blockNumber: 10n,
            blockHash: bytes32(109 * 100 + 10),
            logIndex: 1,
            confirmations: 3n,
            observedAt: observedAt(10),
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });
    const [updated] = await uow
      .current()
      .select({ payoutAddress: merchants.payoutAddress })
      .from(merchants)
      .where(eq(merchants.id, fixture.merchantId));
    expect(updated?.payoutAddress).toBe(nextPayout);

    await rewind(109, fixture.stream);

    const [restored] = await uow
      .current()
      .select({ payoutAddress: merchants.payoutAddress })
      .from(merchants)
      .where(eq(merchants.id, fixture.merchantId));
    expect(restored?.payoutAddress).toBe(fixture.payout);
  });

  it('removes paid proof and event-derived balances when OrderPaid is orphaned', async () => {
    const fixture = await seedPaidOrder({ seed: 101, stream: 'payment-reorg', paymentBlock: 10 });

    await rewind(101, fixture.stream);

    const [order] = await uow.current().select().from(orders).where(eq(orders.id, fixture.orderId));
    const [attempt] = await uow
      .current()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, fixture.attemptId));
    const [credit] = await uow
      .current()
      .select()
      .from(settlementCredits)
      .where(eq(settlementCredits.orderId, fixture.orderId));
    const [receipt] = await uow
      .current()
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, fixture.orderId));
    const [product] = await uow
      .current()
      .select()
      .from(products)
      .where(eq(products.id, fixture.productId));
    expect(order).toMatchObject({
      status: 'orphaned',
      paidAmountBaseUnits: '0',
      refundedAmountBaseUnits: '0',
      confirmedAt: null,
    });
    expect(attempt).toMatchObject({
      status: 'confirming',
      reconciliationRequired: true,
      terminalAt: null,
    });
    expect(credit).toMatchObject({
      status: 'orphaned',
      amountBaseUnits: '0',
      withdrawnBaseUnits: '0',
      finalizedEventId: null,
    });
    expect(receipt?.status).toBe('orphaned');
    expect(product?.sold).toBe('0');
  });

  it('rebuilds a partially refunded order and liability from surviving OrderPaid', async () => {
    const fixture = await seedPaidOrder({ seed: 102, stream: 'refund-reorg', paymentBlock: 5 });
    const refund = await addCanonicalLog({
      seed: 102,
      stream: fixture.stream,
      eventName: 'OrderRefunded',
      blockNumber: 10,
      logIndex: 1,
      fields: {
        orderKey: fixture.orderKey,
        merchantId: fixture.merchantOnchainId,
        payer: fixture.payer,
        amount: '200',
        platformFeeRefunded: '20',
        cumulativeRefunded: '200',
      },
    });
    await uow
      .current()
      .update(orders)
      .set({ status: 'partially_refunded', refundedAmountBaseUnits: '200' })
      .where(eq(orders.id, fixture.orderId));
    await uow
      .current()
      .update(settlementCredits)
      .set({ amountBaseUnits: '720' })
      .where(eq(settlementCredits.orderId, fixture.orderId));
    await uow
      .current()
      .insert(refunds)
      .values({
        id: 'rfd_reorg_102',
        orderId: fixture.orderId,
        merchantId: fixture.merchantId,
        requestedByUserId: fixture.userId,
        amountBaseUnits: '200',
        status: 'confirmed',
        idempotencyKeyHash: bytes32(102_010),
        transactionHash: refund.transactionHash,
        blockNumber: 10n,
        blockHash: bytes32(102 * 100 + 10),
        logIndex: 1,
        confirmedAt: observedAt(10),
      });

    await rewind(102, fixture.stream);

    const [order] = await uow.current().select().from(orders).where(eq(orders.id, fixture.orderId));
    const [credit] = await uow
      .current()
      .select()
      .from(settlementCredits)
      .where(eq(settlementCredits.orderId, fixture.orderId));
    const [workflow] = await uow
      .current()
      .select()
      .from(refunds)
      .where(eq(refunds.id, 'rfd_reorg_102'));
    expect(order).toMatchObject({
      status: 'paid',
      paidAmountBaseUnits: '1000',
      refundedAmountBaseUnits: '0',
    });
    expect(credit).toMatchObject({
      status: 'refundable',
      amountBaseUnits: '900',
      withdrawnBaseUnits: '0',
      finalizedEventId: null,
    });
    expect(workflow).toMatchObject({ status: 'orphaned', confirmedAt: null });

    const reincluded = await addCanonicalLog({
      seed: 102,
      stream: fixture.stream,
      eventName: 'OrderRefunded',
      blockNumber: 11,
      logIndex: 2,
      fields: {
        orderKey: fixture.orderKey,
        merchantId: fixture.merchantOnchainId,
        payer: fixture.payer,
        amount: '200',
        platformFeeRefunded: '20',
        cumulativeRefunded: '200',
      },
    });
    const projector = new PostgresCanonicalProjector(uow);
    await expect(
      uow.transaction(() =>
        projector.apply({
          canonicalLogId: reincluded.id,
          decoded: {
            eventName: 'OrderRefunded',
            decoderVersion: 'projector-reorg-test-v3',
            fields: {
              orderKey: fixture.orderKey,
              merchantId: fixture.merchantOnchainId,
              payer: fixture.payer,
              amount: '200',
              platformFeeRefunded: '20',
              cumulativeRefunded: '200',
            },
          },
          position: {
            chainId,
            contractAddress: checkoutAddress,
            transactionHash: reincluded.transactionHash,
            blockNumber: 11n,
            blockHash: bytes32(102 * 100 + 11),
            logIndex: 2,
            confirmations: 3n,
            observedAt: observedAt(11),
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });
    const [reconfirmed] = await uow
      .current()
      .select()
      .from(refunds)
      .where(eq(refunds.id, 'rfd_reorg_102'));
    expect(reconfirmed).toMatchObject({
      status: 'confirmed',
      transactionHash: reincluded.transactionHash,
    });
  });

  it('returns finalized credit to refundable when OrderFinalized is orphaned', async () => {
    const fixture = await seedPaidOrder({
      seed: 103,
      stream: 'finalization-reorg',
      paymentBlock: 5,
    });
    const finalization = await addCanonicalLog({
      seed: 103,
      stream: fixture.stream,
      eventName: 'OrderFinalized',
      blockNumber: 10,
      logIndex: 1,
      fields: {
        orderKey: fixture.orderKey,
        merchantId: fixture.merchantOnchainId,
        merchantCredit: '900',
        platformCredit: '100',
      },
    });
    await uow
      .current()
      .update(settlementCredits)
      .set({ status: 'matured', finalizedEventId: finalization.id })
      .where(eq(settlementCredits.orderId, fixture.orderId));

    await rewind(103, fixture.stream);

    const [credit] = await uow
      .current()
      .select()
      .from(settlementCredits)
      .where(eq(settlementCredits.orderId, fixture.orderId));
    expect(credit).toMatchObject({
      status: 'refundable',
      amountBaseUnits: '900',
      withdrawnBaseUnits: '0',
      finalizedEventId: null,
    });
  });

  it('replays surviving merchant withdrawals FIFO after a withdrawal reorg', async () => {
    const fixture = await seedPaidOrder({ seed: 104, stream: 'withdrawal-reorg', paymentBlock: 3 });
    const finalization = await addCanonicalLog({
      seed: 104,
      stream: fixture.stream,
      eventName: 'OrderFinalized',
      blockNumber: 5,
      logIndex: 1,
      fields: {
        orderKey: fixture.orderKey,
        merchantId: fixture.merchantOnchainId,
        merchantCredit: '900',
        platformCredit: '100',
      },
    });
    await addCanonicalLog({
      seed: 104,
      stream: fixture.stream,
      eventName: 'MerchantWithdrawal',
      blockNumber: 8,
      logIndex: 1,
      fields: {
        merchantId: fixture.merchantOnchainId,
        payout: fixture.payout,
        amount: '100',
        cumulativeWithdrawn: '100',
      },
    });
    await uow
      .current()
      .update(settlementCredits)
      .set({ status: 'matured', withdrawnBaseUnits: '300', finalizedEventId: finalization.id })
      .where(eq(settlementCredits.orderId, fixture.orderId));
    const withdrawal = await addCanonicalLog({
      seed: 104,
      stream: fixture.stream,
      eventName: 'MerchantWithdrawal',
      blockNumber: 10,
      logIndex: 1,
      fields: {
        merchantId: fixture.merchantOnchainId,
        payout: fixture.payout,
        amount: '200',
        cumulativeWithdrawn: '300',
      },
    });
    await uow
      .current()
      .insert(withdrawals)
      .values({
        id: 'wdr_reorg_104',
        merchantId: fixture.merchantId,
        requestedByUserId: fixture.userId,
        recipient: fixture.payout,
        amountBaseUnits: '200',
        status: 'confirmed',
        idempotencyKeyHash: bytes32(104_010),
        transactionHash: withdrawal.transactionHash,
        blockNumber: 10n,
        blockHash: bytes32(104 * 100 + 10),
        logIndex: 1,
        confirmedAt: observedAt(10),
      });

    await rewind(104, fixture.stream);

    const [credit] = await uow
      .current()
      .select()
      .from(settlementCredits)
      .where(eq(settlementCredits.orderId, fixture.orderId));
    const [workflow] = await uow
      .current()
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.id, 'wdr_reorg_104'));
    expect(credit).toMatchObject({
      status: 'matured',
      amountBaseUnits: '900',
      withdrawnBaseUnits: '100',
      finalizedEventId: finalization.id,
    });
    expect(workflow).toMatchObject({ status: 'orphaned', confirmedAt: null });

    const reincluded = await addCanonicalLog({
      seed: 104,
      stream: fixture.stream,
      eventName: 'MerchantWithdrawal',
      blockNumber: 11,
      logIndex: 2,
      fields: {
        merchantId: fixture.merchantOnchainId,
        payout: fixture.payout,
        amount: '200',
        cumulativeWithdrawn: '300',
      },
    });
    const projector = new PostgresCanonicalProjector(uow);
    await expect(
      uow.transaction(() =>
        projector.apply({
          canonicalLogId: reincluded.id,
          decoded: {
            eventName: 'MerchantWithdrawal',
            decoderVersion: 'projector-reorg-test-v3',
            fields: {
              merchantId: fixture.merchantOnchainId,
              payout: fixture.payout,
              amount: '200',
              cumulativeWithdrawn: '300',
            },
          },
          position: {
            chainId,
            contractAddress: checkoutAddress,
            transactionHash: reincluded.transactionHash,
            blockNumber: 11n,
            blockHash: bytes32(104 * 100 + 11),
            logIndex: 2,
            confirmations: 3n,
            observedAt: observedAt(11),
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });
    const [reconfirmed] = await uow
      .current()
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.id, 'wdr_reorg_104'));
    const [redebited] = await uow
      .current()
      .select()
      .from(settlementCredits)
      .where(eq(settlementCredits.orderId, fixture.orderId));
    expect(reconfirmed).toMatchObject({
      status: 'confirmed',
      transactionHash: reincluded.transactionHash,
    });
    expect(redebited?.withdrawnBaseUnits).toBe('300');
  });

  it('does not reserve a confirmed withdrawal twice when creating the next withdrawal', async () => {
    const fixture = await seedPaidOrder({
      seed: 108,
      stream: 'sequential-withdrawals',
      paymentBlock: 5,
    });
    await uow
      .current()
      .update(settlementCredits)
      .set({ status: 'matured', amountBaseUnits: '100', withdrawnBaseUnits: '40' })
      .where(eq(settlementCredits.orderId, fixture.orderId));
    await uow
      .current()
      .insert(withdrawals)
      .values({
        id: 'wdr_confirmed_108',
        merchantId: fixture.merchantId,
        requestedByUserId: fixture.userId,
        recipient: fixture.payout,
        amountBaseUnits: '40',
        status: 'confirmed',
        idempotencyKeyHash: bytes32(108_010),
        transactionHash: bytes32(108_011),
        blockNumber: 8n,
        blockHash: bytes32(108_012),
        logIndex: 1,
        confirmedAt: observedAt(8),
      });

    const workflow = new PostgresWorkflowStore(uow);
    await expect(
      workflow.createWithdrawal({
        id: 'wdr_01J00000000000000000000108' as never,
        merchantId: fixture.merchantId as never,
        requestedByUserId: fixture.userId as never,
        recipient: fixture.payout as never,
        amountBaseUnits: '60' as never,
        idempotencyKeyHash: bytes32(108_013),
        now: observedAt(9),
      }),
    ).resolves.toMatchObject({ status: 'created', amountBaseUnits: '60' });
  });

  it('restores loyalty points and issued pass state when adjustments are orphaned', async () => {
    const fixture = await seedPaidOrder({
      seed: 105,
      stream: 'loyalty-pass-reorg',
      paymentBlock: 5,
    });
    const award = await addCanonicalLog({
      seed: 105,
      stream: fixture.stream,
      eventName: 'LoyaltyAwarded',
      blockNumber: 5,
      logIndex: 1,
      transactionHash: fixture.paymentTransactionHash,
      fields: {
        merchantId: fixture.merchantOnchainId,
        account: fixture.payer,
        orderKey: fixture.orderKey,
        points: '100',
      },
    });
    const transfer = await addCanonicalLog({
      seed: 105,
      stream: fixture.stream,
      eventName: 'TransferSingle',
      blockNumber: 5,
      logIndex: 2,
      transactionHash: fixture.paymentTransactionHash,
      contractAddress: passAddress,
      fields: {
        operator: checkoutAddress,
        from: zeroAddress,
        to: fixture.payer,
        id: fixture.productOnchainId,
        value: '1',
      },
    });
    await addCanonicalLog({
      seed: 105,
      stream: fixture.stream,
      eventName: 'LoyaltyAdjusted',
      blockNumber: 10,
      logIndex: 1,
      fields: {
        merchantId: fixture.merchantOnchainId,
        account: fixture.payer,
        orderKey: fixture.orderKey,
        pointsRemoved: '80',
        remainingOrderPoints: '20',
      },
    });
    await addCanonicalLog({
      seed: 105,
      stream: fixture.stream,
      eventName: 'PassRevoked',
      blockNumber: 10,
      logIndex: 2,
      contractAddress: passAddress,
      fields: {
        orderKey: fixture.orderKey,
        account: fixture.payer,
        tokenId: fixture.productOnchainId,
        quantity: '1',
      },
    });
    const [program] = await uow
      .current()
      .insert(loyaltyPrograms)
      .values({
        merchantId: fixture.merchantId,
        name: 'Reorg Rewards',
      })
      .returning({ id: loyaltyPrograms.id });
    if (program === undefined) throw new Error('Failed to seed loyalty program');
    await uow.current().insert(loyaltyAwards).values({
      programId: program.id,
      userId: fixture.userId,
      orderId: fixture.orderId,
      points: '20',
      canonicalEventId: award.id,
      canonical: true,
    });
    await uow.current().insert(loyaltyBalances).values({
      programId: program.id,
      userId: fixture.userId,
      points: '20',
    });
    await uow
      .current()
      .update(receipts)
      .set({
        status: 'revoked',
        chainEventId: transfer.id,
        issuedAt: observedAt(5),
      })
      .where(eq(receipts.orderId, fixture.orderId));

    await rewind(105, fixture.stream);

    const [projectedAward] = await uow
      .current()
      .select()
      .from(loyaltyAwards)
      .where(eq(loyaltyAwards.orderId, fixture.orderId));
    const [balance] = await uow
      .current()
      .select()
      .from(loyaltyBalances)
      .where(eq(loyaltyBalances.userId, fixture.userId));
    const [receipt] = await uow
      .current()
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, fixture.orderId));
    expect(projectedAward).toMatchObject({ points: '100', canonical: true });
    expect(balance?.points).toBe('100');
    expect(receipt).toMatchObject({
      status: 'issued',
      chainEventId: transfer.id,
      tokenId: fixture.productOnchainId,
    });
  });

  it('removes orphaned split reimbursement totals without changing the merchant order', async () => {
    const fixture = await seedPaidOrder({ seed: 106, stream: 'split-reorg', paymentBlock: 5 });
    const participantUserId = 'usr_reorg_split_106';
    const participantPayer = address(999_106);
    await uow
      .current()
      .insert(users)
      .values({
        id: participantUserId,
        magicIssuerHash: bytes32(106_020),
        walletAddressChecksum: participantPayer,
        walletAddressLower: participantPayer.toLowerCase(),
      });
    await uow
      .current()
      .insert(splits)
      .values({
        id: 'spl_reorg_106',
        orderId: fixture.orderId,
        creatorUserId: fixture.userId,
        beneficiary: fixture.payer,
        totalBaseUnits: '300',
        confirmedBaseUnits: '300',
        status: 'complete',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      });
    const [participant] = await uow
      .current()
      .insert(splitParticipants)
      .values({
        splitId: 'spl_reorg_106',
        label: 'Friend',
        participantUserId,
        amountBaseUnits: '300',
        confirmedBaseUnits: '300',
      })
      .returning({ id: splitParticipants.id });
    if (participant === undefined) throw new Error('Failed to seed split participant');
    await uow
      .current()
      .insert(splitInvitations)
      .values({
        id: 'sin_reorg_106',
        splitId: 'spl_reorg_106',
        participantId: participant.id,
        capabilityHash: bytes32(106_021),
        status: 'paid',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      });
    const paymentKey = bytes32(106_022);
    const splitDigest = bytes32(106_023);
    const splitIntentDigest = bytes32(106_024);
    const splitLog = await addCanonicalLog({
      seed: 106,
      stream: fixture.stream,
      eventName: 'SplitReimbursed',
      blockNumber: 10,
      logIndex: 1,
      contractAddress: splitAddress,
      fields: {
        paymentKey,
        splitDigest,
        originalOrderKey: fixture.orderKey,
        payer: participantPayer,
        beneficiary: fixture.payer,
        token: tokenAddress,
        amount: '300',
        intentDigest: splitIntentDigest,
      },
    });
    await uow
      .current()
      .insert(splitPayments)
      .values({
        splitId: 'spl_reorg_106',
        invitationId: 'sin_reorg_106',
        payerUserId: participantUserId,
        paymentKey,
        splitDigest,
        originalOrderKey: fixture.orderKey,
        tokenAddress,
        intentDigest: splitIntentDigest,
        amountBaseUnits: '300',
        status: 'paid',
        transactionHash: splitLog.transactionHash,
        blockNumber: 10n,
        blockHash: bytes32(106 * 100 + 10),
        logIndex: 1,
        confirmedAt: observedAt(10),
      });

    await rewind(106, fixture.stream);

    const [payment] = await uow
      .current()
      .select()
      .from(splitPayments)
      .where(eq(splitPayments.paymentKey, paymentKey));
    const [invitation] = await uow
      .current()
      .select()
      .from(splitInvitations)
      .where(eq(splitInvitations.id, 'sin_reorg_106'));
    const [projectedParticipant] = await uow
      .current()
      .select()
      .from(splitParticipants)
      .where(eq(splitParticipants.id, participant.id));
    const [split] = await uow.current().select().from(splits).where(eq(splits.id, 'spl_reorg_106'));
    const [order] = await uow.current().select().from(orders).where(eq(orders.id, fixture.orderId));
    expect(payment).toMatchObject({ status: 'confirming', confirmedAt: null });
    expect(invitation?.status).toBe('confirming');
    expect(projectedParticipant?.confirmedBaseUnits).toBe('0');
    expect(split).toMatchObject({ status: 'active', confirmedBaseUnits: '0' });
    expect(order).toMatchObject({ status: 'paid', paidAmountBaseUnits: '1000' });
  });
});
