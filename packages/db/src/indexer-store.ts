import type { RawContractLog } from '@opentab/application';
import {
  AppError,
  type ChainId,
  ChainIdSchema,
  type EvmAddress,
  EvmAddressSchema,
  type TransactionHash,
  TransactionHashSchema,
} from '@opentab/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  expectedFinalizationCredits,
  PostgresCanonicalProjector,
  planWithdrawalDebits,
  type StoredDecodedEvent,
} from './projectors.js';
import {
  canonicalLogs,
  chainEventQuarantine,
  contractOperations,
  indexedBlocks,
  indexerCursors,
  judgeEvidence,
  loyaltyAwards,
  merchants,
  orders,
  outboxEvents,
  paymentAttempts,
  products,
  receipts,
  refunds,
  reorgIncidents,
  settlementCredits,
  signedOrderIntents,
  splitInvitations,
  splitPayments,
  users,
  withdrawals,
} from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

export type DatabaseDecodedResult =
  | { readonly kind: 'decoded'; readonly event: StoredDecodedEvent }
  | {
      readonly kind: 'quarantined';
      readonly reasonCode: string;
      readonly safeDetails: Readonly<Record<string, string>>;
      readonly decoderVersion: string;
    };

export interface DatabaseIndexedLog {
  readonly raw: RawContractLog;
  readonly decoded: DatabaseDecodedResult;
  readonly payloadDigest: `0x${string}`;
  readonly confirmations: bigint;
  readonly observedAt: Date;
}

export interface DatabaseIndexerCursor {
  readonly chainId: ChainId;
  readonly stream: string;
  readonly nextBlock: bigint;
  readonly lastProcessedBlock?: bigint;
  readonly lastProcessedBlockHash?: `0x${string}`;
  readonly confirmationDepth: number;
}

function cursorRecord(record: typeof indexerCursors.$inferSelect): DatabaseIndexerCursor {
  return {
    chainId: ChainIdSchema.parse(record.chainId),
    stream: record.stream,
    nextBlock: record.nextBlock,
    ...(record.lastProcessedBlock === null
      ? {}
      : { lastProcessedBlock: record.lastProcessedBlock }),
    ...(record.lastProcessedBlockHash === null
      ? {}
      : { lastProcessedBlockHash: record.lastProcessedBlockHash as `0x${string}` }),
    confirmationDepth: record.confirmationDepth,
  };
}

function decodedPayload(log: DatabaseIndexedLog): Record<string, unknown> {
  if (log.decoded.kind === 'decoded') {
    return {
      decoderVersion: log.decoded.event.decoderVersion,
      fields: { ...log.decoded.event.fields },
      confirmations: log.confirmations.toString(),
    };
  }
  return {
    decoderVersion: log.decoded.decoderVersion,
    quarantineReason: log.decoded.reasonCode ?? 'DECODER_REJECTED',
    safeDetails: { ...(log.decoded.safeDetails ?? {}) },
    confirmations: log.confirmations.toString(),
  };
}

function readStoredDecoded(
  value: Record<string, unknown>,
  eventName: string,
): StoredDecodedEvent | undefined {
  const decoderVersion = value['decoderVersion'];
  const fields = value['fields'];
  if (
    typeof decoderVersion !== 'string' ||
    typeof fields !== 'object' ||
    fields === null ||
    Array.isArray(fields)
  ) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (typeof field !== 'string') return undefined;
    normalized[key] = field;
  }
  return { eventName, fields: normalized, decoderVersion };
}

function eventFields(record: {
  readonly eventName: string;
  readonly decodedPayload: Record<string, unknown>;
}): Readonly<Record<string, string>> {
  return readStoredDecoded(record.decodedPayload, record.eventName)?.fields ?? {};
}

