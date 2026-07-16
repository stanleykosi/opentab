import type { ArbitrumReadPort } from '@opentab/application';
import { parseIndexerEnvironment } from '@opentab/config';
import {
  type ArbitrumAdapterConfig,
  createParticleUniversalAccountAdapter,
  createViemArbitrumReadAdapter,
} from '@opentab/integrations/indexer';
import { AppError, type ProductId } from '@opentab/shared';
import { parseIndexerRuntimeConfig } from './config.js';
import type { IndexerRuntimeDependencies } from './runtime.js';

export type IndexerChainFactory = (config: ArbitrumAdapterConfig) => ArbitrumReadPort;

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new AppError('CONFIGURATION_INVALID', `${name} is required by the enabled indexer.`);
  }
  return value;
}

/**
 * Builds the executable's live dependencies from the same validated process
 * environment as the runtime. Each failover leg prefers a different RPC
 * provider; the integration adapter still retains a bounded secondary retry.
 */
export function createProductionIndexerDependencies(
  env: Record<string, string | undefined>,
  factory: IndexerChainFactory = createViemArbitrumReadAdapter,
): IndexerRuntimeDependencies {
  const runtime = parseIndexerRuntimeConfig(env);
  if (!runtime.enabled) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Indexer dependencies cannot be composed while the indexer is disabled.',
    );
  }
  const server = parseIndexerEnvironment(env);
  const primaryRpcUrl = required(server.ARBITRUM_RPC_URL, 'ARBITRUM_RPC_URL');
  const fallbackRpcUrl = required(server.ARBITRUM_FALLBACK_RPC_URL, 'ARBITRUM_FALLBACK_RPC_URL');
  const common = {
    environment: server.APP_ENV,
    checkoutAddress: server.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: server.NEXT_PUBLIC_PASS_ADDRESS,
    ...(runtime.addresses.length > 2 ? { splitAddress: server.NEXT_PUBLIC_SPLIT_ADDRESS } : {}),
    expectedDelegationImplementation: required(
      server.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
      'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
    ),
    deploymentBlock: runtime.startBlock,
    maxLogRange: BigInt(runtime.maxBlockRange),
    maxOrderLookupBlocks: 5_000_000n,
    requestTimeoutMs: runtime.rpcTimeoutMs,
    resolveProductOnchainId(_productId: ProductId): bigint {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'The indexer scanning adapter does not resolve application product IDs.',
      );
    },
  } satisfies Omit<ArbitrumAdapterConfig, 'primaryRpcUrl' | 'fallbackRpcUrl'>;

  const reconciliation = !runtime.reconciliationEnabled
    ? undefined
    : {
        redisUrl: required(server.REDIS_URL, 'REDIS_URL'),
        operationsForOwner: (
          ownerAddress: Parameters<typeof createParticleUniversalAccountAdapter>[0]['ownerAddress'],
        ) =>
          createParticleUniversalAccountAdapter({
            projectId: server.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
            projectClientKey: server.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
            projectAppUuid: server.NEXT_PUBLIC_PARTICLE_APP_UUID,
            ownerAddress,
            expectedImplementationAddress: required(
              server.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
              'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
            ),
            expectedImplementationCodeHash: required(
              server.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH,
              'PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH',
            ) as `0x${string}`,
            environment: server.APP_ENV,
            slippageBps: server.PARTICLE_MAX_SLIPPAGE_BPS,
            maxFeeUsdMicros: server.PARTICLE_MAX_FEE_USD_MICROS,
            allowedSourceChainIds: server.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS,
            allowedSourceAssets: server.PARTICLE_ALLOWED_SOURCE_ASSETS,
            allowedSourceTokens: server.PARTICLE_ALLOWED_SOURCE_TOKENS,
            sourceCallProfiles: server.PARTICLE_SOURCE_CALL_PROFILES_JSON,
            responseProfile: {
              profileId: required(
                server.PARTICLE_RESPONSE_PROFILE_ID,
                'PARTICLE_RESPONSE_PROFILE_ID',
              ),
              provenance: 'recorded_live' as const,
              deploymentsFixtureDigest: required(
                server.PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST,
                'PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST',
              ) as `0x${string}`,
              authFixtureDigest: required(
                server.PARTICLE_AUTH_FIXTURE_DIGEST,
                'PARTICLE_AUTH_FIXTURE_DIGEST',
              ) as `0x${string}`,
              submissionFixtureDigest: required(
                server.PARTICLE_SUBMISSION_FIXTURE_DIGEST,
                'PARTICLE_SUBMISSION_FIXTURE_DIGEST',
              ) as `0x${string}`,
              statusFixtureDigest: required(
                server.PARTICLE_STATUS_FIXTURE_DIGEST,
                'PARTICLE_STATUS_FIXTURE_DIGEST',
              ) as `0x${string}`,
              magicAuthorizationNonceOffset: required(
                server.PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET,
                'PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET',
              ),
              delegationPlanTtlSeconds: required(
                server.PARTICLE_DELEGATION_PLAN_TTL_SECONDS,
                'PARTICLE_DELEGATION_PLAN_TTL_SECONDS',
              ),
            },
            ...(server.PARTICLE_RPC_URL === undefined ? {} : { rpcUrl: server.PARTICLE_RPC_URL }),
          }),
      };

  return {
    primaryChain: factory({
      ...common,
      primaryRpcUrl,
      fallbackRpcUrl,
    }),
    fallbackChain: factory({
      ...common,
      primaryRpcUrl: fallbackRpcUrl,
      fallbackRpcUrl: primaryRpcUrl,
    }),
    ...(reconciliation === undefined ? {} : { reconciliation }),
  };
}
