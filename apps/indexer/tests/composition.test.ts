import type { ArbitrumReadPort, UniversalOperationPort } from '@opentab/application';
import {
  ARBITRUM_ONE_CHAIN_ID,
  deriveParticleCompatibilityScopeId,
  digestParticleCompatibilityProfile,
  digestParticleProjectConfiguration,
  EvmAddressSchema,
  type ParticleCompatibilityProfile,
  ParticleCompatibilityProfileSchema,
  ParticleProfileReleaseBindingSchema,
  type ProviderOperation,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  ProviderOperationSchema,
} from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createProductionIndexerDependencies,
  type IndexerChainFactory,
  type IndexerParticleOperationsFactory,
} from '../src/composition.js';
import type {
  IndexerParticleProfileLoader,
  LoadedIndexerParticleProfile,
  LoadIndexerParticleProfileInput,
} from '../src/particle-profile.js';

const address = (digit: string) => EvmAddressSchema.parse(`0x${digit.repeat(40)}`);

function environment(): Record<string, string> {
  return {
    APP_ENV: 'demo-mainnet',
    NEXT_PUBLIC_APP_ENV: 'demo-mainnet',
    NEXT_PUBLIC_APP_ORIGIN: 'https://demo.opentab.example',
    INDEXER_ENABLED: 'true',
    INDEXER_WRITES_ENABLED: 'true',
    DATABASE_URL_INDEXER:
      'postgresql://opentab_indexer:secret@db.example:5432/opentab?sslmode=verify-full',
    REDIS_URL: 'rediss://default:secret@redis.example:6380',
    ARBITRUM_RPC_URL: 'https://rpc-primary.example',
    ARBITRUM_FALLBACK_RPC_URL: 'https://rpc-fallback.example',
    NEXT_PUBLIC_CHECKOUT_ADDRESS: address('1'),
    NEXT_PUBLIC_PASS_ADDRESS: address('2'),
    NEXT_PUBLIC_SPLIT_ADDRESS: address('3'),
    NEXT_PUBLIC_USDC_ADDRESS: address('a'),
    PARTICLE_LIVE_ENABLED: 'true',
    NEXT_PUBLIC_PARTICLE_PROJECT_ID: 'particle-project-indexer',
    NEXT_PUBLIC_PARTICLE_CLIENT_KEY: 'particle-client-indexer',
    NEXT_PUBLIC_PARTICLE_APP_UUID: 'particle-app-indexer',
    INDEXER_DEPLOYMENT_BLOCK: '1234',
    INDEXER_MAX_BLOCK_RANGE: '250',
    INDEXER_RPC_TIMEOUT_MS: '9000',
  };
}

function compatibilityScopeId(): string {
  const env = environment();
  return deriveParticleCompatibilityScopeId({
    environment: 'demo-mainnet',
    chainId: ARBITRUM_ONE_CHAIN_ID,
    projectId: env.NEXT_PUBLIC_PARTICLE_PROJECT_ID ?? '',
    projectClientKey: env.NEXT_PUBLIC_PARTICLE_CLIENT_KEY ?? '',
    projectAppUuid: env.NEXT_PUBLIC_PARTICLE_APP_UUID ?? '',
    checkoutAddress: env.NEXT_PUBLIC_CHECKOUT_ADDRESS ?? '',
    passAddress: env.NEXT_PUBLIC_PASS_ADDRESS ?? '',
    tokenAddress: env.NEXT_PUBLIC_USDC_ADDRESS ?? '',
  });
}

