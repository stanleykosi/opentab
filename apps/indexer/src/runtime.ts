import type {
  ArbitrumReadPort,
  PaymentReconciliationStorePort,
  SponsorGrantReconciliationStorePort,
  UniversalOperationPort,
} from '@opentab/application';
import { AppError, type EvmAddress } from '@opentab/shared';
import type { Logger } from 'pino';
import { type IndexerRuntimeConfig, parseIndexerRuntimeConfig } from './config.js';
import { OpenTabContractLogDecoder } from './decoder.js';
import { FailoverArbitrumReadPort } from './failover.js';
import {
  createIndexerHealthServer,
  IndexerHealthTracker,
  type IndexerParticleProfileReadiness,
} from './health.js';
import { createPostgresIndexerPersistence } from './persistence.js';
import { BullMqPaymentReconciliationRuntime } from './reconciliation-runtime.js';
import { IndexerRunner } from './runner.js';
import { IndexerScanner } from './scanner.js';
import { SponsorGrantReconciler } from './sponsor-reconciler.js';
import type { IndexerStore } from './types.js';

export interface IndexerRuntimeDependencies {
  readonly primaryChain: ArbitrumReadPort;
  readonly fallbackChain: ArbitrumReadPort;
  readonly store?: IndexerStore;
  readonly reconciliationStore?: PaymentReconciliationStorePort;
  readonly sponsorReconciliationStore?: SponsorGrantReconciliationStorePort;
  readonly reconciliation?: {
    readonly redisUrl: string;
    readonly operationsForOwner: (ownerAddress: EvmAddress) => UniversalOperationPort;
  };
  readonly particleProfile?: IndexerParticleProfileReadiness;
  readonly close?: () => Promise<void>;
}

let registeredDependencies: IndexerRuntimeDependencies | undefined;

/**
 * Server-only composition seam. Vendor adapters register normalized ports;
 * the executable never imports vendor SDKs or accepts raw RPC URLs itself.
 */
export function configureIndexerRuntimeDependencies(
  dependencies: IndexerRuntimeDependencies,
): void {
  registeredDependencies = dependencies;
}

export function clearIndexerRuntimeDependenciesForTest(): void {
  registeredDependencies = undefined;
}

export interface IndexerRuntimeHandle {
  readonly mode: 'disabled' | 'paused' | 'running';
  readonly config: IndexerRuntimeConfig;
  readonly completion: Promise<void>;
  stop(): Promise<void>;
}

