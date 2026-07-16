import { createHash } from 'node:crypto';
import type {
  PaymentReconciliationCandidate,
  PaymentReconciliationStorePort,
} from '@opentab/application';
import {
  EvidenceDigestSchema,
  EvmAddressSchema,
  PaymentAttemptIdSchema,
  ProviderOperationIdSchema,
  TransactionHashSchema,
} from '@opentab/shared';
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { deadLetters, orders, paymentAttempts, providerOperations } from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

/** Database adapter for the worker's bounded provider-operation reconciler. */
export class PostgresPaymentReconciliationStore implements PaymentReconciliationStorePort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async load(
    attemptId: ReturnType<typeof PaymentAttemptIdSchema.parse>,
  ): Promise<PaymentReconciliationCandidate | undefined> {
    const [record] = await this.uow
      .current()
      .select({ attempt: paymentAttempts, ownerAddress: orders.payer })
      .from(paymentAttempts)
      .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
      .where(eq(paymentAttempts.id, attemptId))
      .limit(1);
    if (record === undefined) return undefined;
    return this.#candidate(record.attempt, record.ownerAddress);
  }

  async listPending(limit: number): Promise<readonly PaymentReconciliationCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Reconciliation recovery limit is invalid');
    }
    const records = await this.uow
      .current()
      .select({ attempt: paymentAttempts, ownerAddress: orders.payer })
      .from(paymentAttempts)
      .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
      .where(
        or(
          and(
            eq(paymentAttempts.reconciliationRequired, true),
            inArray(paymentAttempts.status, [
              'submission_started',
              'submitted',
              'submitted_unknown',
              'executing',
              'confirming',
            ]),
          ),
          and(
            eq(paymentAttempts.status, 'paid'),
            isNotNull(paymentAttempts.providerOperationId),
            isNotNull(paymentAttempts.destinationTransactionHash),
            sql`not exists (
              select 1
              from ${providerOperations} final_provider
              where final_provider.payment_attempt_id = ${paymentAttempts.id}
                and final_provider.provider = 'particle'
                and final_provider.external_id = ${paymentAttempts.providerOperationId}
                and final_provider.kind = 'checkout'
                and final_provider.status = 'succeeded'
                and final_provider.submission_possible = true
                and lower(final_provider.destination_transaction_hash) = lower(${paymentAttempts.destinationTransactionHash})
                and final_provider.safe_summary ->> 'adapter' = 'particle-get-transaction'
                and final_provider.safe_summary ? 'finalObservedAt'
                and final_provider.safe_summary ? 'providerUpdatedAt'
            )`,
          ),
        ),
      )
      .orderBy(asc(paymentAttempts.updatedAt), asc(paymentAttempts.id))
      .limit(limit);
    return records.map((record) => this.#candidate(record.attempt, record.ownerAddress));
  }

  async recordDeadLetter(input: {
    attemptId: ReturnType<typeof PaymentAttemptIdSchema.parse>;
    deliveryAttempt: number;
    reason: string;
    now: Date;
  }): Promise<void> {
    if (
      !Number.isSafeInteger(input.deliveryAttempt) ||
      input.deliveryAttempt < 1 ||
      input.reason.length < 1 ||
      input.reason.length > 80
    ) {
      throw new RangeError('Reconciliation dead-letter input is invalid');
    }
    const digest = EvidenceDigestSchema.parse(
      `0x${createHash('sha256')
        .update(`payment-reconcile\0${input.attemptId}\0${input.reason}`, 'utf8')
        .digest('hex')}`,
    );
    await this.uow
      .current()
      .insert(deadLetters)
      .values({
        kind: 'payment-reconcile',
        businessKey: input.attemptId,
        safePayload: {
          attemptId: input.attemptId,
          deliveryAttempt: input.deliveryAttempt.toString(),
        },
        errorCode: input.reason,
        errorDigest: digest,
        createdAt: input.now,
      })
      .onConflictDoNothing({
        target: [deadLetters.kind, deadLetters.businessKey],
      });
  }

  #candidate(
    record: typeof paymentAttempts.$inferSelect,
    ownerAddress: string,
  ): PaymentReconciliationCandidate {
    return {
      attemptId: PaymentAttemptIdSchema.parse(record.id),
      ownerAddress: EvmAddressSchema.parse(ownerAddress),
      ...(record.providerOperationId === null
        ? {}
        : { providerOperationId: ProviderOperationIdSchema.parse(record.providerOperationId) }),
      status: record.status,
      reconciliationRequired: record.reconciliationRequired,
    };
  }

  async recordProviderObservation(
    input: Parameters<PaymentReconciliationStorePort['recordProviderObservation']>[0],
  ): Promise<'updated' | 'already_terminal' | 'concurrent_change'> {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.candidate.attemptId))
        .for('update')
        .limit(1);
      if (current === undefined || current.status === 'failed_confirmed') {
        return 'already_terminal' as const;
      }
      if (
        current.status !== input.candidate.status ||
        current.providerOperationId !== input.candidate.providerOperationId
      ) {
        return 'concurrent_change' as const;
      }
      const observingAfterCanonicalPayment = current.status === 'paid';
      if (!observingAfterCanonicalPayment && !current.reconciliationRequired) {
        return 'already_terminal' as const;
      }
      if (
        current.providerOperationId === null ||
        current.providerOperationId !== input.operation.id ||
        (observingAfterCanonicalPayment &&
          (input.operation.status !== 'succeeded' ||
            !input.operation.submissionPossible ||
            current.destinationTransactionHash === null ||
            input.operation.destinationTransactionHash?.toLowerCase() !==
              current.destinationTransactionHash.toLowerCase() ||
            input.operation.evidence.adapter !== 'particle-get-transaction'))
      ) {
        return 'concurrent_change' as const;
      }

      const safeSummary = {
        adapter: input.operation.evidence.adapter,
        environment: input.operation.evidence.environment,
        packageVersion: input.operation.evidence.packageVersion,
        provenance: input.operation.evidence.provenance,
        schemaVersion: input.operation.evidence.schemaVersion.toString(),
        finalObservedAt: input.operation.evidence.observedAt,
        providerUpdatedAt: input.operation.updatedAt,
      };
      const providerValues = {
        provider: 'particle',
        externalId: input.operation.id,
        paymentAttemptId: current.id,
        kind: 'checkout',
        status: input.operation.status,
        submissionPossible: input.operation.submissionPossible,
        ...(input.operation.destinationTransactionHash === undefined
          ? {}
          : { destinationTransactionHash: input.operation.destinationTransactionHash }),
        ...(input.operation.activityUrl === undefined
          ? {}
          : { activityUrl: input.operation.activityUrl }),
        evidenceDigest: input.operation.evidence.evidenceDigest,
        safeSummary,
        observedAt: new Date(input.operation.evidence.observedAt),
        createdAt: input.now,
        updatedAt: input.now,
      } as const;
      const existingRows = await this.uow
        .current()
        .select()
        .from(providerOperations)
        .where(
          and(
            eq(providerOperations.provider, 'particle'),
            eq(providerOperations.externalId, input.operation.id),
          ),
        )
        .for('update')
        .limit(2);
      if (existingRows.length > 1) return 'concurrent_change' as const;
      let providerId = existingRows[0]?.id;
      if (providerId === undefined) {
        const [inserted] = await this.uow
          .current()
          .insert(providerOperations)
          .values(providerValues)
          .onConflictDoNothing({
            target: [providerOperations.provider, providerOperations.externalId],
          })
          .returning({ id: providerOperations.id });
        providerId = inserted?.id;
        if (providerId === undefined) {
          const [raced] = await this.uow
            .current()
            .select()
            .from(providerOperations)
            .where(
              and(
                eq(providerOperations.provider, 'particle'),
                eq(providerOperations.externalId, input.operation.id),
              ),
            )
            .for('update')
            .limit(1);
          if (
            raced === undefined ||
            raced.paymentAttemptId !== current.id ||
            raced.kind !== 'checkout'
          ) {
            return 'concurrent_change' as const;
          }
          providerId = raced.id;
        }
      } else {
        const existing = existingRows[0];
        if (
          existing === undefined ||
          existing.paymentAttemptId !== current.id ||
          existing.kind !== 'checkout'
        ) {
          return 'concurrent_change' as const;
        }
        const [updatedProvider] = await this.uow
          .current()
          .update(providerOperations)
          .set({
            status: input.operation.status,
            submissionPossible: input.operation.submissionPossible,
            destinationTransactionHash:
              input.operation.destinationTransactionHash === undefined
                ? null
                : TransactionHashSchema.parse(input.operation.destinationTransactionHash),
            activityUrl: input.operation.activityUrl ?? null,
            evidenceDigest: input.operation.evidence.evidenceDigest,
            safeSummary,
            observedAt: new Date(input.operation.evidence.observedAt),
            updatedAt: input.now,
          })
          .where(
            and(
              eq(providerOperations.id, providerId),
              eq(providerOperations.paymentAttemptId, current.id),
              eq(providerOperations.kind, 'checkout'),
            ),
          )
          .returning({ id: providerOperations.id });
        if (updatedProvider === undefined) return 'concurrent_change' as const;
      }

      if (observingAfterCanonicalPayment) return 'updated' as const;

      const [updated] = await this.uow
        .current()
        .update(paymentAttempts)
        .set({
          status: input.nextStatus,
          ...(input.operation.destinationTransactionHash === undefined
            ? {}
            : { destinationTransactionHash: input.operation.destinationTransactionHash }),
          vendorCode: input.operation.status,
          reconciliationRequired: input.reconciliationRequired,
          ...(input.nextStatus === 'failed_confirmed' ? { terminalAt: input.now } : {}),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(paymentAttempts.id, current.id),
            eq(paymentAttempts.status, input.candidate.status),
            inArray(paymentAttempts.status, [
              'submission_started',
              'submitted',
              'submitted_unknown',
              'executing',
              'confirming',
            ]),
          ),
        )
        .returning({ id: paymentAttempts.id });
      return updated === undefined ? ('concurrent_change' as const) : ('updated' as const);
    });
  }
}
