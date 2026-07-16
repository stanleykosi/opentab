import type {
  SponsorGrantReconciliationStorePort,
  SponsorGrantRecord,
  SponsorGrantStorePort,
} from '@opentab/application';
import {
  AppError,
  BaseUnitAmountSchema,
  Bytes32Schema,
  type EvmAddress,
  EvmAddressSchema,
  TransactionHashSchema,
} from '@opentab/shared';
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { bootstrapGrants, outboxEvents, sponsorAuditEvents } from './schema/index.js';
import { PostgresSponsorBudget } from './sponsor-budget.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

function toGrant(record: typeof bootstrapGrants.$inferSelect): SponsorGrantRecord {
  return {
    id: record.id,
    userId: record.userId,
    recipient: EvmAddressSchema.parse(record.recipientAddressLower),
    amountWei: BaseUnitAmountSchema.parse(record.amountWei),
    status: record.status,
    ...(record.transactionHash === null ? {} : { transactionHash: record.transactionHash }),
    ...(record.sponsorSignerAddressLower === null
      ? {}
      : { sponsorSignerAddress: EvmAddressSchema.parse(record.sponsorSignerAddressLower) }),
    ...(record.signerNonce === null ? {} : { signerNonce: record.signerNonce }),
    createdAt: record.createdAt.toISOString(),
  };
}

export class PostgresSponsorGrantStore implements SponsorGrantStorePort {
  readonly #budgets: PostgresSponsorBudget;

  constructor(private readonly uow: PostgresUnitOfWork) {
    this.#budgets = new PostgresSponsorBudget(uow);
  }

  async pendingAmountWei(input: { environment: string; recipient: EvmAddress }): Promise<bigint> {
    const [result] = await this.uow
      .current()
      .select({ amount: sql<string>`coalesce(sum(${bootstrapGrants.amountWei}), 0)::text` })
      .from(bootstrapGrants)
      .where(
        and(
          eq(
            bootstrapGrants.environment,
            input.environment as typeof bootstrapGrants.$inferInsert.environment,
          ),
          eq(bootstrapGrants.recipientAddressLower, input.recipient.toLowerCase()),
          inArray(bootstrapGrants.status, [
            'created',
            'submission_started',
            'submitted',
            'submitted_unknown',
            'orphaned',
          ]),
        ),
      );
    return BigInt(result?.amount ?? '0');
  }

  async reserveAndCreate(
    input: Parameters<SponsorGrantStorePort['reserveAndCreate']>[0],
  ): Promise<SponsorGrantRecord> {
    return this.uow.transaction(async () => {
      const [existing] = await this.uow
        .current()
        .select()
        .from(bootstrapGrants)
        .where(
          and(
            eq(bootstrapGrants.environment, input.environment),
            eq(bootstrapGrants.recipientAddressLower, input.recipient.toLowerCase()),
          ),
        )
        .for('update')
        .limit(1);
      if (existing !== undefined) {
        if (
          existing.userId !== input.userId ||
          existing.magicIssuerHash !== input.identitySubjectHash
        ) {
          throw new AppError(
            'SPONSOR_INELIGIBLE',
            'This recipient is already bound to another sponsor identity.',
          );
        }
        return toGrant(existing);
      }
      await this.#budgets.reserve({
        environment: input.environment,
        budgetDate: input.budgetDate,
        amountWei: input.amountWei,
        dimensions: input.budgets,
      });
      const [created] = await this.uow
        .current()
        .insert(bootstrapGrants)
        .values({
          environment: input.environment,
          userId: input.userId,
          magicIssuerHash: input.identitySubjectHash,
          recipientAddressLower: input.recipient.toLowerCase(),
          idempotencyKeyHash: input.idempotencyKeyHash,
          eligibilityReason: 'eligible',
          balanceBeforeWei: input.balanceBeforeWei.toString(),
          targetWei: input.targetWei.toString(),
          amountWei: input.amountWei.toString(),
          status: 'created',
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (created === undefined) throw new Error('Failed to reserve bootstrap grant');
      await this.uow
        .current()
        .insert(sponsorAuditEvents)
        .values({
          grantId: created.id,
          userId: created.userId,
          action: 'grant_reserved',
          decision: 'eligible',
          requestId: input.requestId,
          safeMetadata: { amountWei: created.amountWei, environment: created.environment },
          createdAt: input.now,
        });
      return toGrant(created);
    });
  }

