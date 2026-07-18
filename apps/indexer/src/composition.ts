import type { ArbitrumReadPort, UniversalOperationPort } from '@opentab/application';
import { parseIndexerEnvironment } from '@opentab/config';
import {
  type ArbitrumAdapterConfig,
  createParticleUniversalAccountAdapter,
  createViemArbitrumReadAdapter,
  type ParticleRecordedResponseProfile,
  type ParticleSourceCallPolicy,
} from '@opentab/integrations/indexer';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  digestParticleProjectConfiguration,
  type EvmAddress,
  type ParticleCompatibilityProfile,
  type ProductId,
} from '@opentab/shared';
import { parseIndexerRuntimeConfig } from './config.js';
import {
  type IndexerParticleProfileLoader,
  type LoadedIndexerParticleProfile,
  loadIndexerParticleProfile,
} from './particle-profile.js';
import type { IndexerRuntimeDependencies } from './runtime.js';

export type IndexerChainFactory = (config: ArbitrumAdapterConfig) => ArbitrumReadPort;
export type IndexerParticleOperationsFactory = (
  config: Parameters<typeof createParticleUniversalAccountAdapter>[0],
) => UniversalOperationPort;

const PARTICLE_PROFILE_CACHE_MS = 15_000;

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new AppError('CONFIGURATION_INVALID', `${name} is required by the enabled indexer.`);
  }
  return value;
}

function profileEnvironment(value: string): 'demo-mainnet' | 'production' {
  if (value === 'demo-mainnet' || value === 'production') return value;
  throw new AppError(
    'CONFIGURATION_INVALID',
    'Live Particle indexer profiles are restricted to demo-mainnet or production.',
  );
}

function assertScopedProfile(input: {
  readonly loaded: LoadedIndexerParticleProfile | undefined;
  readonly environment: 'demo-mainnet' | 'production';
  readonly profileScopeId: string;
  readonly expectedProjectConfigDigest: string;
}): LoadedIndexerParticleProfile | undefined {
  const loaded = input.loaded;
  if (loaded === undefined) return undefined;
  const { profile, binding } = loaded;
  if (
    binding.environment !== input.environment ||
    profile.environment !== input.environment ||
    binding.profileScopeId !== input.profileScopeId ||
    binding.chainId !== ARBITRUM_ONE_CHAIN_ID ||
    profile.chainId !== ARBITRUM_ONE_CHAIN_ID ||
    binding.profileId !== profile.profileId ||
    binding.stage !== profile.stage ||
    profile.particleSdkVersion !== '2.0.3' ||
    profile.useEIP7702 !== true ||
    profile.particleProjectConfigDigest.toLowerCase() !==
      input.expectedProjectConfigDigest.toLowerCase()
  ) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The loaded Particle profile does not match this compatibility scope, chain, SDK, or project.',
    );
  }
  return loaded;
}

function bytes32Hex(value: string, name: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new AppError('CONFIGURATION_INVALID', `${name} must be an exact bytes32 value.`);
  }
  return value as `0x${string}`;
}

function selectorHex(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{8}$/.test(value)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Particle source-call selector must be exactly four bytes.',
    );
  }
  return value as `0x${string}`;
}

function particleResponseProfile(
  profile: ParticleCompatibilityProfile,
): ParticleRecordedResponseProfile {
  return {
    profileId: profile.profileId,
    provenance: 'recorded_live' as const,
    deploymentsFixtureDigest: bytes32Hex(
      profile.responseDigests.deployments,
      'Particle deployments fixture digest',
    ),
    authFixtureDigest: bytes32Hex(
      profile.responseDigests.auth,
      'Particle authorization fixture digest',
    ),
    ...(profile.responseDigests.submission === undefined
      ? {}
      : {
          submissionFixtureDigest: bytes32Hex(
            profile.responseDigests.submission,
            'Particle submission fixture digest',
          ),
        }),
    ...(profile.responseDigests.status === undefined
      ? {}
      : {
          statusFixtureDigest: bytes32Hex(
            profile.responseDigests.status,
            'Particle status fixture digest',
          ),
        }),
    magicAuthorizationNonceOffset: profile.nonceConvention.magicAuthorizationNonceOffset,
    delegationPlanTtlSeconds: profile.nonceConvention.delegationPlanTtlSeconds,
  };
}

