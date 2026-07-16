import type {
  PaymentReconciliationCandidate,
  PaymentReconciliationStorePort,
  UniversalOperationPort,
} from '@opentab/application';
import {
  EvidenceDigestSchema,
  EvmAddressSchema,
  PaymentAttemptIdSchema,
  ProviderOperationIdSchema,
  ProviderOperationSchema,
} from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { PaymentOperationReconciler, type PaymentReconciliationJobs } from '../src/reconciler.js';

const attemptId = PaymentAttemptIdSchema.parse('pay_01J00000000000000000000001');
const providerOperationId = ProviderOperationIdSchema.parse('particle-operation-1');
const now = new Date('2026-07-14T04:00:00.000Z');
const ownerAddress = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);

function operation(status: 'executing' | 'succeeded' | 'failed' | 'unknown') {
  return ProviderOperationSchema.parse({
    id: providerOperationId,
    status,
    submissionPossible: true,
    ...(status === 'succeeded' ? { destinationTransactionHash: `0x${'1'.repeat(64)}` } : {}),
    updatedAt: now.toISOString(),
    evidence: {
      adapter: 'particle-get-transaction',
      packageVersion: '2.0.3',
      schemaVersion: 1,
      environment: 'test',
      observedAt: now.toISOString(),
      evidenceDigest: EvidenceDigestSchema.parse(`0x${'2'.repeat(64)}`),
      provenance: 'deterministic',
    },
  });
}

class MemoryStore implements PaymentReconciliationStorePort {
  candidate: PaymentReconciliationCandidate | undefined = {
    attemptId,
    ownerAddress,
    providerOperationId,
    status: 'submitted_unknown',
    reconciliationRequired: true,
  };
  observations = 0;
  readonly persistedDeadLetters: string[] = [];

  async load() {
    return this.candidate;
  }

  async listPending() {
    return this.candidate === undefined ? [] : [this.candidate];
  }

  async recordDeadLetter(input: Parameters<PaymentReconciliationStorePort['recordDeadLetter']>[0]) {
    this.persistedDeadLetters.push(input.reason);
  }

  async recordProviderObservation(
    input: Parameters<PaymentReconciliationStorePort['recordProviderObservation']>[0],
  ) {
    this.observations += 1;
    if (this.candidate === undefined) {
      return 'already_terminal' as const;
    }
    if (this.candidate.status !== input.candidate.status) return 'concurrent_change' as const;
    if (this.candidate.status === 'paid') return 'updated' as const;
    if (!this.candidate.reconciliationRequired) return 'already_terminal' as const;
    this.candidate = {
      ...this.candidate,
      status: input.nextStatus,
      reconciliationRequired: input.reconciliationRequired,
    };
    return 'updated' as const;
  }
}

class MemoryJobs implements PaymentReconciliationJobs {
  readonly scheduled = new Map<string, Parameters<PaymentReconciliationJobs['schedule']>[0]>();
  readonly deadLetters: Parameters<PaymentReconciliationJobs['deadLetter']>[0][] = [];

  async schedule(input: Parameters<PaymentReconciliationJobs['schedule']>[0]) {
    this.scheduled.set(`${input.attemptId}:${input.deliveryAttempt}`, input);
  }

  async deadLetter(input: Parameters<PaymentReconciliationJobs['deadLetter']>[0]) {
    this.deadLetters.push(input);
  }
}

function requiredCandidate(store: MemoryStore): PaymentReconciliationCandidate {
  if (store.candidate === undefined) throw new Error('Expected a reconciliation candidate');
  return store.candidate;
}

function operationPort(
  getOperation: UniversalOperationPort['getOperation'],
): UniversalOperationPort {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    getAccount: unused,
    getUnifiedBalance: unused,
    getDelegation: unused,
    prepareDelegation: unused,
    prepareOperation: unused,
    validateOperation: unused,
    submitValidated: unused,
    getOperation,
  };
}

function reconciler(input: {
  store: MemoryStore;
  jobs: MemoryJobs;
  getOperation: UniversalOperationPort['getOperation'];
}) {
  return new PaymentOperationReconciler({
    operationsForCandidate: (candidate) => {
      expect(candidate.ownerAddress).toBe(ownerAddress);
      return operationPort(input.getOperation);
    },
    store: input.store,
    jobs: input.jobs,
    now: () => new Date(now),
    maxDeliveryAttempts: 4,
    baseBackoffMs: 1_000,
    maxBackoffMs: 8_000,
  });
}

