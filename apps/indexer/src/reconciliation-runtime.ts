import type {
  PaymentReconciliationCandidate,
  PaymentReconciliationStorePort,
  UniversalOperationPort,
} from '@opentab/application';
import { AppError, type PaymentAttemptId, PaymentAttemptIdSchema } from '@opentab/shared';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import { z } from 'zod';
import { PaymentOperationReconciler, type PaymentReconciliationJobs } from './reconciler.js';

const QUEUE_NAME = 'opentab-payment-reconciliation';
const JOB_NAME = 'payment-reconcile';
const PayloadSchema = z.object({
  attemptId: PaymentAttemptIdSchema,
  deliveryAttempt: z.coerce.number().int().positive().max(100),
});

export interface PaymentReconciliationRuntimeOptions {
  readonly redisUrl: string;
  readonly store: PaymentReconciliationStorePort;
  readonly operationsForOwner: (
    ownerAddress: PaymentReconciliationCandidate['ownerAddress'],
  ) => UniversalOperationPort;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly prefix?: string;
  readonly now?: () => Date;
  readonly maxDeliveryAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly recoveryIntervalMs?: number;
}

/** Long-running BullMQ consumer for restart-safe Particle operation reconciliation. */
export class BullMqPaymentReconciliationRuntime implements PaymentReconciliationJobs {
  readonly #redis: Redis;
  readonly #queue: Queue<Record<string, string>, void, string>;
  readonly #now: () => Date;
  readonly #reconciler: PaymentOperationReconciler;
  readonly #recoveryIntervalMs: number;
  #worker: Worker<Record<string, string>, void, string> | undefined;
  #recoveryTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(private readonly options: PaymentReconciliationRuntimeOptions) {
    if (!/^rediss?:\/\//.test(options.redisUrl)) {
      throw new AppError('CONFIGURATION_INVALID', 'Reconciliation Redis URL is invalid.');
    }
    this.#now = options.now ?? (() => new Date());
    this.#recoveryIntervalMs = options.recoveryIntervalMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.#recoveryIntervalMs) ||
      this.#recoveryIntervalMs < 1_000 ||
      this.#recoveryIntervalMs > 3_600_000
    ) {
      throw new RangeError('Reconciliation recovery interval is invalid');
    }
    this.#redis = new Redis(options.redisUrl, {
      family: 0,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectTimeout: 10_000,
      commandTimeout: 5_000,
    });
    this.#queue = new Queue(QUEUE_NAME, {
      connection: this.#redis as unknown as ConnectionOptions,
      prefix: options.prefix ?? 'opentab',
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 7 * 86_400, count: 100_000 },
        removeOnFail: false,
      },
    });
    this.#reconciler = new PaymentOperationReconciler({
      operationsForCandidate: (candidate) => options.operationsForOwner(candidate.ownerAddress),
      store: options.store,
      jobs: this,
      now: this.#now,
      maxDeliveryAttempts: options.maxDeliveryAttempts ?? 10,
      baseBackoffMs: options.baseBackoffMs ?? 2_000,
      maxBackoffMs: options.maxBackoffMs ?? 300_000,
    });
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('The reconciliation runtime is closed');
    if (this.#worker !== undefined) return;
    await this.seedPending();
    this.#worker = new Worker(QUEUE_NAME, (job) => this.#process(job), {
      connection: this.#redis as unknown as ConnectionOptions,
      prefix: this.options.prefix ?? 'opentab',
      concurrency: 4,
      lockDuration: 60_000,
    });
    this.#worker.on('error', (error) => {
      this.options.logger.error({ err: error }, 'Payment reconciliation worker error');
    });
    await this.#worker.waitUntilReady();
    this.#recoveryTimer = setInterval(() => {
      void this.seedPending().catch((error: unknown) => {
        this.options.logger.error({ err: error }, 'Payment reconciliation recovery seed failed');
      });
    }, this.#recoveryIntervalMs);
    this.#recoveryTimer.unref();
    this.options.logger.info({ queue: QUEUE_NAME }, 'Payment reconciliation worker started');
  }

  async seedPending(): Promise<number> {
    const candidates = await this.options.store.listPending(10_000);
    await Promise.all(
      candidates.map((candidate) =>
        this.schedule({
          attemptId: candidate.attemptId,
          deliveryAttempt: 1,
          runAt: this.#now(),
          reason:
            candidate.providerOperationId === undefined
              ? 'missing_provider_id'
              : 'provider_pending',
        }),
      ),
    );
    if (candidates.length > 0) {
      this.options.logger.info(
        { candidateCount: candidates.length },
        'Recovered payment reconciliation candidates',
      );
    }
    return candidates.length;
  }

  async schedule(input: {
    attemptId: PaymentAttemptId;
    deliveryAttempt: number;
    runAt: Date;
    reason:
      | 'provider_timeout'
      | 'provider_pending'
      | 'awaiting_canonical_event'
      | 'missing_provider_id';
  }): Promise<void> {
    if (this.#closed) throw new Error('The reconciliation runtime is closed');
    const payload = PayloadSchema.parse({
      attemptId: input.attemptId,
      deliveryAttempt: input.deliveryAttempt,
    });
    await this.#queue.add(
      JOB_NAME,
      {
        attemptId: payload.attemptId,
        deliveryAttempt: payload.deliveryAttempt.toString(),
        reason: input.reason,
      },
      {
        jobId: `${payload.attemptId}-${payload.deliveryAttempt}`,
        delay: Math.max(0, input.runAt.getTime() - this.#now().getTime()),
      },
    );
  }

  async deadLetter(input: {
    attemptId: PaymentAttemptId;
    deliveryAttempt: number;
    reason: string;
  }): Promise<void> {
    await this.options.store.recordDeadLetter({ ...input, now: this.#now() });
    this.options.logger.warn(
      { attemptId: input.attemptId, deliveryAttempt: input.deliveryAttempt, reason: input.reason },
      'Payment reconciliation dead-lettered',
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#recoveryTimer !== undefined) clearInterval(this.#recoveryTimer);
    // Worker.close() waits for the active processor and stops fetching before
    // queue/connection teardown, which is the required SIGTERM drain order.
    await this.#worker?.close();
    await this.#queue.close();
    await this.#redis.quit().catch(() => undefined);
    this.options.logger.info({ queue: QUEUE_NAME }, 'Payment reconciliation worker drained');
  }

  async #process(job: Job<Record<string, string>, void, string>): Promise<void> {
    let payload: z.infer<typeof PayloadSchema>;
    try {
      payload = PayloadSchema.parse(job.data);
      await this.#reconciler.reconcile(payload);
    } catch (error) {
      const attempt = PaymentAttemptIdSchema.safeParse(job.data['attemptId']);
      if (attempt.success) {
        await this.deadLetter({
          attemptId: attempt.data,
          deliveryAttempt: Number(job.data['deliveryAttempt'] ?? 1),
          reason: error instanceof AppError ? error.code : 'worker_unhandled_error',
        });
      }
      throw error;
    }
  }
}

export const PAYMENT_RECONCILIATION_QUEUE_NAME = QUEUE_NAME;