function requireReconciliationProfile(
  loaded: LoadedIndexerParticleProfile | undefined,
): LoadedIndexerParticleProfile {
  if (loaded === undefined || loaded.profile.stage === 'bootstrap') {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Particle reconciliation requires a canary-ready or certified compatibility profile.',
    );
  }
  required(loaded.profile.sourceTokenProfile, 'Particle source-token profile');
  return loaded;
}

function createLazyParticleOperations(input: {
  readonly ownerAddress: EvmAddress;
  readonly resolveProfile: () => Promise<LoadedIndexerParticleProfile>;
  readonly createOperations: (
    ownerAddress: EvmAddress,
    profile: ParticleCompatibilityProfile,
  ) => UniversalOperationPort;
}): UniversalOperationPort {
  const resolveOperations = async () => {
    const loaded = await input.resolveProfile();
    return input.createOperations(input.ownerAddress, loaded.profile);
  };
  return {
    getAccount: async () => (await resolveOperations()).getAccount(),
    getUnifiedBalance: async () => (await resolveOperations()).getUnifiedBalance(),
    getDelegation: async () => (await resolveOperations()).getDelegation(),
    prepareDelegation: async () => (await resolveOperations()).prepareDelegation(),
    prepareOperation: async (template) => (await resolveOperations()).prepareOperation(template),
    validateOperation: async (operationInput) =>
      (await resolveOperations()).validateOperation(operationInput),
    submitValidated: async (operationInput) =>
      (await resolveOperations()).submitValidated(operationInput),
    getOperation: async (id) => (await resolveOperations()).getOperation(id),
  };
}

/**
 * Builds the executable's live dependencies from one validated environment
 * and one stable compatibility scope. Legacy profile env values are
 * deliberately ignored: the database binding is authoritative.
 */
