import { createHash } from 'node:crypto';
import type { IdempotencyRepositoryPort, IdempotencyResult } from '@opentab/application';
import { AppError, isAppError } from '@opentab/shared';
import { and, eq, sql } from 'drizzle-orm';
import { idempotencyRecords } from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

type Execution<T> =
  | { kind: 'value'; value: IdempotencyResult<T> }
  | { kind: 'error'; error: unknown };

function jsonClone<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Idempotent responses must be JSON serializable');
  return JSON.parse(serialized) as T;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class PostgresIdempotencyRepository implements IdempotencyRepositoryPort {
  constructor(
    private readonly uow: PostgresUnitOfWork,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute<T>(input: {
    scope: string;
    keyHash: string;
    requestHash: string;
    expiresAt: Date;
    operation: () => Promise<T>;
  }): Promise<IdempotencyResult<T>> {
    if (input.scope.length < 1 || input.scope.length > 180) {
      throw new AppError('VALIDATION_FAILED', 'The idempotency scope is invalid.');
    }
    const execution = await this.uow.transaction<Execution<T>>(async () => {
      const lockKey = `${input.scope}:${input.keyHash}`;
      await this.uow
        .current()
        .execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const now = this.now();
      const [existing] = await this.uow
        .current()
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.scope, input.scope),
            eq(idempotencyRecords.keyHash, input.keyHash),
          ),
        )
        .limit(1);

      if (existing !== undefined && existing.requestHash !== input.requestHash) {
        return {
          kind: 'error',
          error: new AppError(
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key was used for a different request.',
          ),
        };
      }
      if (existing !== undefined && existing.expiresAt <= now) {
        return {
          kind: 'error',
          error: new AppError(
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key expired and cannot be safely reused.',
          ),
        };
      }
      if (existing?.status === 'completed') {
        return { kind: 'value', value: { state: 'replayed', value: existing.responseBody as T } };
      }
      if (existing?.status === 'failed_terminal') {
        return {
          kind: 'error',
          error: new AppError(
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key is bound to a terminally failed request.',
          ),
        };
      }
      if (existing?.status === 'in_progress' && existing.lockedUntil > now) {
        return {
          kind: 'error',
          error: new AppError(
            'PAYMENT_SUBMITTED_UNKNOWN',
            'This operation is already in progress.',
            {
              retryable: true,
              submissionPossible: true,
            },
          ),
        };
      }

      const lockedUntil = new Date(now.getTime() + 60_000);
      if (existing === undefined) {
        await this.uow.current().insert(idempotencyRecords).values({
          scope: input.scope,
          keyHash: input.keyHash,
          requestHash: input.requestHash,
          status: 'in_progress',
          lockedUntil,
          expiresAt: input.expiresAt,
        });
      } else {
        await this.uow
          .current()
          .update(idempotencyRecords)
          .set({ status: 'in_progress', lockedUntil, expiresAt: input.expiresAt, updatedAt: now })
          .where(eq(idempotencyRecords.id, existing.id));
      }

      try {
        const value = jsonClone(await input.operation());
        await this.uow
          .current()
          .update(idempotencyRecords)
          .set({
            status: 'completed',
            responseBody: value,
            responseDigest: digestJson(value),
            lockedUntil: now,
            updatedAt: this.now(),
          })
          .where(
            and(
              eq(idempotencyRecords.scope, input.scope),
              eq(idempotencyRecords.keyHash, input.keyHash),
            ),
          );
        return { kind: 'value', value: { state: 'created', value } };
      } catch (error) {
        await this.uow
          .current()
          .update(idempotencyRecords)
          .set({
            status: isAppError(error) && error.retryable ? 'failed_retryable' : 'failed_terminal',
            lockedUntil: now,
            updatedAt: this.now(),
          })
          .where(
            and(
              eq(idempotencyRecords.scope, input.scope),
              eq(idempotencyRecords.keyHash, input.keyHash),
            ),
          );
        return { kind: 'error', error };
      }
    });

    if (execution.kind === 'error') throw execution.error;
    return execution.value;
  }
}