function loadedProfile(
  input: LoadIndexerParticleProfileInput,
  stage: ParticleCompatibilityProfile['stage'] = 'canary_ready',
): LoadedIndexerParticleProfile {
  const project = environment();
  const profile = ParticleCompatibilityProfileSchema.parse({
    schemaVersion: 1,
    profileId: `indexer-recorded-live-${stage}-v1`,
    stage,
    environment: input.environment,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    particleSdkVersion: '2.0.3',
    particleProtocolVersion: '2.0',
    particleProjectConfigDigest: digestParticleProjectConfiguration({
      projectId: project.NEXT_PUBLIC_PARTICLE_PROJECT_ID ?? '',
      projectClientKey: project.NEXT_PUBLIC_PARTICLE_CLIENT_KEY ?? '',
      projectAppUuid: project.NEXT_PUBLIC_PARTICLE_APP_UUID ?? '',
    }),
    useEIP7702: true,
    delegateAddress: address('4'),
    delegateCodeHash: `0x${'5'.repeat(64)}`,
    responseDigests: {
      deployments: `0x${'6'.repeat(64)}`,
      auth: `0x${'7'.repeat(64)}`,
      ...(stage === 'certified'
        ? {
            submission: `0x${'8'.repeat(64)}` as const,
            status: `0x${'9'.repeat(64)}` as const,
          }
        : {}),
    },
    nonceConvention: {
      magicAuthorizationNonceOffset: 0,
      delegationPlanTtlSeconds: 300,
    },
    ...(stage === 'bootstrap'
      ? {}
      : {
          sourceTokenProfile: {
            allowedSourceChainIds: [ARBITRUM_ONE_CHAIN_ID, '8453'],
            allowedSourceAssets: ['USDC'],
            allowedSourceTokens: [{ chainId: '8453', asset: 'USDC', address: address('6') }],
            sourceCallPolicies: [
              {
                policyId: 'base-source-call-v1',
                chainId: '8453',
                asset: 'USDC',
                tokenAddress: address('6'),
                uaType: 'evm',
                target: address('6'),
                functionSelector: '0xa9059cbb',
                nativeValueAllowed: false,
                maxCalls: 1,
                capturedFixtureDigest: `0x${'a'.repeat(64)}`,
              },
            ],
          },
        }),
    ...(stage === 'certified'
      ? {
          canonicalCanaryEvidence: {
            paymentAttemptId: 'pay_01J00000000000000000000000',
            orderKey: `0x${'c'.repeat(64)}`,
            transactionHash: `0x${'d'.repeat(64)}`,
            blockHash: `0x${'e'.repeat(64)}`,
            acceptanceEvidenceDigest: `0x${'f'.repeat(64)}`,
          },
        }
      : {}),
    capturedAt: '2026-07-18T10:00:00.000Z',
  });
  const releaseBinding = ParticleProfileReleaseBindingSchema.parse({
    schemaVersion: 1,
    environment: input.environment,
    applicationReleaseId: input.profileScopeId,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    stage,
    profileId: profile.profileId,
    profileDigest: digestParticleCompatibilityProfile(profile),
    certifiedSubjectHash: `0x${'1'.repeat(64)}`,
    canaryProductId: '1',
    canaryMaxBaseUnits: '1',
    boundAt: '2026-07-18T10:01:00.000Z',
  });
  const { applicationReleaseId: profileScopeId, ...binding } = releaseBinding;
  return {
    profile,
    binding: { ...binding, profileScopeId },
  };
}

function loader(
  transform: (
    input: LoadIndexerParticleProfileInput,
  ) => LoadedIndexerParticleProfile | undefined = loadedProfile,
): IndexerParticleProfileLoader {
  return vi.fn(async (input) => transform(input));
}

function providerOperation(id: ProviderOperationId): ProviderOperation {
  return ProviderOperationSchema.parse({
    id,
    status: 'succeeded',
    submissionPossible: false,
    updatedAt: '2026-07-18T10:02:00.000Z',
    evidence: {
      adapter: 'particle-universal-account',
      packageVersion: '2.0.3',
      schemaVersion: 1,
      environment: 'demo-mainnet',
      evidenceDigest: `0x${'2'.repeat(64)}`,
      provenance: 'recorded_live',
      observedAt: '2026-07-18T10:02:00.000Z',
    },
  });
}

function operationsPort(): UniversalOperationPort {
  return {
    getAccount: vi.fn(),
    getUnifiedBalance: vi.fn(),
    getDelegation: vi.fn(),
    prepareDelegation: vi.fn(),
    prepareOperation: vi.fn(),
    validateOperation: vi.fn(),
    submitValidated: vi.fn(),
    getOperation: vi.fn(async (id: ProviderOperationId) => providerOperation(id)),
  };
}

