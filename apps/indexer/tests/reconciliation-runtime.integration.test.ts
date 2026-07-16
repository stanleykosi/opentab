import { randomUUID } from 'node:crypto';
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
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { BullMqPaymentReconciliationRuntime } from '../src/reconciliation-runtime.js';

const redisUrl = process.env['REDIS_URL_TEST'];
const attemptId = PaymentAttemptIdSchema.parse('pay_01J00000000000000000000991');
const providerOperationId = ProviderOperationIdSchema.parse('particle-runtime-operation-1');
const ownerAddress = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const now = new Date('2026-07-14T05:00:00.000Z');
const prefixes: string[] = [];

class MemoryStore implements PaymentReconciliationStorePort {
  candidate: PaymentReconciliationCandidate | undefined = {
    attemptId,
    ownerAddress,
    providerOperationId,
    status: 'submitted_unknown',
    reconciliationRequired: true,
  };
  observations = 0;
  readonly deadLetters: string[] = [];

  async load() {
    return this.candidate;
  }
  async listPending() {
    return this.candidate?.reconciliationRequired ? [this.candidate] : [];
  }
  async recordDeadLetter(input: Parameters<PaymentReconciliationStorePort['recordDeadLetter']>[0]) {
    this.deadLetters.push(input.reason);
  }
  async recordProviderObservation(
    input: Parameters<PaymentReconciliationStorePort['recordProviderObservation']>[0],
  ) {
    if (this.candidate === undefined) {
      return 'already_terminal' as const;
    }
    if (this.candidate.status !== input.candidate.status) return 'concurrent_change' as const;
    this.observations += 1;
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

function operation() {
  return ProviderOperationSchema.parse({
    id: providerOperationId,
    status: 'succeeded',
    submissionPossible: true,
    destinationTransactionHash: `0x${'1'.repeat(64)}`,
    updatedAt: now.toISOString(),
    evidence: {
      adapter: 'particle-get-transaction',
      packageVersion: '2.0.3',
      schemaVersion: 1,
      environment: 'test',
      observedAt: now.toISOString(),
      evidenceDigest: EvidenceDigestSchema.parse(`0x${'2'.repeat(64)}`),
      provenance: 'recorded_live',
    },
  });
}

function operations(getOperation: UniversalOperationPort['getOperation']): UniversalOperationPort {
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

function logger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

async function eventually(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for reconciliation worker');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (redisUrl === undefined) return;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  for (const prefix of prefixes.splice(0)) {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await redis.quit();
});

describe.skipIf(redisUrl === undefined)('BullMQ payment reconciliation runtime', () => {
  it('recovers persisted candidates once across restart/duplicate seeds', async () => {
    if (redisUrl === undefined) return;
    const store = new MemoryStore();
    let providerReads = 0;
    const prefix = `opentab-test-${randomUUID()}`;
    prefixes.push(prefix);
    const runtime = new BullMqPaymentReconciliationRuntime({
      redisUrl,
      store,
      operationsForOwner: (owner) => {
        expect(owner).toBe(ownerAddress);
        return operations(async () => {
          providerReads += 1;
          return operation();
        });
      },
      logger: logger(),
      prefix,
      baseBackoffMs: 60_000,
      maxBackoffMs: 60_000,
    });
    await runtime.seedPending();
    await runtime.seedPending();
    await runtime.start();
    await eventually(() => store.observations === 1);
    expect(providerReads).toBe(1);
    expect(store.candidate?.status).toBe('confirming');
    await runtime.close();
  });

  it('backs off provider timeout and persists a bounded missing-ID dead letter', async () => {
    if (redisUrl === undefined) return;
    const timeoutStore = new MemoryStore();
    const timeoutPrefix = `opentab-test-${randomUUID()}`;
    prefixes.push(timeoutPrefix);
    const timeoutRuntime = new BullMqPaymentReconciliationRuntime({
      redisUrl,
      store: timeoutStore,
      operationsForOwner: () =>
        operations(async () => {
          throw new Error('timeout');
        }),
      logger: logger(),
      prefix: timeoutPrefix,
      baseBackoffMs: 60_000,
      maxBackoffMs: 60_000,
    });
    await timeoutRuntime.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(timeoutStore.candidate?.status).toBe('submitted_unknown');
    expect(timeoutStore.deadLetters).toEqual([]);
    await timeoutRuntime.close();

    const deadStore = new MemoryStore();
    if (deadStore.candidate !== undefined) {
      const { providerOperationId: _ignored, ...candidate } = deadStore.candidate;
      deadStore.candidate = candidate;
    }
    const deadPrefix = `opentab-test-${randomUUID()}`;
    prefixes.push(deadPrefix);
    const deadRuntime = new BullMqPaymentReconciliationRuntime({
      redisUrl,
      store: deadStore,
      operationsForOwner: () => operations(async () => operation()),
      logger: logger(),
      prefix: deadPrefix,
      maxDeliveryAttempts: 1,
    });
    await deadRuntime.start();
    await eventually(() => deadStore.deadLetters.length === 1);
    expect(deadStore.deadLetters).toEqual(['missing_provider_id']);
    await deadRuntime.close();
  });

  it('drains an active job before closing', async () => {
    if (redisUrl === undefined) return;
    const store = new MemoryStore();
    let release: (() => void) | undefined;
    let started = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prefix = `opentab-test-${randomUUID()}`;
    prefixes.push(prefix);
    const runtime = new BullMqPaymentReconciliationRuntime({
      redisUrl,
      store,
      operationsForOwner: () =>
        operations(async () => {
          started = true;
          await blocked;
          return operation();
        }),
      logger: logger(),
      prefix,
      baseBackoffMs: 60_000,
      maxBackoffMs: 60_000,
    });
    await runtime.start();
    await eventually(() => started);
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(store.observations).toBe(1);
  });
});