function sameAddressForRebuild(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

export class PostgresIndexerStore {
  readonly #projector: PostgresCanonicalProjector;

  constructor(private readonly uow: PostgresUnitOfWork) {
    this.#projector = new PostgresCanonicalProjector(uow);
  }

  async loadOrCreateCursor(input: {
    chainId: ChainId;
    stream: string;
    startBlock: bigint;
    confirmationDepth: number;
  }): Promise<DatabaseIndexerCursor> {
    await this.uow
      .current()
      .insert(indexerCursors)
      .values({
        chainId: input.chainId,
        stream: input.stream,
        nextBlock: input.startBlock,
        confirmationDepth: input.confirmationDepth,
      })
      .onConflictDoNothing();
    const [record] = await this.uow
      .current()
      .select()
      .from(indexerCursors)
      .where(
        and(eq(indexerCursors.chainId, input.chainId), eq(indexerCursors.stream, input.stream)),
      )
      .limit(1);
    if (record === undefined) throw new Error('Failed to initialize indexer cursor');
    if (record.confirmationDepth !== input.confirmationDepth) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Indexer confirmation depth changed without an explicit replay.',
      );
    }
    return cursorRecord(record);
  }

  async tryAcquireLease(input: {
    chainId: ChainId;
    stream: string;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean> {
    const [updated] = await this.uow
      .current()
      .update(indexerCursors)
      .set({
        leaseOwner: input.owner,
        leaseExpiresAt: new Date(input.now.getTime() + input.ttlMs),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(indexerCursors.chainId, input.chainId),
          eq(indexerCursors.stream, input.stream),
          or(
            isNull(indexerCursors.leaseOwner),
            lt(indexerCursors.leaseExpiresAt, input.now),
            eq(indexerCursors.leaseOwner, input.owner),
          ),
        ),
      )
      .returning({ chainId: indexerCursors.chainId });
    return updated !== undefined;
  }

  async releaseLease(input: {
    chainId: ChainId;
    stream: string;
    owner: string;
    now: Date;
  }): Promise<void> {
    await this.uow
      .current()
      .update(indexerCursors)
      .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: input.now })
      .where(
        and(
          eq(indexerCursors.chainId, input.chainId),
          eq(indexerCursors.stream, input.stream),
          eq(indexerCursors.leaseOwner, input.owner),
        ),
      );
  }

  async getCanonicalBlock(input: { chainId: ChainId; stream: string; blockNumber: bigint }) {
    const [record] = await this.uow
      .current()
      .select()
      .from(indexedBlocks)
      .where(
        and(
          eq(indexedBlocks.chainId, input.chainId),
          eq(indexedBlocks.stream, input.stream),
          eq(indexedBlocks.blockNumber, input.blockNumber),
          eq(indexedBlocks.canonical, true),
        ),
      )
      .limit(1);
    return record === undefined
      ? undefined
      : {
          number: record.blockNumber,
          hash: record.blockHash as `0x${string}`,
          parentHash: record.parentHash as `0x${string}`,
          observedAt: record.observedAt,
        };
  }

  async commitRange(input: {
    cursor: DatabaseIndexerCursor;
    blocks: readonly {
      number: bigint;
      hash: `0x${string}`;
      parentHash: `0x${string}`;
      observedAt: Date;
    }[];
    logs: readonly DatabaseIndexedLog[];
    nextBlock: bigint;
    now: Date;
  }): Promise<void> {
    if (input.blocks.length === 0 || input.nextBlock <= input.cursor.nextBlock) {
      throw new Error('Indexer range commit must advance at least one block');
    }
    const last = input.blocks[input.blocks.length - 1];
    if (last === undefined || last.number !== input.nextBlock - 1n) {
      throw new AppError('RPC_INCONSISTENT', 'The indexer range is missing its canonical tip.');
    }
    const suppliedBlocks = new Map<bigint, `0x${string}`>();
    let previousBlockNumber: bigint | undefined;
    for (const block of input.blocks) {
      if (previousBlockNumber !== undefined && block.number <= previousBlockNumber) {
        throw new AppError('RPC_INCONSISTENT', 'Indexer proof blocks are not strictly ordered.');
      }
      suppliedBlocks.set(block.number, block.hash);
      previousBlockNumber = block.number;
    }
    for (const log of input.logs) {
      const suppliedHash = suppliedBlocks.get(BigInt(log.raw.blockNumber));
      if (suppliedHash?.toLowerCase() !== log.raw.blockHash.toLowerCase()) {
        throw new AppError('RPC_INCONSISTENT', 'An indexed log is missing its canonical block.');
      }
    }
    await this.uow.transaction(async () => {
      const [lockedCursor] = await this.uow
        .current()
        .select()
        .from(indexerCursors)
        .where(
          and(
            eq(indexerCursors.chainId, input.cursor.chainId),
            eq(indexerCursors.stream, input.cursor.stream),
          ),
        )
        .for('update')
        .limit(1);
      if (lockedCursor === undefined || lockedCursor.nextBlock !== input.cursor.nextBlock) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The indexer cursor advanced concurrently.', {
          retryable: true,
        });
      }

      for (const block of input.blocks) {
        const [conflict] = await this.uow
          .current()
          .select({ hash: indexedBlocks.blockHash })
          .from(indexedBlocks)
          .where(
            and(
              eq(indexedBlocks.chainId, input.cursor.chainId),
              eq(indexedBlocks.stream, input.cursor.stream),
              eq(indexedBlocks.blockNumber, block.number),
              eq(indexedBlocks.canonical, true),
            ),
          )
          .limit(1);
        if (conflict !== undefined && conflict.hash.toLowerCase() !== block.hash.toLowerCase()) {
          throw new AppError(
            'RPC_INCONSISTENT',
            'A block changed before the indexer committed it.',
            {
              retryable: true,
            },
          );
        }
        await this.uow
          .current()
          .insert(indexedBlocks)
          .values({
            chainId: input.cursor.chainId,
            stream: input.cursor.stream,
            blockNumber: block.number,
            blockHash: block.hash,
            parentHash: block.parentHash,
            canonical: true,
            observedAt: block.observedAt,
          })
          .onConflictDoNothing();
      }

      for (const log of input.logs) {
        if (log.raw.chainId !== input.cursor.chainId) {
          throw new AppError('RPC_INCONSISTENT', 'A log was returned for the wrong chain.');
        }
        const eventName =
          log.decoded.kind === 'decoded' ? log.decoded.event.eventName : '__quarantined__';
        const [inserted] = await this.uow
          .current()
          .insert(canonicalLogs)
          .values({
            chainId: input.cursor.chainId,
            stream: input.cursor.stream,
            contractAddress: log.raw.contractAddress,
            eventName,
            transactionHash: log.raw.transactionHash,
            blockNumber: BigInt(log.raw.blockNumber),
            blockHash: log.raw.blockHash,
            logIndex: Number(log.raw.logIndex),
            canonical: true,
            decodedPayload: decodedPayload(log),
            payloadDigest: log.payloadDigest,
            projectionStatus: 'pending',
            observedAt: log.observedAt,
            createdAt: input.now,
          })
          .onConflictDoNothing()
          .returning();
        let record = inserted;
        if (record === undefined) {
          [record] = await this.uow
            .current()
            .select()
            .from(canonicalLogs)
            .where(
              and(
                eq(canonicalLogs.chainId, input.cursor.chainId),
                eq(canonicalLogs.transactionHash, log.raw.transactionHash),
                eq(canonicalLogs.logIndex, Number(log.raw.logIndex)),
                eq(canonicalLogs.blockHash, log.raw.blockHash),
              ),
            )
            .limit(1);
        }
        if (record === undefined) throw new Error('Failed to persist indexed log');
        if (record.payloadDigest.toLowerCase() !== log.payloadDigest.toLowerCase()) {
          throw new AppError('RPC_INCONSISTENT', 'Duplicate log identity had a different payload.');
        }
        if (record.projectionStatus !== 'pending') continue;

        if (log.decoded.kind === 'quarantined') {
          await this.#quarantine({
            canonicalLogId: record.id,
            reasonCode: log.decoded.reasonCode ?? 'DECODER_REJECTED',
            safeDetails: log.decoded.safeDetails ?? {},
            now: input.now,
          });
          continue;
        }
        const result = await this.#projector.apply({
          canonicalLogId: record.id,
          decoded: log.decoded.event,
          position: {
            chainId: log.raw.chainId,
            contractAddress: log.raw.contractAddress,
            transactionHash: log.raw.transactionHash,
            blockNumber: BigInt(log.raw.blockNumber),
            blockHash: log.raw.blockHash,
            logIndex: Number(log.raw.logIndex),
            confirmations: log.confirmations,
            observedAt: log.observedAt,
          },
        });
        if (result.kind === 'quarantined') {
          await this.#quarantine({
            canonicalLogId: record.id,
            reasonCode: result.reasonCode,
            safeDetails: result.safeDetails,
            now: input.now,
          });
        } else {
          await this.uow
            .current()
            .update(canonicalLogs)
            .set({ projectionStatus: 'applied', projectedAt: input.now })
            .where(eq(canonicalLogs.id, record.id));
        }
      }

      const [advanced] = await this.uow
        .current()
        .update(indexerCursors)
        .set({
          nextBlock: input.nextBlock,
          lastProcessedBlock: last.number,
          lastProcessedBlockHash: last.hash,
          version: sql`${indexerCursors.version} + 1`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(indexerCursors.chainId, input.cursor.chainId),
            eq(indexerCursors.stream, input.cursor.stream),
            eq(indexerCursors.nextBlock, input.cursor.nextBlock),
          ),
        )
        .returning({ nextBlock: indexerCursors.nextBlock });
      if (advanced === undefined)
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The indexer cursor could not advance.');
    });
  }

  async rewind(input: {
    cursor: DatabaseIndexerCursor;
    details: {
      detectedAtBlock: bigint;
      commonAncestorBlock: bigint;
      oldHeadHash: `0x${string}`;
      newHeadHash: `0x${string}`;
    };
    now: Date;
  }): Promise<void> {
    const fromBlock = input.details.commonAncestorBlock + 1n;
    await this.uow.transaction(async () => {
      const affected = await this.uow
        .current()
        .select({
          id: canonicalLogs.id,
          eventName: canonicalLogs.eventName,
          transactionHash: canonicalLogs.transactionHash,
          logIndex: canonicalLogs.logIndex,
          decodedPayload: canonicalLogs.decodedPayload,
        })
        .from(canonicalLogs)
        .where(
          and(
            eq(canonicalLogs.chainId, input.cursor.chainId),
            eq(canonicalLogs.stream, input.cursor.stream),
            eq(canonicalLogs.canonical, true),
            sql`${canonicalLogs.blockNumber} >= ${fromBlock}`,
          ),
        );
      const affectedIds = affected.map((event) => event.id);
      const affectedOrderKeys = [
        ...new Set(
          affected
            .filter((event) =>
              ['OrderPaid', 'OrderRefunded', 'OrderFinalized'].includes(event.eventName),
            )
            .map((event) => eventFields(event)['orderKey'])
            .filter((value): value is string => value !== undefined),
        ),
      ];
      const affectedReceiptOrderKeys = [
        ...new Set(
          affected
            .filter((event) =>
              ['OrderPaid', 'OrderRefunded', 'PassRevoked'].includes(event.eventName),
            )
            .map((event) => eventFields(event)['orderKey'])
            .filter((value): value is string => value !== undefined),
        ),
      ];
      const affectedWithdrawalMerchantOnchainIds = [
        ...new Set(
          affected
            .filter((event) => event.eventName === 'MerchantWithdrawal')
            .map((event) => eventFields(event)['merchantId'])
            .filter((value): value is string => value !== undefined),
        ),
      ];
      const affectedRefundPositions = affected.filter(
        (event) => event.eventName === 'OrderRefunded',
      );
      const affectedWithdrawalPositions = affected.filter(
        (event) => event.eventName === 'MerchantWithdrawal',
      );
      const affectedSplitPaymentKeys = [
        ...new Set(
          affected
            .filter((event) => ['SplitReimbursed', 'SplitPaymentRevoked'].includes(event.eventName))
            .map((event) => eventFields(event)['paymentKey'])
            .filter((value): value is string => value !== undefined),
        ),
      ];
      const affectedMerchantProjectionIds = [
        ...new Set(
          affected
            .filter((event) =>
              [
                'MerchantCreated',
                'MerchantPayoutUpdated',
                'MerchantStatusChanged',
                'MerchantSuspensionChanged',
                'MerchantMetadataUpdated',
              ].includes(event.eventName),
            )
            .map((event) => eventFields(event)['merchantId'])
            .filter((value): value is string => value !== undefined),
        ),
      ];
      const affectedProductProjectionIds = [
        ...new Set(
          affected
            .filter((event) =>
              ['ProductCreated', 'ProductUpdated', 'ProductStatusChanged'].includes(
                event.eventName,
              ),
            )
            .map((event) => eventFields(event)['productId'])
            .filter((value): value is string => value !== undefined),
        ),
      ];
      const [orderKeyRows, receiptRows] = await Promise.all([
        affectedOrderKeys.length === 0
          ? Promise.resolve([])
          : this.uow
              .current()
              .select({ orderId: orders.id })
              .from(orders)
              .where(inArray(orders.orderKey, affectedOrderKeys)),
        affectedIds.length === 0
          ? Promise.resolve([])
          : this.uow
              .current()
              .select({ orderId: receipts.orderId })
              .from(receipts)
              .where(inArray(receipts.chainEventId, affectedIds)),
      ]);
      const affectedJudgeOrderIds = [
        ...new Set([...orderKeyRows, ...receiptRows].map((row) => row.orderId)),
      ];
      if (affectedJudgeOrderIds.length > 0) {
        await this.uow
          .current()
          .update(judgeEvidence)
          .set({
            published: false,
            shareTokenHash: null,
            expiresAt: null,
            revokedAt: input.now,
            updatedAt: input.now,
          })
          .where(inArray(judgeEvidence.orderId, affectedJudgeOrderIds));
      }
      await this.uow
        .current()
        .update(canonicalLogs)
        .set({ canonical: false, projectionStatus: 'orphaned', orphanedAt: input.now })
        .where(
          and(
            eq(canonicalLogs.chainId, input.cursor.chainId),
            eq(canonicalLogs.stream, input.cursor.stream),
            eq(canonicalLogs.canonical, true),
            sql`${canonicalLogs.blockNumber} >= ${fromBlock}`,
          ),
        );
      if (affected.length > 0) {
        await this.uow
          .current()
          .update(contractOperations)
          .set({
            status: 'orphaned',
            canonicalEventName: null,
            blockNumber: null,
            blockHash: null,
            logIndex: null,
            confirmedAt: null,
            updatedAt: input.now,
            version: sql`${contractOperations.version} + 1`,
          })
          .where(
            or(
              ...affected.map((event) =>
                and(
                  eq(contractOperations.transactionHash, event.transactionHash),
                  eq(contractOperations.logIndex, event.logIndex),
                ),
              ),
            ),
          );
      }
      await this.uow
        .current()
        .update(indexedBlocks)
        .set({ canonical: false, orphanedAt: input.now })
        .where(
          and(
            eq(indexedBlocks.chainId, input.cursor.chainId),
            eq(indexedBlocks.stream, input.cursor.stream),
            eq(indexedBlocks.canonical, true),
            sql`${indexedBlocks.blockNumber} >= ${fromBlock}`,
          ),
        );
      if (affectedRefundPositions.length > 0) {
        await this.uow
          .current()
          .update(refunds)
          .set({ status: 'orphaned', confirmedAt: null, updatedAt: input.now })
          .where(
            or(
              ...affectedRefundPositions.map((event) =>
                and(
                  eq(refunds.transactionHash, event.transactionHash),
                  eq(refunds.logIndex, event.logIndex),
                ),
              ),
            ),
          );
      }
      if (affectedWithdrawalPositions.length > 0) {
        await this.uow
          .current()
          .update(withdrawals)
          .set({ status: 'orphaned', confirmedAt: null, updatedAt: input.now })
          .where(
            or(
              ...affectedWithdrawalPositions.map((event) =>
                and(
                  eq(withdrawals.transactionHash, event.transactionHash),
                  eq(withdrawals.logIndex, event.logIndex),
                ),
              ),
            ),
          );
      }
      const affectedSplitPaymentIds =
        affectedSplitPaymentKeys.length === 0
          ? []
          : await this.uow
              .current()
              .select({ id: splitPayments.id, invitationId: splitPayments.invitationId })
              .from(splitPayments)
              .where(inArray(splitPayments.paymentKey, affectedSplitPaymentKeys));
      if (affectedSplitPaymentIds.length > 0) {
        await this.uow
          .current()
          .update(splitPayments)
          .set({
            status: 'confirming',
            transactionHash: null,
            blockNumber: null,
            blockHash: null,
            logIndex: null,
            confirmedAt: null,
            updatedAt: input.now,
          })
          .where(
            inArray(
              splitPayments.id,
              affectedSplitPaymentIds.map((payment) => payment.id),
            ),
          );
        await this.uow
          .current()
          .update(splitInvitations)
          .set({ status: 'confirming', updatedAt: input.now })
          .where(
            inArray(
              splitInvitations.id,
              affectedSplitPaymentIds.map((payment) => payment.invitationId),
            ),
          );
      }
      if (affectedIds.length > 0) {
        await this.uow
          .current()
          .update(receipts)
          .set({ status: 'orphaned', updatedAt: input.now })
          .where(inArray(receipts.chainEventId, affectedIds));
        await this.uow
          .current()
          .update(loyaltyAwards)
          .set({ canonical: false })
          .where(inArray(loyaltyAwards.canonicalEventId, affectedIds));
      }
      for (const orderKey of affectedOrderKeys) {
        await this.#rebuildOrderAfterReorg({
          chainId: input.cursor.chainId,
          orderKey,
          now: input.now,
        });
      }
      for (const orderKey of affectedReceiptOrderKeys) {
        await this.#rebuildReceiptAfterReorg({
          chainId: input.cursor.chainId,
          orderKey,
          now: input.now,
        });
      }
      for (const merchantOnchainId of affectedWithdrawalMerchantOnchainIds) {
        await this.#rebuildMerchantWithdrawals({
          chainId: input.cursor.chainId,
          merchantOnchainId,
          now: input.now,
        });
      }
      for (const merchantOnchainId of affectedMerchantProjectionIds) {
        await this.#rebuildMerchantProjection({
          chainId: input.cursor.chainId,
          merchantOnchainId,
          now: input.now,
        });
      }
      for (const productOnchainId of affectedProductProjectionIds) {
        await this.#rebuildProductProjection({
          chainId: input.cursor.chainId,
          productOnchainId,
          now: input.now,
        });
      }
      await this.uow.current().execute(sql`
        update products p set sold = coalesce((
          select sum((cl.decoded_payload->'fields'->>'quantity')::numeric)
          from canonical_logs cl
          where cl.canonical = true and cl.projection_status = 'applied'
            and cl.event_name = 'OrderPaid'
            and cl.decoded_payload->'fields'->>'productId' = p.onchain_product_id::text
        ), 0), updated_at = ${input.now.toISOString()}::timestamptz
      `);
      await this.uow.current().execute(sql`
        update loyalty_awards la set
          canonical = exists (
            select 1 from canonical_logs awarded
            join orders o on o.id = la.order_id
            where awarded.canonical = true
              and awarded.projection_status = 'applied'
              and awarded.event_name = 'LoyaltyAwarded'
              and awarded.decoded_payload->'fields'->>'orderKey' = o.order_key
          ),
          points = coalesce((
            select adjusted.decoded_payload->'fields'->>'remainingOrderPoints'
            from canonical_logs adjusted
            join orders o on o.id = la.order_id
            where adjusted.canonical = true
              and adjusted.projection_status = 'applied'
              and adjusted.event_name = 'LoyaltyAdjusted'
              and adjusted.decoded_payload->'fields'->>'orderKey' = o.order_key
            order by adjusted.block_number desc, adjusted.log_index desc
            limit 1
          ), (
            select awarded.decoded_payload->'fields'->>'points'
            from canonical_logs awarded
            join orders o on o.id = la.order_id
            where awarded.canonical = true
              and awarded.projection_status = 'applied'
              and awarded.event_name = 'LoyaltyAwarded'
              and awarded.decoded_payload->'fields'->>'orderKey' = o.order_key
            order by awarded.block_number desc, awarded.log_index desc
            limit 1
          ), '0')::numeric
      `);
      await this.uow.current().execute(sql`
        update loyalty_balances lb set points = coalesce((
          select sum(la.points) from loyalty_awards la
          where la.program_id = lb.program_id and la.user_id = lb.user_id and la.canonical = true
        ), 0), version = lb.version + 1, updated_at = ${input.now.toISOString()}::timestamptz
      `);
      await this.uow.current().execute(sql`
        update split_participants sp set confirmed_base_units = coalesce((
          select sum(spp.amount_base_units) from split_payments spp
          join split_invitations si on si.id = spp.invitation_id
          where si.participant_id = sp.id and spp.status = 'paid'
        ), 0), updated_at = ${input.now.toISOString()}::timestamptz
      `);
      await this.uow.current().execute(sql`
        update splits s set confirmed_base_units = coalesce((
          select sum(spp.amount_base_units) from split_payments spp
          where spp.split_id = s.id and spp.status = 'paid'
        ), 0), status = case
          when s.revoked_at is not null and not exists (
            select 1 from split_payments spp where spp.split_id = s.id
          ) then 'revoked'::split_status
          when coalesce((select sum(spp.amount_base_units) from split_payments spp where spp.split_id = s.id and spp.status = 'paid'), 0) = 0 then 'active'::split_status
          when coalesce((select sum(spp.amount_base_units) from split_payments spp where spp.split_id = s.id and spp.status = 'paid'), 0) = s.total_base_units then 'complete'::split_status
          else 'partially_paid'::split_status end,
          version = s.version + 1, updated_at = ${input.now.toISOString()}::timestamptz
      `);
      await this.uow.current().execute(sql`
        update splits s set
          status = case
            when exists (select 1 from split_payments spp where spp.split_id = s.id)
              and not exists (
                select 1 from split_payments spp
                where spp.split_id = s.id and spp.status <> 'revoked'::split_payment_status
              ) and s.confirmed_base_units = 0 then 'revoked'::split_status
            when exists (
              select 1 from contract_operations cop
              join split_payments spp on spp.id::text = cop.aggregate_id
              where spp.split_id = s.id and cop.kind = 'split_revocation'
                and cop.status in ('prepared','submission_started','submitted','submitted_unknown','confirming','orphaned')
            ) and s.confirmed_base_units = 0 then 'revoking'::split_status
            else s.status end,
          revoked_at = case
            when exists (select 1 from split_payments spp where spp.split_id = s.id)
              and not exists (
                select 1 from split_payments spp
                where spp.split_id = s.id and spp.status <> 'revoked'::split_payment_status
              ) and s.confirmed_base_units = 0 then coalesce(s.revoked_at, ${input.now.toISOString()}::timestamptz)
            when exists (select 1 from split_payments spp where spp.split_id = s.id)
              then null
            else s.revoked_at end,
          updated_at = ${input.now.toISOString()}::timestamptz
      `);
      const [ancestor] = await this.uow
        .current()
        .select({ hash: indexedBlocks.blockHash })
        .from(indexedBlocks)
        .where(
          and(
            eq(indexedBlocks.chainId, input.cursor.chainId),
            eq(indexedBlocks.stream, input.cursor.stream),
            eq(indexedBlocks.blockNumber, input.details.commonAncestorBlock),
            eq(indexedBlocks.canonical, true),
          ),
        )
        .limit(1);
      await this.uow
        .current()
        .update(indexerCursors)
        .set({
          nextBlock: fromBlock,
          lastProcessedBlock: input.details.commonAncestorBlock,
          lastProcessedBlockHash: ancestor?.hash ?? null,
          version: sql`${indexerCursors.version} + 1`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(indexerCursors.chainId, input.cursor.chainId),
            eq(indexerCursors.stream, input.cursor.stream),
          ),
        );
      await this.uow
        .current()
        .insert(reorgIncidents)
        .values({
          chainId: input.cursor.chainId,
          stream: input.cursor.stream,
          detectedAtBlock: input.details.detectedAtBlock,
          commonAncestorBlock: input.details.commonAncestorBlock,
          depth: Number(input.details.detectedAtBlock - input.details.commonAncestorBlock),
          oldHeadHash: input.details.oldHeadHash,
          newHeadHash: input.details.newHeadHash,
          status: 'rewound',
          detectedAt: input.now,
          resolvedAt: input.now,
        });
      await this.uow
        .current()
        .insert(outboxEvents)
        .values({
          eventKey: `reorg:${input.cursor.chainId}:${input.cursor.stream}:${input.details.detectedAtBlock}:${input.details.newHeadHash}`,
          eventType: 'indexer_reorg_rewound',
          aggregateType: 'indexer_stream',
          aggregateId: `${input.cursor.chainId}:${input.cursor.stream}`,
          safePayload: {
            commonAncestorBlock: input.details.commonAncestorBlock.toString(),
            depth: (input.details.detectedAtBlock - input.details.commonAncestorBlock).toString(),
          },
          createdAt: input.now,
        })
        .onConflictDoNothing();
    });
  }

  async #rebuildMerchantProjection(input: {
    chainId: ChainId;
    merchantOnchainId: string;
    now: Date;
  }): Promise<void> {
    const [merchant] = await this.uow
      .current()
      .select({
        id: merchants.id,
        ownerUserId: merchants.ownerUserId,
        profile: merchants.profile,
      })
      .from(merchants)
      .where(eq(merchants.onchainMerchantId, input.merchantOnchainId))
      .for('update')
      .limit(1);
    if (merchant === undefined) return;
    const events = await this.uow
      .current()
      .select({
        eventName: canonicalLogs.eventName,
        payload: canonicalLogs.decodedPayload,
        observedAt: canonicalLogs.observedAt,
      })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          inArray(canonicalLogs.eventName, [
            'MerchantCreated',
            'MerchantPayoutUpdated',
            'MerchantStatusChanged',
            'MerchantSuspensionChanged',
            'MerchantMetadataUpdated',
          ]),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'merchantId' = ${input.merchantOnchainId}`,
        ),
      )
      .orderBy(asc(canonicalLogs.blockNumber), asc(canonicalLogs.logIndex));
    const created = events.find((event) => event.eventName === 'MerchantCreated');
    if (created === undefined) {
      const [owner] = await this.uow
        .current()
        .select({ walletAddress: users.walletAddressChecksum })
        .from(users)
        .where(eq(users.id, merchant.ownerUserId))
        .limit(1);
      if (owner === undefined) throw new Error('Merchant owner disappeared during reorg rebuild');
      const profile = { ...merchant.profile };
      delete profile['chainMetadataHash'];
      delete profile['chainActive'];
      delete profile['chainSuspended'];
      await this.uow
        .current()
        .update(merchants)
        .set({
          onchainMerchantId: null,
          payoutAddress: owner.walletAddress,
          payoutAddressLower: owner.walletAddress.toLowerCase(),
          profile,
          status: 'draft',
          chainSyncStatus: 'pending',
          updatedAt: input.now,
          version: sql`${merchants.version} + 1`,
        })
        .where(eq(merchants.id, merchant.id));
      return;
    }
    const createdFields = eventFields({
      eventName: created.eventName,
      decodedPayload: created.payload,
    });
    let payout = createdFields['payout'];
    let active = true;
    let suspended = false;
    let metadataHash = createdFields['metadataHash'];
    if (payout === undefined || metadataHash === undefined) {
      throw new Error('Canonical MerchantCreated is missing rebuild fields');
    }
    for (const event of events) {
      const fields = eventFields({ eventName: event.eventName, decodedPayload: event.payload });
      if (event.eventName === 'MerchantPayoutUpdated') payout = fields['newPayout'] ?? payout;
      if (event.eventName === 'MerchantStatusChanged') active = fields['active'] === 'true';
      if (event.eventName === 'MerchantSuspensionChanged')
        suspended = fields['suspended'] === 'true';
      if (event.eventName === 'MerchantMetadataUpdated')
        metadataHash = fields['newMetadataHash'] ?? metadataHash;
    }
    await this.uow
      .current()
      .update(merchants)
      .set({
        payoutAddress: payout,
        payoutAddressLower: payout.toLowerCase(),
        profile: {
          ...merchant.profile,
          chainMetadataHash: metadataHash,
          chainActive: active ? 'true' : 'false',
          chainSuspended: suspended ? 'true' : 'false',
        },
        status: active && !suspended ? 'active' : 'paused',
        chainSyncStatus: 'confirmed',
        updatedAt: input.now,
        version: sql`${merchants.version} + 1`,
      })
      .where(eq(merchants.id, merchant.id));
  }

  async #rebuildProductProjection(input: {
    chainId: ChainId;
    productOnchainId: string;
    now: Date;
  }): Promise<void> {
    const [product] = await this.uow
      .current()
      .select({ id: products.id })
      .from(products)
      .where(eq(products.onchainProductId, input.productOnchainId))
      .for('update')
      .limit(1);
    if (product === undefined) return;
    const events = await this.uow
      .current()
      .select({
        eventName: canonicalLogs.eventName,
        payload: canonicalLogs.decodedPayload,
        blockNumber: canonicalLogs.blockNumber,
        blockHash: canonicalLogs.blockHash,
      })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          inArray(canonicalLogs.eventName, [
            'ProductCreated',
            'ProductUpdated',
            'ProductStatusChanged',
          ]),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'productId' = ${input.productOnchainId}`,
        ),
      )
      .orderBy(asc(canonicalLogs.blockNumber), asc(canonicalLogs.logIndex));
    const createdIndex = events.findIndex((event) => event.eventName === 'ProductCreated');
    if (createdIndex < 0) {
      await this.uow
        .current()
        .update(products)
        .set({
          onchainProductId: null,
          status: 'publishing',
          chainSyncStatus: 'pending',
          sourceBlockNumber: null,
          sourceBlockHash: null,
          updatedAt: input.now,
        })
        .where(eq(products.id, product.id));
      return;
    }
    let configuration = events[createdIndex];
    let active: boolean | undefined;
    for (const event of events.slice(createdIndex + 1)) {
      if (event.eventName === 'ProductUpdated') configuration = event;
      if (event.eventName === 'ProductStatusChanged') {
        active =
          eventFields({ eventName: event.eventName, decodedPayload: event.payload })['active'] ===
          'true';
      }
    }
    if (configuration === undefined) throw new Error('Product rebuild configuration disappeared');
    const fields = eventFields({
      eventName: configuration.eventName,
      decodedPayload: configuration.payload,
    });
    const requiredField = (name: string): string => {
      const value = fields[name];
      if (value === undefined) throw new Error(`Product rebuild field ${name} is missing`);
      return value;
    };
    const endsAt = BigInt(requiredField('endsAt'));
    const maxSupply = requiredField('maxSupply');
    await this.uow
      .current()
      .update(products)
      .set({
        version: Number(requiredField('version')),
        unitPriceBaseUnits: requiredField('unitPrice'),
        startsAt: new Date(Number(BigInt(requiredField('startsAt')) * 1_000n)),
        endsAt: endsAt === 0n ? null : new Date(Number(endsAt * 1_000n)),
        maxSupply: maxSupply === '0' ? null : maxSupply,
        maxPerOrder: requiredField('maxPerWallet'),
        loyaltyPoints: requiredField('loyaltyPoints'),
        refundWindowSeconds: requiredField('refundWindow'),
        metadataHash: requiredField('metadataHash'),
        status: active === undefined ? 'publishing' : active ? 'active' : 'paused',
        chainSyncStatus: 'confirmed',
        sourceBlockNumber: configuration.blockNumber,
        sourceBlockHash: configuration.blockHash,
        updatedAt: input.now,
      })
      .where(eq(products.id, product.id));
  }

  async #rebuildOrderAfterReorg(input: {
    chainId: ChainId;
    orderKey: string;
    now: Date;
  }): Promise<void> {
    const [record] = await this.uow
      .current()
      .select({ order: orders, signedIntent: signedOrderIntents.intent })
      .from(orders)
      .innerJoin(signedOrderIntents, eq(signedOrderIntents.orderKey, orders.orderKey))
      .where(and(eq(orders.chainId, input.chainId), eq(orders.orderKey, input.orderKey)))
      .for('update')
      .limit(1);
    if (record === undefined) return;

    const [paymentEvent] = await this.uow
      .current()
      .select({ id: canonicalLogs.id, payload: canonicalLogs.decodedPayload })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          eq(canonicalLogs.eventName, 'OrderPaid'),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'orderKey' = ${input.orderKey}`,
        ),
      )
      .orderBy(desc(canonicalLogs.blockNumber), desc(canonicalLogs.logIndex))
      .limit(1);
    if (paymentEvent === undefined) {
      await this.uow
        .current()
        .update(orders)
        .set({
          paidAmountBaseUnits: '0',
          refundedAmountBaseUnits: '0',
          status: 'orphaned',
          transactionHash: null,
          blockNumber: null,
          blockHash: null,
          logIndex: null,
          confirmedAt: null,
          updatedAt: input.now,
          version: sql`${orders.version} + 1`,
        })
        .where(eq(orders.id, record.order.id));
      await this.uow
        .current()
        .update(paymentAttempts)
        .set({
          status: 'confirming',
          reconciliationRequired: true,
          terminalAt: null,
          updatedAt: input.now,
        })
        .where(
          and(eq(paymentAttempts.orderId, record.order.id), eq(paymentAttempts.status, 'paid')),
        );
      await this.uow
        .current()
        .update(settlementCredits)
        .set({
          amountBaseUnits: '0',
          withdrawnBaseUnits: '0',
          status: 'orphaned',
          finalizedEventId: null,
          updatedAt: input.now,
        })
        .where(eq(settlementCredits.orderId, record.order.id));
      await this.uow
        .current()
        .update(receipts)
        .set({ status: 'orphaned', updatedAt: input.now })
        .where(eq(receipts.orderId, record.order.id));
      return;
    }

    const [latestRefund] = await this.uow
      .current()
      .select({ payload: canonicalLogs.decodedPayload })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          eq(canonicalLogs.eventName, 'OrderRefunded'),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'orderKey' = ${input.orderKey}`,
        ),
      )
      .orderBy(desc(canonicalLogs.blockNumber), desc(canonicalLogs.logIndex))
      .limit(1);
    const refunded =
      latestRefund === undefined
        ? '0'
        : eventFields({
            eventName: 'OrderRefunded',
            decodedPayload: latestRefund.payload,
          })['cumulativeRefunded'];
    const signedPlatformFee = record.signedIntent?.['platformFeeBaseUnits'];
    if (refunded === undefined || signedPlatformFee === undefined) {
      throw new Error(
        `Cannot rebuild order ${input.orderKey}: signed accounting evidence is missing`,
      );
    }
    const expectedCredits = expectedFinalizationCredits({
      paidAmountBaseUnits: record.order.paidAmountBaseUnits,
      refundedAmountBaseUnits: refunded,
      signedPlatformFeeBaseUnits: signedPlatformFee,
    });
    const [finalization] = await this.uow
      .current()
      .select({ id: canonicalLogs.id })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          eq(canonicalLogs.eventName, 'OrderFinalized'),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'orderKey' = ${input.orderKey}`,
        ),
      )
      .orderBy(desc(canonicalLogs.blockNumber), desc(canonicalLogs.logIndex))
      .limit(1);
    const orderStatus =
      BigInt(refunded) === 0n
        ? 'paid'
        : BigInt(refunded) === BigInt(record.order.paidAmountBaseUnits)
          ? 'refunded'
          : 'partially_refunded';
    await this.uow
      .current()
      .update(orders)
      .set({
        refundedAmountBaseUnits: refunded,
        status: orderStatus,
        updatedAt: input.now,
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, record.order.id));
    await this.uow
      .current()
      .insert(settlementCredits)
      .values({
        merchantId: record.order.merchantId,
        orderId: record.order.id,
        amountBaseUnits: expectedCredits.merchantBaseUnits,
        withdrawnBaseUnits: '0',
        status: finalization === undefined ? 'refundable' : 'matured',
        maturesAt: record.order.refundableUntil,
        finalizedEventId: finalization?.id ?? null,
        createdAt: record.order.confirmedAt ?? input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: settlementCredits.orderId,
        set: {
          amountBaseUnits: expectedCredits.merchantBaseUnits,
          withdrawnBaseUnits: '0',
          status: finalization === undefined ? 'refundable' : 'matured',
          finalizedEventId: finalization?.id ?? null,
          updatedAt: input.now,
        },
      });
  }

  async #rebuildReceiptAfterReorg(input: {
    chainId: ChainId;
    orderKey: string;
    now: Date;
  }): Promise<void> {
    const [order] = await this.uow
      .current()
      .select({ id: orders.id, recipient: orders.recipient, quantity: orders.quantity })
      .from(orders)
      .where(and(eq(orders.chainId, input.chainId), eq(orders.orderKey, input.orderKey)))
      .limit(1);
    if (order === undefined) return;
    const [payment] = await this.uow
      .current()
      .select({
        id: canonicalLogs.id,
        transactionHash: canonicalLogs.transactionHash,
        payload: canonicalLogs.decodedPayload,
        observedAt: canonicalLogs.observedAt,
      })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          eq(canonicalLogs.eventName, 'OrderPaid'),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'orderKey' = ${input.orderKey}`,
        ),
      )
      .orderBy(desc(canonicalLogs.blockNumber), desc(canonicalLogs.logIndex))
      .limit(1);
    if (payment === undefined) {
      await this.uow
        .current()
        .update(receipts)
        .set({ status: 'orphaned', updatedAt: input.now })
        .where(eq(receipts.orderId, order.id));
      return;
    }
    const paymentFields = eventFields({
      eventName: 'OrderPaid',
      decodedPayload: payment.payload,
    });
    const passTokenId = paymentFields['passTokenId'];
    if (passTokenId === undefined) {
      throw new Error(
        `Cannot rebuild receipt for ${input.orderKey}: payment payload is incomplete`,
      );
    }
    const transfers = await this.uow
      .current()
      .select({
        id: canonicalLogs.id,
        payload: canonicalLogs.decodedPayload,
        observedAt: canonicalLogs.observedAt,
      })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          eq(canonicalLogs.eventName, 'TransferSingle'),
          eq(canonicalLogs.transactionHash, payment.transactionHash),
        ),
      );
    const transfer = transfers.find((candidate) => {
      const fields = eventFields({
        eventName: 'TransferSingle',
        decodedPayload: candidate.payload,
      });
      return (
        /^0x0{40}$/i.test(fields['from'] ?? '') &&
        sameAddressForRebuild(fields['to'], order.recipient) &&
        fields['id'] === passTokenId &&
        fields['value'] === order.quantity
      );
    });
    const [revocation] = await this.uow
      .current()
      .select({ id: canonicalLogs.id })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          eq(canonicalLogs.eventName, 'PassRevoked'),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'orderKey' = ${input.orderKey}`,
        ),
      )
      .orderBy(desc(canonicalLogs.blockNumber), desc(canonicalLogs.logIndex))
      .limit(1);
    await this.uow
      .current()
      .update(receipts)
      .set({
        tokenId: passTokenId,
        status:
          revocation !== undefined ? 'revoked' : transfer === undefined ? 'expected' : 'issued',
        chainEventId: transfer?.id ?? payment.id,
        issuedAt: transfer?.observedAt ?? null,
        updatedAt: input.now,
      })
      .where(eq(receipts.orderId, order.id));
  }

  async #rebuildMerchantWithdrawals(input: {
    chainId: ChainId;
    merchantOnchainId: string;
    now: Date;
  }): Promise<void> {
    const [merchant] = await this.uow
      .current()
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.onchainMerchantId, input.merchantOnchainId))
      .limit(1);
    if (merchant === undefined) return;
    const canonicalWithdrawals = await this.uow
      .current()
      .select({ payload: canonicalLogs.decodedPayload })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.projectionStatus, 'applied'),
          eq(canonicalLogs.eventName, 'MerchantWithdrawal'),
          sql`${canonicalLogs.decodedPayload}->'fields'->>'merchantId' = ${input.merchantOnchainId}`,
        ),
      );
    const total = canonicalWithdrawals.reduce((sum, event) => {
      const amount = eventFields({
        eventName: 'MerchantWithdrawal',
        decodedPayload: event.payload,
      })['amount'];
      if (amount === undefined) throw new Error('Canonical withdrawal payload is incomplete');
      return sum + BigInt(amount);
    }, 0n);
    const credits = await this.uow
      .current()
      .select()
      .from(settlementCredits)
      .where(
        and(
          eq(settlementCredits.merchantId, merchant.id),
          inArray(settlementCredits.status, ['matured', 'withdrawn']),
        ),
      )
      .orderBy(asc(settlementCredits.createdAt), asc(settlementCredits.id))
      .for('update')
      .limit(10_000);
    const resetCredits = credits.map((credit) => ({
      id: credit.id,
      amountBaseUnits: credit.amountBaseUnits,
      withdrawnBaseUnits: '0',
    }));
    const plan = total === 0n ? [] : planWithdrawalDebits(resetCredits, total.toString());
    if (plan === undefined) {
      throw new Error(
        `Canonical withdrawals exceed rebuilt merchant credit for ${input.merchantOnchainId}`,
      );
    }
    if (credits.length > 0) {
      await this.uow
        .current()
        .update(settlementCredits)
        .set({ withdrawnBaseUnits: '0', status: 'matured', updatedAt: input.now })
        .where(
          inArray(
            settlementCredits.id,
            credits.map((credit) => credit.id),
          ),
        );
    }
    for (const debit of plan) {
      await this.uow
        .current()
        .update(settlementCredits)
        .set({
          withdrawnBaseUnits: debit.withdrawnBaseUnits,
          status: debit.fullyWithdrawn ? 'withdrawn' : 'matured',
          updatedAt: input.now,
        })
        .where(eq(settlementCredits.id, debit.creditId));
    }
  }

  async replayQuarantined(input: {
    chainId: ChainId;
    stream: string;
    limit: number;
    now: Date;
  }): Promise<number> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RangeError('Quarantine replay limit must be between one and one thousand');
    }
    return this.uow.transaction(async () => {
      const records = await this.uow
        .current()
        .select({ log: canonicalLogs, quarantineId: chainEventQuarantine.id })
        .from(chainEventQuarantine)
        .innerJoin(canonicalLogs, eq(canonicalLogs.id, chainEventQuarantine.canonicalLogId))
        .where(
          and(
            eq(canonicalLogs.chainId, input.chainId),
            eq(canonicalLogs.stream, input.stream),
            eq(canonicalLogs.canonical, true),
            isNull(chainEventQuarantine.resolvedAt),
          ),
        )
        .orderBy(asc(canonicalLogs.blockNumber), asc(canonicalLogs.logIndex))
        .limit(input.limit);
      let applied = 0;
      for (const record of records) {
        const decoded = readStoredDecoded(record.log.decodedPayload, record.log.eventName);
        const confirmations = record.log.decodedPayload['confirmations'];
        if (decoded === undefined || typeof confirmations !== 'string') continue;
        const result = await this.#projector.apply({
          canonicalLogId: record.log.id,
          decoded,
          position: {
            chainId: record.log.chainId,
            contractAddress: record.log.contractAddress,
            transactionHash: record.log.transactionHash,
            blockNumber: record.log.blockNumber,
            blockHash: record.log.blockHash,
            logIndex: record.log.logIndex,
            confirmations: BigInt(confirmations),
            observedAt: record.log.observedAt,
          },
        });
        if (result.kind !== 'applied') continue;
        await this.uow
          .current()
          .update(canonicalLogs)
          .set({ projectionStatus: 'applied', mismatchCode: null, projectedAt: input.now })
          .where(eq(canonicalLogs.id, record.log.id));
        await this.uow
          .current()
          .update(chainEventQuarantine)
          .set({ resolvedAt: input.now, resolution: 'replayed' })
          .where(eq(chainEventQuarantine.id, record.quarantineId));
        applied += 1;
      }
      return applied;
    });
  }

  async loadQuarantinedLogs(input: {
    chainId: ChainId;
    stream: string;
    decoderVersion: string;
    limit: number;
  }): Promise<
    readonly {
      canonicalLogId: string;
      chainId: ChainId;
      stream: string;
      contractAddress: EvmAddress;
      transactionHash: TransactionHash;
      blockNumber: bigint;
      blockHash: `0x${string}`;
      logIndex: number;
      payloadDigest: `0x${string}`;
      observedAt: Date;
    }[]
  > {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RangeError('Quarantine recovery limit must be between one and one thousand');
    }
    const records = await this.uow
      .current()
      .select({ log: canonicalLogs })
      .from(chainEventQuarantine)
      .innerJoin(canonicalLogs, eq(canonicalLogs.id, chainEventQuarantine.canonicalLogId))
      .where(
        and(
          eq(canonicalLogs.chainId, input.chainId),
          eq(canonicalLogs.stream, input.stream),
          eq(canonicalLogs.canonical, true),
          eq(canonicalLogs.eventName, '__quarantined__'),
          sql`${canonicalLogs.decodedPayload}->>'decoderVersion' <> ${input.decoderVersion}`,
          isNull(chainEventQuarantine.resolvedAt),
        ),
      )
      .orderBy(asc(canonicalLogs.blockNumber), asc(canonicalLogs.logIndex))
      .limit(input.limit);
    return records.map(({ log }) => ({
      canonicalLogId: log.id,
      chainId: ChainIdSchema.parse(log.chainId),
      stream: log.stream,
      contractAddress: EvmAddressSchema.parse(log.contractAddress),
      transactionHash: TransactionHashSchema.parse(log.transactionHash),
      blockNumber: log.blockNumber,
      blockHash: log.blockHash as `0x${string}`,
      logIndex: log.logIndex,
      payloadDigest: log.payloadDigest as `0x${string}`,
      observedAt: log.observedAt,
    }));
  }

  async reprocessQuarantinedLog(input: {
    canonicalLogId: string;
    log: DatabaseIndexedLog;
    now: Date;
  }): Promise<boolean> {
    return this.uow.transaction(async () => {
      const [record] = await this.uow
        .current()
        .select({ log: canonicalLogs, quarantine: chainEventQuarantine })
        .from(canonicalLogs)
        .innerJoin(chainEventQuarantine, eq(chainEventQuarantine.canonicalLogId, canonicalLogs.id))
        .where(
          and(
            eq(canonicalLogs.id, input.canonicalLogId),
            eq(canonicalLogs.canonical, true),
            eq(canonicalLogs.projectionStatus, 'quarantined'),
            isNull(chainEventQuarantine.resolvedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (record === undefined) return false;
      const raw = input.log.raw;
      if (
        record.log.chainId !== raw.chainId ||
        record.log.stream.length === 0 ||
        record.log.contractAddress.toLowerCase() !== raw.contractAddress.toLowerCase() ||
        record.log.transactionHash.toLowerCase() !== raw.transactionHash.toLowerCase() ||
        record.log.blockNumber !== BigInt(raw.blockNumber) ||
        record.log.blockHash.toLowerCase() !== raw.blockHash.toLowerCase() ||
        record.log.logIndex !== Number(raw.logIndex) ||
        record.log.payloadDigest.toLowerCase() !== input.log.payloadDigest.toLowerCase()
      ) {
        throw new AppError(
          'RPC_INCONSISTENT',
          'Quarantined log recovery did not match the persisted canonical identity.',
        );
      }
      if (input.log.decoded.kind === 'quarantined') {
        await this.uow
          .current()
          .update(canonicalLogs)
          .set({
            decodedPayload: decodedPayload(input.log),
            mismatchCode: input.log.decoded.reasonCode,
            projectedAt: input.now,
          })
          .where(eq(canonicalLogs.id, record.log.id));
        await this.uow
          .current()
          .update(chainEventQuarantine)
          .set({
            reasonCode: input.log.decoded.reasonCode,
            safeDetails: { ...input.log.decoded.safeDetails },
          })
          .where(eq(chainEventQuarantine.id, record.quarantine.id));
        return false;
      }
      await this.uow
        .current()
        .update(canonicalLogs)
        .set({
          eventName: input.log.decoded.event.eventName,
          decodedPayload: decodedPayload(input.log),
          projectionStatus: 'pending',
          mismatchCode: null,
          projectedAt: null,
        })
        .where(eq(canonicalLogs.id, record.log.id));
      const result = await this.#projector.apply({
        canonicalLogId: record.log.id,
        decoded: input.log.decoded.event,
        position: {
          chainId: raw.chainId,
          contractAddress: raw.contractAddress,
          transactionHash: raw.transactionHash,
          blockNumber: BigInt(raw.blockNumber),
          blockHash: raw.blockHash,
          logIndex: Number(raw.logIndex),
          confirmations: input.log.confirmations,
          observedAt: record.log.observedAt,
        },
      });
      if (result.kind === 'quarantined') {
        await this.uow
          .current()
          .update(canonicalLogs)
          .set({
            projectionStatus: 'quarantined',
            mismatchCode: result.reasonCode,
            projectedAt: input.now,
          })
          .where(eq(canonicalLogs.id, record.log.id));
        await this.uow
          .current()
          .update(chainEventQuarantine)
          .set({ reasonCode: result.reasonCode, safeDetails: { ...result.safeDetails } })
          .where(eq(chainEventQuarantine.id, record.quarantine.id));
        return false;
      }
      await this.uow
        .current()
        .update(canonicalLogs)
        .set({ projectionStatus: 'applied', mismatchCode: null, projectedAt: input.now })
        .where(eq(canonicalLogs.id, record.log.id));
      await this.uow
        .current()
        .update(chainEventQuarantine)
        .set({ resolvedAt: input.now, resolution: 'redecoded' })
        .where(eq(chainEventQuarantine.id, record.quarantine.id));
      return true;
    });
  }

  async #quarantine(input: {
    canonicalLogId: string;
    reasonCode: string;
    safeDetails: Readonly<Record<string, string>>;
    now: Date;
  }): Promise<void> {
    await this.uow
      .current()
      .update(canonicalLogs)
      .set({
        projectionStatus: 'quarantined',
        mismatchCode: input.reasonCode,
        projectedAt: input.now,
      })
      .where(eq(canonicalLogs.id, input.canonicalLogId));
    await this.uow
      .current()
      .insert(chainEventQuarantine)
      .values({
        canonicalLogId: input.canonicalLogId,
        reasonCode: input.reasonCode,
        safeDetails: { ...input.safeDetails },
        createdAt: input.now,
      })
      .onConflictDoNothing();
  }
}
