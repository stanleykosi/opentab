import { pathToFileURL } from 'node:url';
import { createOpenTabLogger } from '@opentab/observability';
import { isAppError } from '@opentab/shared';
import { parseIndexerRuntimeConfig } from './config.js';
import { startIndexerRuntime } from './runtime.js';

export * from './config.js';
export * from './decoder.js';
export * from './failover.js';
export * from './health.js';
export * from './reconciler.js';
export * from './reconciliation-runtime.js';
export * from './runner.js';
export * from './runtime.js';
export * from './scanner.js';
export * from './sponsor-reconciler.js';
export * from './types.js';

async function main(): Promise<void> {
  const config = parseIndexerRuntimeConfig(process.env);
  const logger = createOpenTabLogger({
    service: 'opentab-indexer',
    environment: config.environment,
    level: config.logLevel,
  });
  const shutdown = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'OpenTab indexer shutdown requested');
    shutdown.abort(signal);
  };
  const stopForSigint = () => stop('SIGINT');
  const stopForSigterm = () => stop('SIGTERM');
  process.once('SIGINT', stopForSigint);
  process.once('SIGTERM', stopForSigterm);
  try {
    const dependencies = config.enabled
      ? (await import('./composition.js')).createProductionIndexerDependencies(process.env)
      : undefined;
    const runtime = await startIndexerRuntime({
      env: process.env,
      ...(dependencies === undefined ? {} : { dependencies }),
      logger,
      signal: shutdown.signal,
      runOnce: process.argv.includes('--once'),
    });
    await runtime.completion;
  } finally {
    process.off('SIGINT', stopForSigint);
    process.off('SIGTERM', stopForSigterm);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
    process.stderr.write(
      `${JSON.stringify({ service: 'opentab-indexer', status: 'startup-failed', code })}\n`,
    );
    process.exitCode = 1;
  });
}