  async findById(id: string): Promise<SponsorGrantRecord | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(bootstrapGrants)
      .where(eq(bootstrapGrants.id, id))
      .limit(1);
    return record === undefined ? undefined : toGrant(record);
  }

  async markSubmissionStarted(
    input: Parameters<SponsorGrantStorePort['markSubmissionStarted']>[0],
  ): Promise<SponsorGrantRecord> {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(bootstrapGrants)
        .where(eq(bootstrapGrants.id, input.id))
        .for('update')
        .limit(1);
      if (current === undefined) {
        throw new AppError('NOT_FOUND', 'The bootstrap grant was not found.');
      }
      const signerAddress = EvmAddressSchema.parse(input.sponsorSignerAddress).toLowerCase();
      const signerNonce = BaseUnitAmountSchema.parse(input.signerNonce);
      if (current.status !== 'created') {
        if (
          current.status === 'submission_started' &&
          current.sponsorSignerAddressLower === signerAddress &&
          current.signerNonce === signerNonce
        ) {
          return toGrant(current);
        }
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The sponsor grant already crossed a different submission boundary.',
        );
      }
      await this.uow
        .current()
        .execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`sponsor-nonce:${current.environment}:${signerAddress}`}, 0))`,
        );
      const [claimed] = await this.uow
        .current()
        .select({ id: bootstrapGrants.id })
        .from(bootstrapGrants)
        .where(
          and(
            eq(bootstrapGrants.environment, current.environment),
            eq(bootstrapGrants.sponsorSignerAddressLower, signerAddress),
            eq(bootstrapGrants.signerNonce, signerNonce),
            ne(bootstrapGrants.id, current.id),
          ),
        )
        .limit(1);
      if (claimed !== undefined) {
        throw new AppError(
          'SPONSOR_SUBMISSION_UNKNOWN',
          'The sponsor nonce is already durably assigned to another grant.',
          { retryable: true },
        );
      }
      const [updated] = await this.uow
        .current()
        .update(bootstrapGrants)
        .set({
          status: 'submission_started',
          sponsorSignerAddressLower: signerAddress,
          signerNonce,
          submissionStartedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(eq(bootstrapGrants.id, input.id), eq(bootstrapGrants.status, 'created')))
        .returning();
      if (updated === undefined) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The sponsor grant changed concurrently.');
      }
      await this.uow
        .current()
        .insert(outboxEvents)
        .values({
          eventKey: `bootstrap-grant:${updated.id}:submission-started`,
          eventType: 'bootstrap_grant_submission_started',
          aggregateType: 'bootstrap_grant',
          aggregateId: updated.id,
          safePayload: {
            grantId: updated.id,
            signerNonce,
          },
          createdAt: input.now,
        });
      return toGrant(updated);
    });
  }

  async markTransactionPrepared(
    input: Parameters<SponsorGrantStorePort['markTransactionPrepared']>[0],
  ): Promise<SponsorGrantRecord> {
    return this.uow.transaction(async () => {
      const transactionHash = TransactionHashSchema.parse(input.transactionHash);
      const signerNonce = BaseUnitAmountSchema.parse(input.signerNonce);
      const [current] = await this.uow
        .current()
        .select()
        .from(bootstrapGrants)
        .where(eq(bootstrapGrants.id, input.id))
        .for('update')
        .limit(1);
      if (current === undefined) {
        throw new AppError('NOT_FOUND', 'The bootstrap grant was not found.');
      }
      if (current.status !== 'submission_started' || current.signerNonce !== signerNonce) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The sponsor transaction does not match its durable submission boundary.',
        );
      }
      if (current.transactionHash === transactionHash) return toGrant(current);
      const transactionHashCandidates = current.transactionHashCandidates.map((candidate) =>
        TransactionHashSchema.parse(candidate),
      );
      if (
        !transactionHashCandidates.includes(transactionHash) &&
        transactionHashCandidates.length >= 4
      ) {
        throw new AppError(
          'SPONSOR_SUBMISSION_UNKNOWN',
          'The sponsor transaction reached its bounded recovery-attempt limit.',
          { retryable: false, submissionPossible: true },
        );
      }
      const nextCandidates = transactionHashCandidates.includes(transactionHash)
        ? transactionHashCandidates
        : [...transactionHashCandidates, transactionHash];
      const [updated] = await this.uow
        .current()
        .update(bootstrapGrants)
        .set({
          transactionHash,
          transactionHashCandidates: nextCandidates,
          updatedAt: input.now,
        })
        .where(
          and(eq(bootstrapGrants.id, input.id), eq(bootstrapGrants.status, 'submission_started')),
        )
        .returning();
      if (updated === undefined) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The sponsor grant changed concurrently.');
      }
      await this.uow
        .current()
        .insert(outboxEvents)
        .values({
          eventKey: `bootstrap-grant:${updated.id}:transaction-prepared:${transactionHash}`,
          eventType: 'bootstrap_grant_transaction_prepared',
          aggregateType: 'bootstrap_grant',
          aggregateId: updated.id,
          safePayload: { grantId: updated.id, transactionHash },
          createdAt: input.now,
        });
      return toGrant(updated);
    });
  }

  async markTransferResult(
    input: Parameters<SponsorGrantStorePort['markTransferResult']>[0],
  ): Promise<SponsorGrantRecord> {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(bootstrapGrants)
        .where(eq(bootstrapGrants.id, input.id))
        .for('update')
        .limit(1);
      if (current === undefined)
        throw new AppError('NOT_FOUND', 'The bootstrap grant was not found.');
      if (current.status !== 'submission_started') {
        if (
          input.result.status === 'submitted' &&
          current.transactionHash !== input.result.transactionHash
        ) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'A different grant transaction is already recorded.',
          );
        }
        return toGrant(current);
      }
      if (
        current.transactionHash === null ||
        current.transactionHash !== TransactionHashSchema.parse(input.result.transactionHash)
      ) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The sponsor transfer result does not match the prepared transaction.',
        );
      }
      if (current.signerNonce !== BaseUnitAmountSchema.parse(input.result.signerNonce)) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The sponsor transfer result does not match the reserved signer nonce.',
        );
      }
      const [updated] = await this.uow
        .current()
        .update(bootstrapGrants)
        .set({
          status: input.result.status,
          ...(input.result.status === 'submitted'
            ? { transactionHash: TransactionHashSchema.parse(input.result.transactionHash) }
            : {}),
          signerNonce: input.result.signerNonce,
          submittedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(bootstrapGrants.id, input.id))
        .returning();
      if (updated === undefined) throw new Error('Failed to record bootstrap transfer');
      await this.uow
        .current()
        .insert(outboxEvents)
        .values({
          eventKey: `bootstrap-grant:${updated.id}:${updated.status}`,
          eventType: 'bootstrap_grant_status_changed',
          aggregateType: 'bootstrap_grant',
          aggregateId: updated.id,
          safePayload: {
            grantId: updated.id,
            status: updated.status,
            amountWei: updated.amountWei,
          },
          createdAt: input.now,
        });
      return toGrant(updated);
    });
  }

  async markReplaced(
    input: Parameters<SponsorGrantStorePort['markReplaced']>[0],
  ): Promise<SponsorGrantRecord> {
    return this.uow.transaction(async () => {
      const [updated] = await this.uow
        .current()
        .update(bootstrapGrants)
        .set({ status: 'replaced', errorCode: input.reason, updatedAt: input.now })
        .where(
          and(
            eq(bootstrapGrants.id, input.id),
            eq(bootstrapGrants.status, 'submission_started'),
            sql`${bootstrapGrants.transactionHash} is null`,
          ),
        )
        .returning();
      if (updated === undefined) {
        const current = await this.findById(input.id);
        if (current !== undefined && current.status === 'replaced') return current;
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The sponsor grant cannot be marked replaced from its current state.',
        );
      }
      await this.uow
        .current()
        .insert(outboxEvents)
        .values({
          eventKey: `bootstrap-grant:${updated.id}:replaced`,
          eventType: 'bootstrap_grant_status_changed',
          aggregateType: 'bootstrap_grant',
          aggregateId: updated.id,
          safePayload: { grantId: updated.id, status: 'replaced' },
          createdAt: input.now,
        });
      return toGrant(updated);
    });
  }

  async markFailed(input: Parameters<SponsorGrantStorePort['markFailed']>[0]): Promise<void> {
    await this.uow.transaction(async () => {
      const [updated] = await this.uow
        .current()
        .update(bootstrapGrants)
        .set({ status: 'failed', errorCode: input.errorCode, updatedAt: input.now })
        .where(and(eq(bootstrapGrants.id, input.id), eq(bootstrapGrants.status, 'created')))
        .returning({ id: bootstrapGrants.id, userId: bootstrapGrants.userId });
      if (updated === undefined) return;
      await this.uow
        .current()
        .insert(sponsorAuditEvents)
        .values({
          grantId: updated.id,
          userId: updated.userId,
          action: 'grant_failed',
          decision: input.errorCode,
          requestId: `grant-${updated.id}`,
          safeMetadata: {},
          createdAt: input.now,
        });
    });
  }
}

export class PostgresSponsorGrantReconciliationStore
  implements SponsorGrantReconciliationStorePort
{
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async listCandidates(input: { limit: number }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 250) {
      throw new AppError('VALIDATION_FAILED', 'Sponsor reconciliation limit is invalid.');
    }
    const records = await this.uow
      .current()
      .select()
      .from(bootstrapGrants)
      .where(
        and(
          inArray(bootstrapGrants.status, [
            'submission_started',
            'submitted',
            'submitted_unknown',
            'confirmed',
            'orphaned',
          ]),
          isNotNull(bootstrapGrants.transactionHash),
          isNotNull(bootstrapGrants.sponsorSignerAddressLower),
          isNotNull(bootstrapGrants.signerNonce),
        ),
      )
      .orderBy(asc(bootstrapGrants.updatedAt), asc(bootstrapGrants.id))
      .limit(input.limit);
    return records.map((record) => {
      if (
        record.transactionHash === null ||
        record.sponsorSignerAddressLower === null ||
        record.signerNonce === null
      ) {
        throw new AppError('INTERNAL_ERROR', 'A sponsor reconciliation row is incomplete.');
      }
      return {
        id: record.id,
        status: record.status as
          | 'submission_started'
          | 'submitted'
          | 'submitted_unknown'
          | 'confirmed'
          | 'orphaned',
        recipient: EvmAddressSchema.parse(record.recipientAddressLower),
        amountWei: BaseUnitAmountSchema.parse(record.amountWei),
        sponsorSignerAddress: EvmAddressSchema.parse(record.sponsorSignerAddressLower),
        signerNonce: record.signerNonce,
        transactionHashes: record.transactionHashCandidates.map((candidate) =>
          TransactionHashSchema.parse(candidate),
        ),
        transactionHash: TransactionHashSchema.parse(record.transactionHash),
        ...(record.blockNumber === null ? {} : { blockNumber: record.blockNumber.toString() }),
        ...(record.blockHash === null ? {} : { blockHash: record.blockHash }),
      };
    });
  }

  async markCanonicalOutcome(
    input: Parameters<SponsorGrantReconciliationStorePort['markCanonicalOutcome']>[0],
  ): Promise<void> {
    await this.uow.transaction(async () => {
      const transactionHash = TransactionHashSchema.parse(input.expectedTransactionHash);
      const [current] = await this.uow
        .current()
        .select()
        .from(bootstrapGrants)
        .where(eq(bootstrapGrants.id, input.id))
        .for('update')
        .limit(1);
      if (current === undefined || !current.transactionHashCandidates.includes(transactionHash)) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The sponsor reconciliation binding changed.');
      }
      if (input.outcome === 'orphaned') {
        if (current.status === 'orphaned') return;
        if (current.status !== 'confirmed') return;
        await this.uow
          .current()
          .update(bootstrapGrants)
          .set({
            status: 'orphaned',
            blockNumber: null,
            blockHash: null,
            confirmedAt: null,
            errorCode: 'SPONSOR_RECEIPT_REORGED',
            updatedAt: input.now,
          })
          .where(eq(bootstrapGrants.id, input.id));
      } else {
        const blockNumber = BigInt(BaseUnitAmountSchema.parse(input.blockNumber));
        const blockHash = Bytes32Schema.parse(input.blockHash);
        if (input.outcome === 'confirmed' && current.status === 'confirmed') {
          if (current.blockNumber === blockNumber && current.blockHash === blockHash) return;
          throw new AppError(
            'RPC_INCONSISTENT',
            'Confirmed sponsor proof changed without reorg handling.',
          );
        }
        if (
          !['submission_started', 'submitted', 'submitted_unknown', 'orphaned'].includes(
            current.status,
          )
        )
          return;
        await this.uow
          .current()
          .update(bootstrapGrants)
          .set({
            status: input.outcome,
            transactionHash,
            blockNumber,
            blockHash,
            confirmedAt: input.now,
            errorCode: input.outcome === 'failed' ? input.errorCode : null,
            updatedAt: input.now,
          })
          .where(eq(bootstrapGrants.id, input.id));
      }
      const status = input.outcome;
      await this.uow
        .current()
        .insert(outboxEvents)
        .values({
          eventKey: `bootstrap-grant:${input.id}:${status}:${transactionHash}`,
          eventType: 'bootstrap_grant_canonical_status_changed',
          aggregateType: 'bootstrap_grant',
          aggregateId: input.id,
          safePayload: { grantId: input.id, status, transactionHash },
          createdAt: input.now,
        })
        .onConflictDoNothing({ target: outboxEvents.eventKey });
      await this.uow
        .current()
        .insert(sponsorAuditEvents)
        .values({
          grantId: input.id,
          userId: current.userId,
          action: 'grant_reconciled',
          decision: status,
          requestId: `grant-reconcile-${input.id}`,
          safeMetadata: { transactionHash },
          createdAt: input.now,
        });
    });
  }
}