export async function createProductionIndexerDependencies(
  env: Record<string, string | undefined>,
  factory: IndexerChainFactory = createViemArbitrumReadAdapter,
  profileLoader: IndexerParticleProfileLoader = loadIndexerParticleProfile,
  operationsFactory: IndexerParticleOperationsFactory = createParticleUniversalAccountAdapter,
): Promise<IndexerRuntimeDependencies> {
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
  const environment = server.PARTICLE_LIVE_ENABLED ? profileEnvironment(server.APP_ENV) : undefined;
  const profileScopeId = runtime.profileScopeId;
  const expectedProjectConfigDigest = server.PARTICLE_LIVE_ENABLED
    ? digestParticleProjectConfiguration({
        projectId: server.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
        projectClientKey: server.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
        projectAppUuid: server.NEXT_PUBLIC_PARTICLE_APP_UUID,
      })
    : undefined;
  const profileLoadInput =
    profileScopeId === undefined || environment === undefined
      ? undefined
      : {
          databaseUrl: required(runtime.databaseUrl, 'DATABASE_URL_INDEXER'),
          environment,
          profileScopeId,
          chainId: ARBITRUM_ONE_CHAIN_ID,
        };
  const validateLoadedProfile = (loaded: LoadedIndexerParticleProfile | undefined) => {
    if (profileScopeId === undefined || environment === undefined) return undefined;
    return assertScopedProfile({
      loaded,
      environment,
      profileScopeId,
      expectedProjectConfigDigest: required(
        expectedProjectConfigDigest,
        'Particle project configuration digest',
      ),
    });
  };
  const loadedProfile =
    profileLoadInput === undefined
      ? undefined
      : validateLoadedProfile(await profileLoader(profileLoadInput));
  const profile = loadedProfile?.profile;
  let cachedReconciliationProfile =
    loadedProfile === undefined || loadedProfile.profile.stage === 'bootstrap'
      ? undefined
      : { loaded: loadedProfile, expiresAt: Date.now() + PARTICLE_PROFILE_CACHE_MS };
  let profileLoadInFlight: Promise<LoadedIndexerParticleProfile | undefined> | undefined;
  const resolveReconciliationProfile = async (): Promise<LoadedIndexerParticleProfile> => {
    if (
      cachedReconciliationProfile !== undefined &&
      cachedReconciliationProfile.expiresAt > Date.now()
    ) {
      return cachedReconciliationProfile.loaded;
    }
    if (profileLoadInput === undefined) {
      return requireReconciliationProfile(undefined);
    }
    const pendingLoad =
      profileLoadInFlight ?? profileLoader(profileLoadInput).then(validateLoadedProfile);
    profileLoadInFlight = pendingLoad;
    try {
      const resolved = requireReconciliationProfile(await pendingLoad);
      cachedReconciliationProfile = {
        loaded: resolved,
        expiresAt: Date.now() + PARTICLE_PROFILE_CACHE_MS,
      };
      return resolved;
    } finally {
      if (profileLoadInFlight === pendingLoad) profileLoadInFlight = undefined;
    }
  };
  const common = {
    environment: server.APP_ENV,
    checkoutAddress: server.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: server.NEXT_PUBLIC_PASS_ADDRESS,
    ...(runtime.addresses.length > 2 ? { splitAddress: server.NEXT_PUBLIC_SPLIT_ADDRESS } : {}),
    ...(profile === undefined ? {} : { expectedDelegationImplementation: profile.delegateAddress }),
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

  const createOperations = (
    ownerAddress: EvmAddress,
    liveProfile: ParticleCompatibilityProfile,
  ) => {
    const sourceTokenProfile = required(
      liveProfile.sourceTokenProfile,
      'Particle source-token profile',
    );
    const sourceCallPolicies: readonly ParticleSourceCallPolicy[] =
      sourceTokenProfile.sourceCallPolicies.map((policy) => ({
        ...policy,
        functionSelector: selectorHex(policy.functionSelector),
      }));
    return operationsFactory({
      projectId: server.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: server.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: server.NEXT_PUBLIC_PARTICLE_APP_UUID,
      ownerAddress,
      expectedImplementationAddress: liveProfile.delegateAddress,
      expectedImplementationCodeHash: bytes32Hex(
        liveProfile.delegateCodeHash,
        'Particle delegation implementation code hash',
      ),
      environment: server.APP_ENV,
      slippageBps: server.PARTICLE_MAX_SLIPPAGE_BPS,
      maxFeeUsdMicros: server.PARTICLE_MAX_FEE_USD_MICROS,
      allowedSourceChainIds: sourceTokenProfile.allowedSourceChainIds,
      allowedSourceAssets: sourceTokenProfile.allowedSourceAssets,
      allowedSourceTokens: sourceTokenProfile.allowedSourceTokens,
      sourceCallPolicies,
      responseProfile: particleResponseProfile(liveProfile),
      ...(server.PARTICLE_RPC_URL === undefined ? {} : { rpcUrl: server.PARTICLE_RPC_URL }),
    });
  };
  const reconciliation =
    !runtime.reconciliationEnabled || !server.PARTICLE_LIVE_ENABLED
      ? undefined
      : {
          redisUrl: required(server.REDIS_URL, 'REDIS_URL'),
          operationsForOwner: (ownerAddress: EvmAddress) =>
            createLazyParticleOperations({
              ownerAddress,
              resolveProfile: resolveReconciliationProfile,
              createOperations,
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
    ...(loadedProfile === undefined
      ? {}
      : {
          particleProfile: {
            profileScopeId: loadedProfile.binding.profileScopeId,
            profileId: loadedProfile.binding.profileId,
            profileDigest: loadedProfile.binding.profileDigest,
            stage: loadedProfile.binding.stage,
          },
        }),
  };
}