export async function startIndexerRuntime(input: {
  env: Record<string, string | undefined>;
  dependencies?: IndexerRuntimeDependencies;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  signal?: AbortSignal;
  runOnce?: boolean;
}): Promise<IndexerRuntimeHandle> {
  const config = parseIndexerRuntimeConfig(input.env);
  if (!config.enabled) {
    input.logger.info({ status: 'disabled' }, 'OpenTab indexer is disabled');
    return {
      mode: 'disabled',
      config,
      completion: Promise.resolve(),
      stop: async () => undefined,
    };
  }

  const dependencies = input.dependencies ?? registeredDependencies;
  if (dependencies === undefined) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Live indexer RPC adapters were not injected; startup stopped safely.',
    );
  }
  if (
    dependencies.particleProfile !== undefined &&
    dependencies.particleProfile.profileScopeId !== config.profileScopeId
  ) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The loaded Particle profile is bound to a different compatibility scope.',
    );
  }

  let closePersistence = dependencies.close;
  let store: IndexerStore;
  let reconciliationStore = dependencies.reconciliationStore;
  let sponsorReconciliationStore = dependencies.sponsorReconciliationStore;
  if (dependencies.store === undefined) {
    if (config.databaseUrl === undefined) {
      throw new AppError('CONFIGURATION_INVALID', 'The indexer database URL is required.');
    }
    const persistence = await createPostgresIndexerPersistence(config.databaseUrl);
    store = persistence.store;
    reconciliationStore = persistence.reconciliationStore;
    sponsorReconciliationStore = persistence.sponsorReconciliationStore;
    const injectedClose = closePersistence;
    closePersistence = async () => {
      await injectedClose?.();
      await persistence.close();
    };
  } else {
    store = dependencies.store;
  }

  const source = new FailoverArbitrumReadPort(
    dependencies.primaryChain,
    dependencies.fallbackChain,
    {
      failureThreshold: config.rpcFailureThreshold,
      cooldownMs: config.rpcCooldownMs,
      timeoutMs: config.rpcTimeoutMs,
      onFailover: (method) => input.logger.warn({ method }, 'Indexer RPC failover engaged'),
    },
  );
  const scanner = new IndexerScanner(source, store, new OpenTabContractLogDecoder(), {
    chainId: config.chainId,
    stream: config.stream,
    addresses: config.addresses as readonly `0x${string}`[],
    contracts: {
      checkout: config.checkoutAddress as `0x${string}`,
      pass: config.passAddress as `0x${string}`,
      ...(config.splitAddress === undefined ? {} : { split: config.splitAddress as `0x${string}` }),
    },
    startBlock: config.startBlock,
    confirmationDepth: config.confirmationDepth,
    reorgWindowBlocks: config.reorgWindowBlocks,
    maxBlockRange: config.maxBlockRange,
    leaseOwner: config.leaseOwner,
    leaseTtlMs: config.leaseTtlMs,
  });
  const sponsorReconciler =
    sponsorReconciliationStore === undefined
      ? undefined
      : new SponsorGrantReconciler(source, sponsorReconciliationStore, {
          confirmationDepth: config.confirmationDepth,
          batchSize: 100,
        });
  const health = new IndexerHealthTracker({
    maxReadyLagBlocks: config.maxReadyLagBlocks,
    staleAfterMs: config.staleAfterMs,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    ...(dependencies.particleProfile === undefined
      ? {}
      : { particleProfile: dependencies.particleProfile }),
  });
  const healthServer = createIndexerHealthServer({
    tracker: health,
    host: config.healthHost,
    port: config.healthPort,
  });
  await healthServer.listen();

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) controller.abort(input.signal.reason);
  else input.signal?.addEventListener('abort', abortFromParent, { once: true });
  let stopped = false;
  let reconciliationRuntime: BullMqPaymentReconciliationRuntime | undefined;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    health.setDraining();
    controller.abort();
    input.signal?.removeEventListener('abort', abortFromParent);
    await reconciliationRuntime?.close();
    await healthServer.close();
    await closePersistence?.();
  };

  if (!config.writesEnabled) {
    input.logger.warn({ status: 'paused' }, 'OpenTab indexer writes are paused');
    const completion = new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', () => resolve(), { once: true });
    }).finally(close);
    return {
      mode: 'paused',
      config,
      completion,
      stop: close,
    };
  }

  if (dependencies.reconciliation !== undefined) {
    if (reconciliationStore === undefined) {
      await close();
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Payment reconciliation persistence is not configured.',
      );
    }
    reconciliationRuntime = new BullMqPaymentReconciliationRuntime({
      redisUrl: dependencies.reconciliation.redisUrl,
      store: reconciliationStore,
      operationsForOwner: dependencies.reconciliation.operationsForOwner,
      logger: input.logger,
      baseBackoffMs: config.retryBaseMs,
      maxBackoffMs: config.retryMaxMs,
    });
    try {
      await reconciliationRuntime.start();
    } catch (error) {
      await close();
      throw error;
    }
  }

  if (input.runOnce) {
    const completion = (async () => {
      try {
        const result = await scanner.scanOnce();
        if (result.kind === 'lease_standby') {
          health.recordStandby();
          throw new AppError(
            'INDEXER_LAGGING',
            'The run-once indexer could not acquire the stream lease.',
            { retryable: true },
          );
        }
        const sponsorResult = await sponsorReconciler?.reconcileOnce();
        health.recordSuccess(result);
        input.logger.info(
          {
            kind: result.kind,
            processedBlocks: result.processedBlocks,
            processedLogs: result.processedLogs,
            lagBlocks: result.lagBlocks.toString(),
          },
          'OpenTab indexer completed one scan',
        );
        if (sponsorResult !== undefined) {
          input.logger.info(sponsorResult, 'Bootstrap sponsor reconciliation completed');
        }
      } finally {
        await close();
      }
    })();
    return { mode: 'running', config, completion, stop: close };
  }

  const runner = new IndexerRunner(scanner, health, {
    pollIntervalMs: config.pollIntervalMs,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
    ...(sponsorReconciler === undefined
      ? {}
      : {
          afterScan: async () => {
            const result = await sponsorReconciler.reconcileOnce();
            if (result.inspected > 0) {
              input.logger.info(result, 'Bootstrap sponsor reconciliation completed');
            }
          },
        }),
    onError: (error) => input.logger.error({ err: error }, 'Indexer scan failed'),
    onStandby: (result) =>
      input.logger.info(
        { stream: config.stream, nextBlock: result.nextBlock.toString() },
        'OpenTab indexer is standing by for the active stream lease',
      ),
    onLeaseAcquired: (result) =>
      input.logger.info(
        { stream: config.stream, nextBlock: result.nextBlock.toString() },
        'OpenTab indexer resumed after stream lease handoff',
      ),
  });
  const completion = runner.run(controller.signal).finally(close);
  input.logger.info(
    {
      stream: config.stream,
      startBlock: config.startBlock.toString(),
      confirmationDepth: config.confirmationDepth,
      addressCount: config.addresses.length,
    },
    'OpenTab indexer started',
  );
  return { mode: 'running', config, completion, stop: close };
}
