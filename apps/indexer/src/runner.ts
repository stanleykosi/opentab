import type { IndexerHealthTracker } from './health.js';
import type { IndexerScanner } from './scanner.js';

export class IndexerRunner {
  constructor(
    private readonly scanner: IndexerScanner,
    private readonly health: IndexerHealthTracker,
    private readonly options: {
      pollIntervalMs: number;
      retryBaseMs: number;
      retryMaxMs: number;
      afterScan?: () => Promise<void>;
      onError?: (error: unknown) => void;
    },
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const result = await this.scanner.scanOnce();
        await this.options.afterScan?.();
        this.health.recordSuccess(result);
        failures = 0;
        await waitFor(this.options.pollIntervalMs, signal);
      } catch (error) {
        this.health.recordFailure();
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
