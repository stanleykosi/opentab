import type {
  PaymentReconciliationCandidate,
  PaymentReconciliationStorePort,
  UniversalOperationPort,
} from '@opentab/application';
import {
  AppError,
  type PaymentAttemptId,
  type PaymentAttemptStatus,
  type ProviderOperation,
} from '@opentab/shared';

export interface PaymentReconciliationJobs {
  schedule(input: {
    attemptId: PaymentAttemptId;
    deliveryAttempt: number;
    runAt: Date;
    reason:
      | 'provider_timeout'
      | 'provider_pending'
      | 'awaiting_canonical_event'
      | 'missing_provider_id';
  }): Promise<void>;
  deadLetter(input: {
    attemptId: PaymentAttemptId;
    deliveryAttempt: number;
    reason: string;
  }): Promise<void>;
}

export interface PaymentReconcilerResult {
  readonly kind:
    | 'missing'
    | 'already_terminal'
    | 'rescheduled'
    | 'concurrent_change'
    | 'dead_lettered';
  readonly nextStatus?: PaymentAttemptStatus;
}

export class PaymentOperationReconciler {
  constructor(
    private readonly dependencies: {
      operationsForCandidate: (candidate: PaymentReconciliationCandidate) => UniversalOperationPort;
      store: PaymentReconciliationStorePort;
      jobs: PaymentReconciliationJobs;
      now: () => Date;
      maxDeliveryAttempts: number;
      baseBackoffMs: number;
      maxBackoffMs: number;
    },
  ) {
    if (
      !Number.isSafeInteger(dependencies.maxDeliveryAttempts) ||
      dependencies.maxDeliveryAttempts < 1 ||
      !Number.isSafeInteger(dependencies.baseBackoffMs) ||
      dependencies.baseBackoffMs < 100 ||
      !Number.isSafeInteger(dependencies.maxBackoffMs) ||
      dependencies.maxBackoffMs < dependencies.baseBackoffMs
    ) {
      throw new RangeError('Payment reconciliation retry policy is invalid');
    }
  }

  async reconcile(input: {
    attemptId: PaymentAttemptId;
    deliveryAttempt: number;
  }): Promise<PaymentReconcilerResult> {
    if (!Number.isSafeInteger(input.deliveryAttempt) || input.deliveryAttempt < 1) {
      throw new RangeError('Reconciliation delivery attempt must be positive');
    }
    const candidate = await this.dependencies.store.load(input.attemptId);
    if (candidate === undefined) return { kind: 'missing' };
    if (
      candidate.status === 'failed_confirmed' ||
      (!candidate.reconciliationRequired && candidate.status !== 'paid')
    ) {
      return { kind: 'already_terminal', nextStatus: candidate.status };
    }
    if (input.deliveryAttempt > this.dependencies.maxDeliveryAttempts) {
      await this.dependencies.jobs.deadLetter({
        attemptId: candidate.attemptId,
        deliveryAttempt: input.deliveryAttempt,
        reason: 'reconciliation_attempts_exhausted',
      });
      return { kind: 'dead_lettered' };
    }
    if (candidate.providerOperationId === undefined) {
      return this.#schedule(candidate, input.deliveryAttempt, 'missing_provider_id');
    }

    let operation: ProviderOperation;
    try {
      operation = await this.dependencies
        .operationsForCandidate(candidate)
        .getOperation(candidate.providerOperationId);
    } catch {
      return this.#schedule(candidate, input.deliveryAttempt, 'provider_timeout');
    }
    if (operation.id !== candidate.providerOperationId) {
      throw new AppError(
        'UA_PROVIDER_SCHEMA_INVALID',
        'The provider returned a different operation identity.',
      );
    }

    if (candidate.status === 'paid') {
      if (operation.status !== 'succeeded') {
        return this.#schedule(
          candidate,
          input.deliveryAttempt,
          'provider_pending',
          candidate.status,
        );
      }
      const stored = await this.dependencies.store.recordProviderObservation({
        candidate,
        operation,
        nextStatus: 'confirming',
        reconciliationRequired: false,
        now: this.dependencies.now(),
      });
      if (stored === 'concurrent_change') return { kind: 'concurrent_change' };
      return { kind: 'already_terminal', nextStatus: 'paid' };
    }

    const transition =
      operation.status === 'succeeded'
        ? { nextStatus: 'confirming' as const, reconciliationRequired: true }
        : ['moving_funds', 'executing', 'refunding'].includes(operation.status)
          ? { nextStatus: 'executing' as const, reconciliationRequired: true }
          : { nextStatus: 'submitted_unknown' as const, reconciliationRequired: true };
    const stored = await this.dependencies.store.recordProviderObservation({
      candidate,
      operation,
      ...transition,
      now: this.dependencies.now(),
    });
    if (stored === 'already_terminal') {
      return { kind: 'already_terminal', nextStatus: candidate.status };
    }
    if (stored === 'concurrent_change') return { kind: 'concurrent_change' };
    return this.#schedule(
      { ...candidate, status: transition.nextStatus },
      input.deliveryAttempt,
      transition.nextStatus === 'confirming' ? 'awaiting_canonical_event' : 'provider_pending',
      transition.nextStatus,
    );
  }

  async #schedule(
    candidate: PaymentReconciliationCandidate,
    deliveryAttempt: number,
    reason: Parameters<PaymentReconciliationJobs['schedule']>[0]['reason'],
    nextStatus: PaymentAttemptStatus = candidate.status,
  ): Promise<PaymentReconcilerResult> {
    if (deliveryAttempt >= this.dependencies.maxDeliveryAttempts) {
      await this.dependencies.jobs.deadLetter({
        attemptId: candidate.attemptId,
        deliveryAttempt,
        reason,
      });
      return { kind: 'dead_lettered', nextStatus };
    }
    const delay = Math.min(
      this.dependencies.maxBackoffMs,
      this.dependencies.baseBackoffMs * 2 ** Math.min(deliveryAttempt - 1, 12),
    );
    await this.dependencies.jobs.schedule({
      attemptId: candidate.attemptId,
      deliveryAttempt: deliveryAttempt + 1,
      runAt: new Date(this.dependencies.now().getTime() + delay),
      reason,
    });
    return { kind: 'rescheduled', nextStatus };
  }
}
