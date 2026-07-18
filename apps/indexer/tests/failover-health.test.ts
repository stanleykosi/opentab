import type { ArbitrumReadPort } from '@opentab/application';
import { ARBITRUM_ONE_CHAIN_ID, EvmAddressSchema, TransactionHashSchema } from '@opentab/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailoverArbitrumReadPort } from '../src/failover.js';
import { createIndexerHealthServer, IndexerHealthTracker } from '../src/health.js';

const address = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const delegate = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const transactionHash = TransactionHashSchema.parse(`0x${'3'.repeat(64)}`);
const blockHash = `0x${'4'.repeat(64)}` as const;

function port(getBalance: () => Promise<string>): ArbitrumReadPort {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    getLatestBlock: unused,
    getBlock: unused,
    getLogs: unused,
    getNativeBalance: getBalance,
    getDelegationCode: unused,
    getTransactionReceipt: unused,
    findOrderEvent: unused,
    readProduct: unused,
  };
}

function evidencePort(
  read: NonNullable<ArbitrumReadPort['getEip7702AuthorizationEvidence']>,
): ArbitrumReadPort {
  return {
    ...port(async () => '0'),
    getEip7702AuthorizationEvidence: read,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RPC failover', () => {
  it('times out a stalled primary and returns the fallback result', async () => {
    vi.useFakeTimers();
    const failovers: string[] = [];
    const source = new FailoverArbitrumReadPort(
      port(() => new Promise<string>(() => undefined)),
      port(async () => '42'),
      {
        failureThreshold: 1,
        cooldownMs: 1_000,
        timeoutMs: 100,
        now: () => 0,
        onFailover: (method) => failovers.push(method),
      },
    );

    const pending = source.getNativeBalance(address);
    await vi.advanceTimersByTimeAsync(101);

    await expect(pending).resolves.toBe('42');
    expect(failovers).toEqual(['getNativeBalance']);
  });

  it('opens the primary circuit after threshold and probes it again after cooldown', async () => {
    let now = 100;
    let primaryCalls = 0;
    let primaryHealthy = false;
    const source = new FailoverArbitrumReadPort(
      port(async () => {
        primaryCalls += 1;
        if (!primaryHealthy) throw new Error('primary down');
        return '99';
      }),
      port(async () => '42'),
      {
        failureThreshold: 1,
        cooldownMs: 1_000,
        timeoutMs: 100,
        now: () => now,
      },
    );

    await expect(source.getNativeBalance(address)).resolves.toBe('42');
    await expect(source.getNativeBalance(address)).resolves.toBe('42');
    expect(primaryCalls).toBe(1);
    primaryHealthy = true;
    now = 1_101;
    await expect(source.getNativeBalance(address)).resolves.toBe('99');
    expect(primaryCalls).toBe(2);
  });

  it('returns a stable retryable error only after both providers fail', async () => {
    const source = new FailoverArbitrumReadPort(
      port(async () => {
        throw new Error('primary down');
      }),
      port(async () => {
        throw new Error('fallback down');
      }),
      { failureThreshold: 1, cooldownMs: 1_000, timeoutMs: 100 },
    );

    await expect(source.getNativeBalance(address)).rejects.toMatchObject({
      code: 'RPC_UNAVAILABLE',
      retryable: true,
    });
  });

  it('forwards EIP-7702 authorization evidence through failover without widening it', async () => {
    const result = {
      transactionHash,
      transactionFrom: address,
      transactionType: 'eip7702' as const,
      blockNumber: '12',
      blockHash,
      authority: address,
      delegate,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      authorizationIndex: 0 as const,
      authorizationNonce: '7',
      canonical: true as const,
    };
    const primary = vi.fn(async () => {
      throw new Error('primary down');
    });
    const fallback = vi.fn(async () => result);
    const source = new FailoverArbitrumReadPort(evidencePort(primary), evidencePort(fallback), {
      failureThreshold: 1,
      cooldownMs: 1_000,
      timeoutMs: 100,
    });
    const input = {
      transactionHash,
      expectedAuthority: address,
      expectedDelegate: delegate,
    };

    await expect(source.getEip7702AuthorizationEvidence(input)).resolves.toEqual(result);
    expect(primary).toHaveBeenCalledWith(input);
    expect(fallback).toHaveBeenCalledWith(input);
  });

  it('fails closed when either RPC adapter lacks EIP-7702 evidence capability', () => {
    const source = new FailoverArbitrumReadPort(
      evidencePort(async () => {
        throw new Error('not used');
      }),
      port(async () => '0'),
      { failureThreshold: 1, cooldownMs: 1_000, timeoutMs: 100 },
    );
    expect(() =>
      source.getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: address,
        expectedDelegate: delegate,
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });
});

describe('indexer health readiness', () => {
  it('keeps liveness healthy while readiness waits for the first successful scan', async () => {
    const tracker = new IndexerHealthTracker({
      maxReadyLagBlocks: 3n,
      staleAfterMs: 1_000,
      maxConsecutiveFailures: 2,
      particleProfile: {
        profileScopeId: 'a'.repeat(40),
        profileId: 'particle-profile-v1',
        profileDigest: `0x${'b'.repeat(64)}`,
        stage: 'canary_ready',
      },
    });
    const health = createIndexerHealthServer({ tracker, host: '127.0.0.1', port: 0 });
    await health.listen();
    const address = health.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Health port unavailable.');

    try {
      const origin = `http://127.0.0.1:${address.port}`;
      const [live, ready] = await Promise.all([
        fetch(`${origin}/health/live`),
        fetch(`${origin}/health/ready`),
      ]);

      expect(live.status).toBe(200);
      await expect(live.json()).resolves.toEqual({ live: true, draining: false });
      expect(ready.status).toBe(503);
      await expect(ready.json()).resolves.toMatchObject({
        live: true,
        ready: false,
        reason: 'starting',
        particleProfile: {
          profileScopeId: 'a'.repeat(40),
          profileId: 'particle-profile-v1',
          profileDigest: `0x${'b'.repeat(64)}`,
          stage: 'canary_ready',
        },
      });
    } finally {
      await health.close();
    }
  });

  it('distinguishes starting, standby, ready, stale, failing, lagging, and draining states', () => {
    let current = new Date('2026-07-14T00:00:00.000Z');
    const tracker = new IndexerHealthTracker({
      maxReadyLagBlocks: 3n,
      staleAfterMs: 1_000,
      maxConsecutiveFailures: 2,
      now: () => current,
    });
    expect(tracker.snapshot()).toMatchObject({ ready: false, reason: 'starting' });

    tracker.recordStandby();
    expect(tracker.snapshot()).toMatchObject({
      ready: false,
      reason: 'standby',
      consecutiveFailures: 0,
    });

    tracker.recordSuccess({
      kind: 'idle',
      latestBlock: 10n,
      safeHead: 9n,
      nextBlock: 10n,
      processedBlocks: 0,
      processedLogs: 0,
      lagBlocks: 0n,
    });
    expect(tracker.snapshot()).toMatchObject({ ready: true, consecutiveFailures: 0 });

    tracker.recordFailure();
    tracker.recordFailure();
    expect(tracker.snapshot()).toMatchObject({ ready: false, reason: 'failing' });

    tracker.recordSuccess({
      kind: 'processed',
      latestBlock: 20n,
      safeHead: 19n,
      nextBlock: 15n,
      processedBlocks: 2,
      processedLogs: 1,
      lagBlocks: 5n,
    });
    expect(tracker.snapshot()).toMatchObject({ ready: false, reason: 'lagging' });

    tracker.recordSuccess({
      kind: 'idle',
      latestBlock: 20n,
      safeHead: 19n,
      nextBlock: 20n,
      processedBlocks: 0,
      processedLogs: 0,
      lagBlocks: 0n,
    });
    current = new Date('2026-07-14T00:00:01.001Z');
    expect(tracker.snapshot()).toMatchObject({ ready: false, reason: 'stale' });

    tracker.setDraining();
    expect(tracker.snapshot()).toMatchObject({ ready: false, reason: 'draining', draining: true });
  });
});
