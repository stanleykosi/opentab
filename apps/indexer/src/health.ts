import { createServer, type Server } from 'node:http';
import type { IndexerActiveScanResult } from './types.js';

export interface IndexerParticleProfileReadiness {
  readonly profileScopeId: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly stage: 'bootstrap' | 'canary_ready' | 'certified';
}

export interface IndexerHealthSnapshot {
  readonly live: true;
  readonly ready: boolean;
  readonly draining: boolean;
  readonly lastSuccessAt?: string;
  readonly lastErrorAt?: string;
  readonly lagBlocks: string;
  readonly consecutiveFailures: number;
  readonly particleProfile?: IndexerParticleProfileReadiness;
  readonly reason?: 'starting' | 'standby' | 'draining' | 'stale' | 'lagging' | 'failing';
}

export class IndexerHealthTracker {
  #lastSuccessAt: Date | undefined;
  #lastErrorAt: Date | undefined;
  #lagBlocks = 0n;
  #consecutiveFailures = 0;
  #standby = false;
  #draining = false;

  constructor(
    private readonly options: {
      maxReadyLagBlocks: bigint;
      staleAfterMs: number;
      maxConsecutiveFailures: number;
      particleProfile?: IndexerParticleProfileReadiness;
      now?: () => Date;
    },
  ) {}

  recordSuccess(result: IndexerActiveScanResult): void {
    this.#lastSuccessAt = this.options.now?.() ?? new Date();
    this.#lagBlocks = result.lagBlocks;
    this.#consecutiveFailures = 0;
    this.#standby = false;
  }

  recordStandby(): void {
    this.#standby = true;
    this.#consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.#lastErrorAt = this.options.now?.() ?? new Date();
    this.#consecutiveFailures += 1;
    this.#standby = false;
  }

  setDraining(): void {
    this.#draining = true;
  }

  snapshot(): IndexerHealthSnapshot {
    const now = this.options.now?.() ?? new Date();
    let reason: IndexerHealthSnapshot['reason'];
    if (this.#draining) reason = 'draining';
    else if (this.#standby) reason = 'standby';
    else if (this.#lastSuccessAt === undefined) reason = 'starting';
    else if (now.getTime() - this.#lastSuccessAt.getTime() > this.options.staleAfterMs)
      reason = 'stale';
    else if (this.#lagBlocks > this.options.maxReadyLagBlocks) reason = 'lagging';
    else if (this.#consecutiveFailures >= this.options.maxConsecutiveFailures) reason = 'failing';
    return {
      live: true,
      ready: reason === undefined,
      draining: this.#draining,
      ...(this.#lastSuccessAt === undefined
        ? {}
        : { lastSuccessAt: this.#lastSuccessAt.toISOString() }),
      ...(this.#lastErrorAt === undefined ? {} : { lastErrorAt: this.#lastErrorAt.toISOString() }),
      lagBlocks: this.#lagBlocks.toString(),
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.options.particleProfile === undefined
        ? {}
        : { particleProfile: this.options.particleProfile }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

export function createIndexerHealthServer(input: {
  tracker: IndexerHealthTracker;
  host?: string;
  port: number;
}): { server: Server; listen(): Promise<void>; close(): Promise<void> } {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (
      request.method !== 'GET' ||
      !['/health/live', '/health/ready'].includes(request.url ?? '')
    ) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const health = input.tracker.snapshot();
    const readyRequest = request.url === '/health/ready';
    response.statusCode = readyRequest && !health.ready ? 503 : 200;
    response.end(
      JSON.stringify(readyRequest ? health : { live: health.live, draining: health.draining }),
    );
  });
  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(input.port, input.host ?? '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
