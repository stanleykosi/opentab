import type {
  EvmAddress,
  PaymentAttemptId,
  PaymentAttemptStatus,
  ProviderOperation,
  ProviderOperationId,
} from '@opentab/shared';

export interface PaymentReconciliationCandidate {
  readonly attemptId: PaymentAttemptId;
  readonly ownerAddress: EvmAddress;
  readonly providerOperationId?: ProviderOperationId;
  readonly status: PaymentAttemptStatus;
  readonly reconciliationRequired: boolean;
}

export interface PaymentReconciliationStorePort {
  load(attemptId: PaymentAttemptId): Promise<PaymentReconciliationCandidate | undefined>;
  listPending(limit: number): Promise<readonly PaymentReconciliationCandidate[]>;
  recordDeadLetter(input: {
    attemptId: PaymentAttemptId;
    deliveryAttempt: number;
    reason: string;
    now: Date;
  }): Promise<void>;
  recordProviderObservation(input: {
    candidate: PaymentReconciliationCandidate;
    operation: ProviderOperation;
    nextStatus: Extract<
      PaymentAttemptStatus,
      'submitted_unknown' | 'executing' | 'confirming' | 'failed_confirmed'
    >;
    reconciliationRequired: boolean;
    now: Date;
  }): Promise<'updated' | 'already_terminal' | 'concurrent_change'>;
}