describe('production indexer composition', () => {
  it('loads one stable compatibility profile and creates independent preferred RPC legs', async () => {
    const chain = {} as ArbitrumReadPort;
    const factory = vi.fn((_: Parameters<IndexerChainFactory>[0]) => chain);
    const profileLoader = loader();
    const operations = operationsPort();
    const operationsFactory: IndexerParticleOperationsFactory = vi.fn(() => operations);
    const dependencies = await createProductionIndexerDependencies(
      environment(),
      factory,
      profileLoader,
      operationsFactory,
    );

    expect(dependencies).toMatchObject({
      primaryChain: chain,
      fallbackChain: chain,
      reconciliation: { redisUrl: 'rediss://default:secret@redis.example:6380' },
      particleProfile: {
        profileScopeId: compatibilityScopeId(),
        profileId: 'indexer-recorded-live-canary_ready-v1',
        stage: 'canary_ready',
      },
    });
    expect(profileLoader).toHaveBeenCalledWith({
      databaseUrl:
        'postgresql://opentab_indexer:secret@db.example:5432/opentab?sslmode=verify-full',
      environment: 'demo-mainnet',
      profileScopeId: compatibilityScopeId(),
      chainId: ARBITRUM_ONE_CHAIN_ID,
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      primaryRpcUrl: 'https://rpc-primary.example',
      fallbackRpcUrl: 'https://rpc-fallback.example',
      expectedDelegationImplementation: address('4'),
      deploymentBlock: 1234n,
      maxLogRange: 250n,
      requestTimeoutMs: 9000,
    });
    expect(factory.mock.calls[1]?.[0]).toMatchObject({
      primaryRpcUrl: 'https://rpc-fallback.example',
      fallbackRpcUrl: 'https://rpc-primary.example',
    });
    const operationId = ProviderOperationIdSchema.parse('particle-operation-1');
    await expect(
      dependencies.reconciliation?.operationsForOwner(address('9')).getOperation(operationId),
    ).resolves.toMatchObject({ id: operationId, status: 'succeeded' });
    expect(profileLoader).toHaveBeenCalledTimes(1);
    expect(operationsFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAddress: address('9'),
        expectedImplementationAddress: address('4'),
      }),
    );
  });

  it('fails closed when the enabled executable has no live RPC or database', async () => {
    const env = environment();
    delete env.DATABASE_URL_INDEXER;
    await expect(createProductionIndexerDependencies(env, vi.fn(), loader())).rejects.toThrow(
      /PostgreSQL/,
    );
  });

  it('fails closed for a compatibility-scope-mismatched profile', async () => {
    await expect(
      createProductionIndexerDependencies(
        environment(),
        vi.fn(),
        loader((input) => ({
          ...loadedProfile(input),
          binding: {
            ...loadedProfile(input).binding,
            profileScopeId: 'c'.repeat(40),
          },
        })),
      ),
    ).rejects.toThrow(/does not match this compatibility scope/);
  });

  it('discovers a canary-ready profile lazily without a Railway restart', async () => {
    let reads = 0;
    const profileLoader = loader((input) => {
      reads += 1;
      return reads === 1 ? undefined : loadedProfile(input, 'canary_ready');
    });
    const operations = operationsPort();
    const operationsFactory: IndexerParticleOperationsFactory = vi.fn(() => operations);
    const dependencies = await createProductionIndexerDependencies(
      environment(),
      vi.fn(() => ({}) as ArbitrumReadPort),
      profileLoader,
      operationsFactory,
    );

    expect(dependencies.particleProfile).toBeUndefined();
    expect(dependencies.reconciliation).toBeDefined();
    const operationId = ProviderOperationIdSchema.parse('particle-operation-after-bootstrap');
    await expect(
      dependencies.reconciliation?.operationsForOwner(address('9')).getOperation(operationId),
    ).resolves.toMatchObject({ id: operationId, status: 'succeeded' });
    expect(profileLoader).toHaveBeenCalledTimes(2);
    expect(operationsFactory).toHaveBeenCalledTimes(1);
  });

  it('keeps reconciliation fail-closed while the profile is missing or bootstrap-only', async () => {
    const operationId = ProviderOperationIdSchema.parse('particle-operation-blocked');
    for (const profileLoader of [
      loader(() => undefined),
      loader((input) => loadedProfile(input, 'bootstrap')),
    ]) {
      const dependencies = await createProductionIndexerDependencies(
        environment(),
        vi.fn(() => ({}) as ArbitrumReadPort),
        profileLoader,
        vi.fn(() => operationsPort()),
      );
      expect(dependencies.reconciliation).toBeDefined();
      await expect(
        dependencies.reconciliation?.operationsForOwner(address('9')).getOperation(operationId),
      ).rejects.toThrow(/canary-ready or certified/);
    }
  });

  it('allows a bootstrap profile only while Particle reconciliation is disabled', async () => {
    const dependencies = await createProductionIndexerDependencies(
      { ...environment(), INDEXER_RECONCILIATION_ENABLED: 'false' },
      vi.fn(() => ({}) as ArbitrumReadPort),
      loader((input) => loadedProfile(input, 'bootstrap')),
    );
    expect(dependencies.reconciliation).toBeUndefined();
    expect(dependencies.particleProfile).toMatchObject({ stage: 'bootstrap' });
  });

  it('accepts production without any web authentication or session secrets', async () => {
    const env = {
      ...environment(),
      APP_ENV: 'production',
      NEXT_PUBLIC_APP_ENV: 'production',
      DATABASE_URL_INDEXER:
        'postgresql://indexer:secret@db.example:5432/opentab?sslmode=verify-full',
      REDIS_URL: 'redis://default:test-password@redis.railway.internal:6379',
      INDEXER_DEPLOYMENT_BLOCK: '1234',
    };
    await expect(
      createProductionIndexerDependencies(
        env,
        vi.fn(() => ({}) as ArbitrumReadPort),
        loader(),
      ),
    ).resolves.toBeDefined();
  });
});
