import { describe, expect, it, vi } from 'vitest';
import { IndexerHealthTracker } from '../src/health.js';
import { IndexerRunner } from '../src/runner.js';

describe('indexer runner lease handoff', () => {
  it('treats a rollout lease holder as standby and resumes without a scan failure', async () => {
    const controller = new AbortController();
    let calls = 0;
    const scanner = {
      scanOnce: async () => {
        calls += 1;
        if (calls === 1) return { kind: 'lease_standby' as const, nextBlock: 10n };
        controller.abort();
        return {
          kind: 'idle' as const,
          latestBlock: 11n,
          safeHead: 10n,
          nextBlock: 11n,
          processedBlocks: 0,
          processedLogs: 0,
          lagBlocks: 0n,
        };
      },
    };
    const health = new IndexerHealthTracker({
      maxReadyLagBlocks: 3n,
      staleAfterMs: 1_000,
      maxConsecutiveFailures: 2,
    });
    const onError = vi.fn();
    const onStandby = vi.fn();
    const onLeaseAcquired = vi.fn();
    const afterScan = vi.fn(async () => undefined);
    const runner = new IndexerRunner(scanner, health, {
      pollIntervalMs: 1,
      retryBaseMs: 1,
      retryMaxMs: 10,
      afterScan,
      onError,
      onStandby,
      onLeaseAcquired,
    });

    await runner.run(controller.signal);

    expect(calls).toBe(2);
    expect(onStandby).toHaveBeenCalledOnce();
    expect(onLeaseAcquired).toHaveBeenCalledOnce();
    expect(afterScan).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(health.snapshot()).toMatchObject({
      ready: false,
      draining: true,
      consecutiveFailures: 0,
      lastSuccessAt: expect.any(String),
    });
  });
});