describe('bounded provider-operation reconciliation', () => {
  it('backs off on provider timeout without clearing submitted_unknown', async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobs();
    const result = await reconciler({
      store,
      jobs,
      getOperation: async () => {
        throw new Error('timeout');
      },
    }).reconcile({ attemptId, deliveryAttempt: 1 });

    expect(result).toEqual({ kind: 'rescheduled', nextStatus: 'submitted_unknown' });
    expect(store.candidate?.status).toBe('submitted_unknown');
    expect(jobs.scheduled.get(`${attemptId}:2`)).toMatchObject({
      reason: 'provider_timeout',
      runAt: new Date(now.getTime() + 1_000),
    });
  });

  it('records provider success as confirming and still refuses paid without a canonical event', async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobs();
    const result = await reconciler({
      store,
      jobs,
      getOperation: async () => operation('succeeded'),
    }).reconcile({ attemptId, deliveryAttempt: 1 });

    expect(result).toEqual({ kind: 'rescheduled', nextStatus: 'confirming' });
    expect(store.candidate).toMatchObject({ status: 'confirming', reconciliationRequired: true });
    expect(store.candidate?.status).not.toBe('paid');
    expect(jobs.scheduled.get(`${attemptId}:2`)?.reason).toBe('awaiting_canonical_event');
  });

  it('persists a later terminal provider observation without changing canonical paid truth', async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobs();
    const worker = reconciler({
      store,
      jobs,
      getOperation: async () => operation('succeeded'),
    });
    await worker.reconcile({ attemptId, deliveryAttempt: 1 });
    store.candidate = {
      ...requiredCandidate(store),
      status: 'paid',
      reconciliationRequired: false,
    };

    const result = await worker.reconcile({ attemptId, deliveryAttempt: 2 });
    expect(result).toEqual({ kind: 'already_terminal', nextStatus: 'paid' });
    expect(store.observations).toBe(2);
    expect(store.candidate).toMatchObject({ status: 'paid', reconciliationRequired: false });
  });

  it('keeps polling a canonically paid attempt until the terminal provider observation arrives', async () => {
    const store = new MemoryStore();
    store.candidate = {
      ...requiredCandidate(store),
      status: 'paid',
      reconciliationRequired: false,
    };
    const jobs = new MemoryJobs();
    const result = await reconciler({
      store,
      jobs,
      getOperation: async () => operation('executing'),
    }).reconcile({ attemptId, deliveryAttempt: 1 });

    expect(result).toEqual({ kind: 'rescheduled', nextStatus: 'paid' });
    expect(store.observations).toBe(0);
    expect(jobs.scheduled.get(`${attemptId}:2`)?.reason).toBe('provider_pending');
  });

  it('keeps a provider-reported failure reconciling until chain evidence proves the outcome', async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobs();
    const result = await reconciler({
      store,
      jobs,
      getOperation: async () => operation('failed'),
    }).reconcile({ attemptId, deliveryAttempt: 1 });

    expect(result).toEqual({ kind: 'rescheduled', nextStatus: 'submitted_unknown' });
    expect(store.candidate).toMatchObject({
      status: 'submitted_unknown',
      reconciliationRequired: true,
    });
    expect(jobs.scheduled.get(`${attemptId}:2`)?.reason).toBe('provider_pending');
  });

  it('resumes from persisted candidate state after worker restart', async () => {
    const store = new MemoryStore();
    store.candidate = { ...requiredCandidate(store), status: 'executing' };
    const jobs = new MemoryJobs();
    const restarted = reconciler({
      store,
      jobs,
      getOperation: async () => operation('executing'),
    });

    await expect(restarted.reconcile({ attemptId, deliveryAttempt: 2 })).resolves.toMatchObject({
      kind: 'rescheduled',
      nextStatus: 'executing',
    });
    expect(jobs.scheduled.has(`${attemptId}:3`)).toBe(true);
  });

  it('keeps duplicate job delivery idempotent through the deterministic next job identity', async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobs();
    const worker = reconciler({
      store,
      jobs,
      getOperation: async () => operation('succeeded'),
    });
    await worker.reconcile({ attemptId, deliveryAttempt: 1 });
    await worker.reconcile({ attemptId, deliveryAttempt: 1 });

    expect(jobs.scheduled.size).toBe(1);
    expect(jobs.scheduled.has(`${attemptId}:2`)).toBe(true);
  });

  it('dead-letters bounded retries instead of polling forever', async () => {
    const store = new MemoryStore();
    const { providerOperationId: _providerOperationId, ...withoutProviderId } =
      requiredCandidate(store);
    store.candidate = withoutProviderId;
    const jobs = new MemoryJobs();
    const result = await reconciler({
      store,
      jobs,
      getOperation: async () => operation('unknown'),
    }).reconcile({ attemptId, deliveryAttempt: 4 });

    expect(result.kind).toBe('dead_lettered');
    expect(jobs.deadLetters).toHaveLength(1);
  });
});
