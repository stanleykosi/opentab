import type { IndexerHealthTracker } from './health.js';
import type { IndexerScanner } from './scanner.js';
import type { IndexerActiveScanResult, IndexerLeaseStandbyResult } from './types.js';

export class IndexerRunner {
  constructor(
    private readonly scanner: Pick<IndexerScanner, 'scanOnce'>,
    private readonly health: IndexerHealthTracker,
    private readonly options: {
      pollIntervalMs: number;
      retryBaseMs: number;
      retryMaxMs: number;
      afterScan?: () => Promise<void>;
      onError?: (error: unknown) => void;
      onStandby?: (result: IndexerLeaseStandbyResult) => void;
      onLeaseAcquired?: (result: IndexerActiveScanResult) => void;
    },
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let wasStandby = false;
    while (!signal.aborted) {
      try {
        const result = await this.scanner.scanOnce();
        if (result.kind === 'lease_standby') {
          this.health.recordStandby();
          failures = 0;
          if (!wasStandby) this.options.onStandby?.(result);
          wasStandby = true;
          await waitFor(this.options.pollIntervalMs, signal);
          continue;
        }
        if (wasStandby) this.options.onLeaseAcquired?.(result);
        wasStandby = false;
        await this.options.afterScan?.();
        this.health.recordSuccess(result);
        failures = 0;
        await waitFor(this.options.pollIntervalMs, signal);
      } catch (error) {
        this.health.recordFailure();
        wasStandby = false;
        this.options.onError?.(error);
        failures += 1;
        const backoff = Math.min(
          this.options.retryMaxMs,
          this.options.retryBaseMs * 2 ** Math.min(failures - 1, 8),
        );
        await waitFor(backoff, signal);
      }
    }
    this.health.setDraining();
  }
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
