import { parseIndexerEnvironment } from '@opentab/config';
import { AppError, ARBITRUM_ONE_CHAIN_ID, type EvmAddressSchema } from '@opentab/shared';
import { z } from 'zod';

const integer = (minimum: number, maximum: number, fallback: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

const healthPort = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,4})$/)
  .transform((value) => Number(value))
  .pipe(z.number().int().min(0).max(65_535));

const IndexerProcessEnvironmentSchema = z.object({
  INDEXER_MAX_BLOCK_RANGE: integer(1, 10_000, 1_000),
  INDEXER_LEASE_TTL_MS: integer(1_000, 300_000, 30_000),
  INDEXER_POLL_INTERVAL_MS: integer(100, 300_000, 5_000),
  INDEXER_RETRY_BASE_MS: integer(100, 60_000, 1_000),
  INDEXER_RETRY_MAX_MS: integer(1_000, 600_000, 60_000),
  INDEXER_RPC_FAILURE_THRESHOLD: integer(1, 20, 3),
  INDEXER_RPC_COOLDOWN_MS: integer(1_000, 600_000, 30_000),
  INDEXER_RPC_TIMEOUT_MS: integer(100, 120_000, 15_000),
  INDEXER_HEALTH_PORT: healthPort,
  INDEXER_HEALTH_HOST: z.string().min(1).max(255).default('0.0.0.0'),
  INDEXER_MAX_READY_LAG_BLOCKS: z.coerce.bigint().min(0n).default(20n),
  INDEXER_STALE_AFTER_MS: integer(1_000, 3_600_000, 120_000),
  INDEXER_MAX_CONSECUTIVE_FAILURES: integer(1, 100, 5),
  INDEXER_STREAM: z
    .string()
    .regex(/^[a-z0-9_-]{1,80}$/)
    .default('opentab-contracts-v3'),
  INDEXER_LEASE_OWNER: z.string().min(1).max(120).optional(),
});

const zeroAddress = /^0x0{40}$/i;

export interface IndexerRuntimeConfig {
  readonly enabled: boolean;
  readonly writesEnabled: boolean;
  readonly reconciliationEnabled: boolean;
  readonly environment: string;
  readonly logLevel: string;
  readonly databaseUrl?: string;
  readonly chainId: typeof ARBITRUM_ONE_CHAIN_ID;
  readonly addresses: readonly ReturnType<typeof EvmAddressSchema.parse>[];
  readonly checkoutAddress: ReturnType<typeof EvmAddressSchema.parse>;
  readonly passAddress: ReturnType<typeof EvmAddressSchema.parse>;
  readonly splitAddress?: ReturnType<typeof EvmAddressSchema.parse>;
  readonly startBlock: bigint;
  readonly confirmationDepth: number;
  readonly reorgWindowBlocks: number;
  readonly maxBlockRange: number;
  readonly leaseOwner: string;
  readonly leaseTtlMs: number;
  readonly pollIntervalMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly rpcFailureThreshold: number;
  readonly rpcCooldownMs: number;
  readonly rpcTimeoutMs: number;
  readonly healthPort: number;
  readonly healthHost: string;
  readonly maxReadyLagBlocks: bigint;
  readonly staleAfterMs: number;
  readonly maxConsecutiveFailures: number;
  readonly stream: string;
}

function defaultLeaseOwner(): string {
  const deployment = process.env['VERCEL_DEPLOYMENT_ID'] ?? process.env['HOSTNAME'] ?? 'local';
  return `indexer-${deployment}-${process.pid}`.slice(0, 120);
}

export function parseIndexerRuntimeConfig(
  input: Record<string, string | undefined>,
): IndexerRuntimeConfig {
  const indexer = parseIndexerEnvironment(input);
  const processConfig = IndexerProcessEnvironmentSchema.parse({
    ...input,
    INDEXER_HEALTH_PORT: input['INDEXER_HEALTH_PORT'] ?? input['PORT'] ?? '3002',
  });
  if (processConfig.INDEXER_RETRY_MAX_MS < processConfig.INDEXER_RETRY_BASE_MS) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The indexer retry maximum must be at least the retry base.',
    );
  }
  const addresses = [
    indexer.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    indexer.NEXT_PUBLIC_PASS_ADDRESS,
    ...(zeroAddress.test(indexer.NEXT_PUBLIC_SPLIT_ADDRESS)
      ? []
      : [indexer.NEXT_PUBLIC_SPLIT_ADDRESS]),
  ].filter((address) => !zeroAddress.test(address));
  if (indexer.INDEXER_ENABLED && addresses.length < 2) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The checkout and pass deployment addresses are required by the indexer.',
    );
  }
  return {
    enabled: indexer.INDEXER_ENABLED,
    writesEnabled: indexer.INDEXER_WRITES_ENABLED,
    reconciliationEnabled: indexer.INDEXER_RECONCILIATION_ENABLED,
    environment: indexer.APP_ENV,
    logLevel: indexer.LOG_LEVEL,
    ...(indexer.DATABASE_URL_INDEXER === undefined
      ? {}
      : { databaseUrl: indexer.DATABASE_URL_INDEXER }),
    chainId: ARBITRUM_ONE_CHAIN_ID,
    addresses,
    checkoutAddress: indexer.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: indexer.NEXT_PUBLIC_PASS_ADDRESS,
    ...(zeroAddress.test(indexer.NEXT_PUBLIC_SPLIT_ADDRESS)
      ? {}
      : { splitAddress: indexer.NEXT_PUBLIC_SPLIT_ADDRESS }),
    startBlock: indexer.INDEXER_DEPLOYMENT_BLOCK,
    confirmationDepth: indexer.CONFIRMATION_DEPTH,
    reorgWindowBlocks: indexer.REORG_WINDOW_BLOCKS,
    maxBlockRange: processConfig.INDEXER_MAX_BLOCK_RANGE,
    leaseOwner: processConfig.INDEXER_LEASE_OWNER ?? defaultLeaseOwner(),
    leaseTtlMs: processConfig.INDEXER_LEASE_TTL_MS,
    pollIntervalMs: processConfig.INDEXER_POLL_INTERVAL_MS,
    retryBaseMs: processConfig.INDEXER_RETRY_BASE_MS,
    retryMaxMs: processConfig.INDEXER_RETRY_MAX_MS,
    rpcFailureThreshold: processConfig.INDEXER_RPC_FAILURE_THRESHOLD,
    rpcCooldownMs: processConfig.INDEXER_RPC_COOLDOWN_MS,
    rpcTimeoutMs: processConfig.INDEXER_RPC_TIMEOUT_MS,
    healthPort: processConfig.INDEXER_HEALTH_PORT,
    healthHost: processConfig.INDEXER_HEALTH_HOST,
    maxReadyLagBlocks: processConfig.INDEXER_MAX_READY_LAG_BLOCKS,
    staleAfterMs: processConfig.INDEXER_STALE_AFTER_MS,
    maxConsecutiveFailures: processConfig.INDEXER_MAX_CONSECUTIVE_FAILURES,
    stream: processConfig.INDEXER_STREAM,
  };
}
