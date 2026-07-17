import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  type ArbitrumReadPort,
  AttachSubmissionUseCase,
  CreateCheckoutSessionUseCase,
  CreateMerchantUseCase,
  CreatePaymentAttemptUseCase,
  CreateProductUseCase,
  CreateRefundUseCase,
  CreateSplitUseCase,
  CreateWithdrawalUseCase,
  ExchangeSessionUseCase,
  type FeatureFlagPort,
  LogoutSessionUseCase,
  type MagicIdentityVerifierPort,
  type OrderIntentSignerPort,
  type PublicBrowserConfig,
  RecordPreparedAttemptUseCase,
  RefreshSessionUseCase,
  RequestBootstrapGrantUseCase,
  type SponsorTransferPort,
  StartSubmissionUseCase,
  type UniversalOperationPort,
} from '@opentab/application';
import {
  deriveServerFeatureCapabilities,
  parseServerEnvironment,
  type ServerEnvironment,
} from '@opentab/config';
import {
  assertRuntimeDatabasePrivileges,
  checkDatabaseHealth,
  createDatabase,
  createRedis,
  DrizzleMerchantRepository,
  DrizzleProductRepository,
  DrizzleUserRepository,
  hashOpaqueSecret,
  opaqueId,
  PostgresBackendApiQueryStore,
  PostgresBackendApiStore,
  PostgresIdempotencyRepository,
  PostgresJudgeEvidenceManager,
  PostgresSessionService,
  PostgresSplitCapabilityStore,
  PostgresSponsorGrantStore,
  PostgresUnitOfWork,
  PostgresWorkflowStore,
  RedisAuthContinuationService,
  RedisDistributedLock,
  RedisRateLimit,
  randomSecret,
} from '@opentab/db';
import {
  type AwsKmsClientLike,
  createAwsKmsOrderIntentSigner,
  createAwsKmsSplitIntentSigner,
  createAwsKmsSplitRevocationSender,
  createAwsKmsSponsorTransferAdapter,
  createMagicAdminIdentityVerifier,
  createParticleUniversalAccountAdapter,
  createPrivateKeyIntentSigners,
  createPrivateKeyOrderIntentSigner,
  createPrivateKeySponsorTransferAdapter,
  createTurnstileChallengeVerifier,
  createVercelOidcAwsKmsClient,
  createViemArbitrumReadAdapter,
} from '@opentab/integrations/server';
import { createOpenTabLogger } from '@opentab/observability';
import {
  AppError,
  Bytes32Schema,
  type CurrentUser,
  digestLiveAcceptanceDeploymentConfig,
  digestUnknown,
  EvidenceDigestSchema,
  EvmAddressSchema,
  type OrderIntent,
  type SplitReimbursementIntent,
  TransactionHashSchema,
} from '@opentab/shared';
import type { DeterministicBackendParts } from './deterministic-composition.js';
import { LiveBackendApiCommands } from './live-commands.js';
import { LiveBackendApiResourceQueries } from './live-resource-queries.js';
import { type BackendApiRegistry, installBackendApiRegistry } from './registry.js';

function requiredSecret(
  value: string | undefined,
  name: string,
  deterministicParts: DeterministicBackendParts | undefined,
  localLabel: keyof DeterministicBackendParts['secrets'],
): string {
  if (value !== undefined) return value;
  const deterministicValue = deterministicParts?.secrets[localLabel];
  if (deterministicValue !== undefined) return deterministicValue;
  throw new AppError('CONFIGURATION_INVALID', `${name} is required by the backend API.`);
}

function requireRuntimeValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new AppError('CONFIGURATION_INVALID', `${name} is required by the backend API.`);
  }
  return value;
}

type EnabledParticleBrowserConfig = Extract<
  PublicBrowserConfig['particle'],
  { readonly enabled: true }
>;

export function deriveApplicationSecret(
  root: string | undefined,
  purpose: string,
): string | undefined {
  if (root === undefined) return undefined;
  return createHmac('sha256', root).update(`opentab:${purpose}:v1`).digest('hex');
}

function unavailableArbitrumChain(): ArbitrumReadPort {
  const unavailable = async (): Promise<never> => {
    throw new AppError(
      'FEATURE_DISABLED',
      'Arbitrum reads are disabled until Particle is enabled.',
    );
  };
  return {
    getLatestBlock: unavailable,
    getBlock: unavailable,
    getLogs: unavailable,
    getNativeBalance: unavailable,
    getDelegationCode: unavailable,
    getTransactionReceipt: unavailable,
    findOrderEvent: unavailable,
    readProduct: unavailable,
  };
}

const ExactGitReleaseIdPattern = /^[0-9a-f]{40}$/;

/** Resolve the exact deployed Git commit without host-specific truncation or ambiguity. */
export function resolveApplicationReleaseId(
  env: Readonly<Record<string, string | undefined>>,
  deterministic: boolean,
): string {
  if (deterministic) return 'local-deterministic';

  const portableReleaseId = env.APPLICATION_RELEASE_ID;
  const vercelReleaseId = env.VERCEL_GIT_COMMIT_SHA;
  if (portableReleaseId !== undefined && !ExactGitReleaseIdPattern.test(portableReleaseId)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'APPLICATION_RELEASE_ID must be the exact lowercase 40-hex deployed Git commit.',
    );
  }
  if (vercelReleaseId !== undefined && !ExactGitReleaseIdPattern.test(vercelReleaseId)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'VERCEL_GIT_COMMIT_SHA must be the exact lowercase 40-hex deployed Git commit.',
    );
  }
  if (
    portableReleaseId !== undefined &&
    vercelReleaseId !== undefined &&
    portableReleaseId !== vercelReleaseId
  ) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'APPLICATION_RELEASE_ID and VERCEL_GIT_COMMIT_SHA must identify the same deployed commit.',
    );
  }

  const releaseId = portableReleaseId ?? vercelReleaseId;
  if (releaseId === undefined) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'APPLICATION_RELEASE_ID is required outside deterministic mode.',
    );
  }
  return releaseId;
}

function createLiveArbitrumChain(
  config: ServerEnvironment,
  particle: EnabledParticleBrowserConfig,
): ArbitrumReadPort {
  const splitAddress = /^0x0{40}$/i.test(config.NEXT_PUBLIC_SPLIT_ADDRESS)
    ? undefined
    : config.NEXT_PUBLIC_SPLIT_ADDRESS;
  return createViemArbitrumReadAdapter({
    environment: config.APP_ENV,
    primaryRpcUrl: requireRuntimeValue(config.ARBITRUM_RPC_URL, 'ARBITRUM_RPC_URL'),
    fallbackRpcUrl: requireRuntimeValue(
      config.ARBITRUM_FALLBACK_RPC_URL,
      'ARBITRUM_FALLBACK_RPC_URL',
    ),
    checkoutAddress: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: config.NEXT_PUBLIC_PASS_ADDRESS,
    ...(splitAddress === undefined ? {} : { splitAddress }),
    expectedDelegationImplementation: EvmAddressSchema.parse(
      particle.expectedImplementationAddress,
    ),
    deploymentBlock: config.INDEXER_DEPLOYMENT_BLOCK,
    maxLogRange: BigInt(Math.min(config.REORG_WINDOW_BLOCKS, 10_000)),
    maxOrderLookupBlocks: BigInt(Math.max(config.REORG_WINDOW_BLOCKS, 100_000)),
    requestTimeoutMs: 12_000,
    resolveProductOnchainId: () => {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Opaque product IDs require a persisted onchain product mapping.',
      );
    },
  });
}

/** Accept only the platform-authenticated single-hop client address. */
export function trustedNetworkSubject(
  request: Request,
  environment: ServerEnvironment['APP_ENV'],
): string {
  const local = environment === 'local' || environment === 'test';
  const value =
    request.headers.get('x-vercel-forwarded-for') ??
    (local ? request.headers.get('x-forwarded-for') : null) ??
    (local ? '127.0.0.1' : null);
  if (
    value === null ||
    value.length < 1 ||
    value.length > 64 ||
    value !== value.trim() ||
    value.includes(',') ||
    isIP(value) === 0
  ) {
    throw new AppError('VALIDATION_FAILED', 'The trusted client network address is invalid.');
  }
  return value.toLowerCase();
}

export async function assertPlatformFeeParity(
  chain: ArbitrumReadPort,
  configuredFeeBps: number,
): Promise<void> {
  if (!Number.isSafeInteger(configuredFeeBps) || configuredFeeBps < 0 || configuredFeeBps > 500) {
    throw new AppError('CONFIGURATION_INVALID', 'The configured platform fee is invalid.');
  }
  const readFee = chain.readPlatformFeeBps;
  if (readFee === undefined) {
    throw new AppError('CONFIGURATION_INVALID', 'Checkout fee verification is unavailable.');
  }
  const onchainFeeBps = await readFee.call(chain);
  if (onchainFeeBps !== configuredFeeBps.toString()) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The configured platform fee does not match the checkout contract.',
    );
  }
}

export function judgeEvidenceProvenance(
  environment: ServerEnvironment['APP_ENV'],
  deterministic: boolean,
): 'deterministic' | 'staging' | 'recorded_live' {
  if (deterministic) return 'deterministic';
  if (['local', 'test', 'preview', 'staging'].includes(environment)) return 'staging';
  return 'recorded_live';
}

function publicConfig(
  config: ServerEnvironment,
  deterministicParts: DeterministicBackendParts | undefined,
  applicationReleaseId: string,
): PublicBrowserConfig {
  const deterministic = deterministicParts !== undefined;
  const capabilities = deriveServerFeatureCapabilities(config);
  if (!deterministic && !config.PARTICLE_LIVE_ENABLED) {
    return {
      applicationReleaseId,
      magic: {
        publishableKey: config.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY,
        rpcUrl: config.NEXT_PUBLIC_ARBITRUM_PUBLIC_RPC_URL,
      },
      challenge: {
        ...(config.NEXT_PUBLIC_TURNSTILE_SITE_KEY === undefined
          ? {}
          : { turnstileSiteKey: config.NEXT_PUBLIC_TURNSTILE_SITE_KEY }),
      },
      particle: { enabled: false },
      environment: config.APP_ENV,
      media: {
        allowedOrigins: [
          new URL(config.NEXT_PUBLIC_APP_ORIGIN).origin,
          ...config.PRODUCT_MEDIA_ALLOWED_ORIGINS.filter(
            (origin) => origin !== new URL(config.NEXT_PUBLIC_APP_ORIGIN).origin,
          ),
        ],
      },
      features: {
        checkout: capabilities.checkoutSubmission,
        bootstrapGas: config.BOOTSTRAP_SPONSOR_ENABLED,
        splits: config.SPLITS_ENABLED,
        loyalty: config.MERCHANT_MUTATIONS_ENABLED,
        judgeMode: config.JUDGE_MODE_ENABLED,
      },
    };
  }
  const requiredLive = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        `${name} is required by the public client config.`,
      );
    }
    return value;
  };
  const expectedImplementationAddress =
    deterministicParts !== undefined
      ? deterministicParts.implementationAddress
      : requiredLive(
          config.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
          'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
        );
  const expectedImplementationCodeHash =
    deterministicParts !== undefined
      ? deterministicParts.implementationCodeHash
      : requiredLive(
          config.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH,
          'PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH',
        );
  const particleFixtureSetDigest = digestUnknown({
    deployments:
      deterministicParts?.fixtureDigest ??
      requiredLive(
        config.PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST,
        'PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST',
      ),
    authorization:
      deterministicParts?.fixtureDigest ??
      requiredLive(config.PARTICLE_AUTH_FIXTURE_DIGEST, 'PARTICLE_AUTH_FIXTURE_DIGEST'),
    submission:
      deterministicParts?.fixtureDigest ??
      requiredLive(config.PARTICLE_SUBMISSION_FIXTURE_DIGEST, 'PARTICLE_SUBMISSION_FIXTURE_DIGEST'),
    status:
      deterministicParts?.fixtureDigest ??
      requiredLive(config.PARTICLE_STATUS_FIXTURE_DIGEST, 'PARTICLE_STATUS_FIXTURE_DIGEST'),
  });
  const liveAcceptanceEligible =
    !deterministic &&
    ['demo-mainnet', 'production'].includes(config.APP_ENV) &&
    /^[0-9a-fA-F]{40}$/.test(applicationReleaseId);
  const liveAcceptanceConfigDigest = liveAcceptanceEligible
    ? digestLiveAcceptanceDeploymentConfig({
        domain: 'opentab/live-acceptance-deployment-config',
        releaseId: applicationReleaseId,
        environment: config.APP_ENV,
        chainId: '42161',
        checkoutAddress: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
        passAddress: config.NEXT_PUBLIC_PASS_ADDRESS,
        tokenAddress: config.NEXT_PUBLIC_USDC_ADDRESS,
        expectedDelegationImplementation: expectedImplementationAddress,
        expectedDelegationCodeHash: expectedImplementationCodeHash,
        particleSdkVersion: '2.0.3',
        particleResponseProfileId: requiredLive(
          config.PARTICLE_RESPONSE_PROFILE_ID,
          'PARTICLE_RESPONSE_PROFILE_ID',
        ),
        particleFixtureSetDigest,
        particleSourceCallProfilesDigest: digestUnknown(config.PARTICLE_SOURCE_CALL_PROFILES_JSON),
        confirmationDepth: config.CONFIRMATION_DEPTH.toString(),
        maximumSlippageBps: config.PARTICLE_MAX_SLIPPAGE_BPS.toString(),
        allowedSourceChainIds: config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS,
        allowedSourceAssets: config.PARTICLE_ALLOWED_SOURCE_ASSETS,
      })
    : undefined;
  return {
    applicationReleaseId,
    ...(liveAcceptanceConfigDigest === undefined ? {} : { liveAcceptanceConfigDigest }),
    magic: {
      publishableKey: config.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY,
      rpcUrl: config.NEXT_PUBLIC_ARBITRUM_PUBLIC_RPC_URL,
    },
    challenge: {
      ...(config.NEXT_PUBLIC_TURNSTILE_SITE_KEY === undefined
        ? {}
        : { turnstileSiteKey: config.NEXT_PUBLIC_TURNSTILE_SITE_KEY }),
    },
    particle: {
      enabled: true,
      projectId: config.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: config.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: config.NEXT_PUBLIC_PARTICLE_APP_UUID,
      expectedImplementationAddress,
      expectedImplementationCodeHash,
      slippageBps: config.PARTICLE_MAX_SLIPPAGE_BPS,
      maxFeeUsdMicros: config.PARTICLE_MAX_FEE_USD_MICROS.toString(),
      allowedSourceChainIds: config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS,
      allowedSourceAssets: config.PARTICLE_ALLOWED_SOURCE_ASSETS,
      allowedSourceTokens:
        deterministicParts?.allowedSourceTokens ?? config.PARTICLE_ALLOWED_SOURCE_TOKENS,
      sourceCallProfiles: deterministic ? [] : config.PARTICLE_SOURCE_CALL_PROFILES_JSON,
      responseProfile: {
        profileId:
          deterministicParts !== undefined
            ? deterministicParts.responseProfileId
            : requiredLive(config.PARTICLE_RESPONSE_PROFILE_ID, 'PARTICLE_RESPONSE_PROFILE_ID'),
        provenance: deterministic ? 'deterministic' : 'recorded_live',
        deploymentsFixtureDigest:
          deterministicParts !== undefined
            ? deterministicParts.fixtureDigest
            : requiredLive(
                config.PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST,
                'PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST',
              ),
        authFixtureDigest:
          deterministicParts !== undefined
            ? deterministicParts.fixtureDigest
            : requiredLive(config.PARTICLE_AUTH_FIXTURE_DIGEST, 'PARTICLE_AUTH_FIXTURE_DIGEST'),
        submissionFixtureDigest:
          deterministicParts !== undefined
            ? deterministicParts.fixtureDigest
            : requiredLive(
                config.PARTICLE_SUBMISSION_FIXTURE_DIGEST,
                'PARTICLE_SUBMISSION_FIXTURE_DIGEST',
              ),
        statusFixtureDigest:
          deterministicParts !== undefined
            ? deterministicParts.fixtureDigest
            : requiredLive(config.PARTICLE_STATUS_FIXTURE_DIGEST, 'PARTICLE_STATUS_FIXTURE_DIGEST'),
        magicAuthorizationNonceOffset:
          deterministicParts !== undefined
            ? deterministicParts.magicAuthorizationNonceOffset
            : requiredLive(
                config.PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET,
                'PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET',
              ),
        delegationPlanTtlSeconds:
          deterministicParts !== undefined
            ? deterministicParts.delegationPlanTtlSeconds
            : requiredLive(
                config.PARTICLE_DELEGATION_PLAN_TTL_SECONDS,
                'PARTICLE_DELEGATION_PLAN_TTL_SECONDS',
              ),
      },
    },
    environment: config.APP_ENV,
    media: {
      allowedOrigins: [
        new URL(config.NEXT_PUBLIC_APP_ORIGIN).origin,
        ...config.PRODUCT_MEDIA_ALLOWED_ORIGINS.filter(
          (origin) => origin !== new URL(config.NEXT_PUBLIC_APP_ORIGIN).origin,
        ),
      ],
    },
    features: {
      checkout: capabilities.checkoutSubmission,
      bootstrapGas: config.BOOTSTRAP_SPONSOR_ENABLED,
      splits: config.SPLITS_ENABLED,
      loyalty: config.MERCHANT_MUTATIONS_ENABLED,
      judgeMode: config.JUDGE_MODE_ENABLED,
    },
  };
}

function operationsFactory(
  config: ServerEnvironment,
  particle: EnabledParticleBrowserConfig,
): (actor: CurrentUser) => UniversalOperationPort {
  return (actor) =>
    createParticleUniversalAccountAdapter({
      projectId: particle.projectId,
      projectClientKey: particle.projectClientKey,
      projectAppUuid: particle.projectAppUuid,
      ownerAddress: actor.walletAddress,
      expectedImplementationAddress: EvmAddressSchema.parse(particle.expectedImplementationAddress),
      expectedImplementationCodeHash: particle.expectedImplementationCodeHash as `0x${string}`,
      environment: config.APP_ENV,
      slippageBps: particle.slippageBps,
      maxFeeUsdMicros: BigInt(particle.maxFeeUsdMicros),
      allowedSourceChainIds: particle.allowedSourceChainIds,
      allowedSourceAssets: particle.allowedSourceAssets,
      sourceCallProfiles: particle.sourceCallProfiles.map((profile) => ({
        profileId: profile.profileId,
        chainId: profile.chainId,
        asset: profile.asset,
        tokenAddress: EvmAddressSchema.parse(profile.tokenAddress),
        sourceAmount: profile.sourceAmount,
        fixtureDigest: Bytes32Schema.parse(profile.fixtureDigest),
        calls: profile.calls.map((call) => ({
          uaType: call.uaType,
          to: EvmAddressSchema.parse(call.to),
          data: call.data as `0x${string}`,
          valueWei: call.valueWei,
        })),
      })),
      ...(config.PARTICLE_ALLOWED_SOURCE_TOKENS.length === 0
        ? {}
        : {
            allowedSourceTokens: config.PARTICLE_ALLOWED_SOURCE_TOKENS.map((token) => ({
              chainId: token.chainId,
              asset: token.asset,
              address: token.address,
            })),
          }),
      responseProfile: {
        ...particle.responseProfile,
        deploymentsFixtureDigest: particle.responseProfile
          .deploymentsFixtureDigest as `0x${string}`,
        authFixtureDigest: particle.responseProfile.authFixtureDigest as `0x${string}`,
        submissionFixtureDigest: particle.responseProfile.submissionFixtureDigest as `0x${string}`,
        statusFixtureDigest: particle.responseProfile.statusFixtureDigest as `0x${string}`,
      },
      ...(config.PARTICLE_RPC_URL === undefined ? {} : { rpcUrl: config.PARTICLE_RPC_URL }),
    });
}

export function featureFlags(config: ServerEnvironment): FeatureFlagPort {
  const capabilities = deriveServerFeatureCapabilities(config);
  const flags: Readonly<Record<string, boolean>> = {
    'particle-reads': capabilities.particleReads,
    'checkout-preview': capabilities.checkoutPreview,
    'checkout-submit': capabilities.checkoutSubmission,
    'merchant-mutations': capabilities.merchantMutations,
    refunds: capabilities.refunds,
    withdrawals: capabilities.withdrawals,
    splits: capabilities.splits,
    'bootstrap-sponsor': capabilities.bootstrapSponsor,
    'judge-mode': capabilities.judgeMode,
  };
  return {
    async enabled(flag) {
      return flags[flag] ?? false;
    },
  };
}

function disabledSigner(): OrderIntentSignerPort<OrderIntent> {
  return {
    async signIntent() {
      throw new AppError('FEATURE_DISABLED', 'Payment intent signing is disabled.');
    },
  };
}

async function managedKmsClient(
  config: ServerEnvironment,
  deterministicParts: DeterministicBackendParts | undefined,
): Promise<AwsKmsClientLike | undefined> {
  if (deterministicParts !== undefined) return undefined;
  const required =
    (config.PAYMENTS_ENABLED && config.ORDER_SIGNER_MODE === 'kms') ||
    (config.SPLITS_ENABLED && config.SPLIT_SIGNER_MODE === 'kms') ||
    (config.BOOTSTRAP_SPONSOR_ENABLED && config.SPONSOR_SIGNER_MODE === 'kms');
  if (!required) return undefined;
  return createVercelOidcAwsKmsClient({
    region: requireRuntimeValue(config.AWS_KMS_REGION, 'AWS_KMS_REGION'),
    roleArn: requireRuntimeValue(config.VERCEL_AWS_ROLE_ARN, 'VERCEL_AWS_ROLE_ARN'),
  });
}

async function orderSigner(
  config: ServerEnvironment,
  deterministicParts: DeterministicBackendParts | undefined,
  kmsClient: AwsKmsClientLike | undefined,
) {
  if (deterministicParts !== undefined) {
    return {
      signer: deterministicParts.orderSigner,
      keyId: deterministicParts.orderSignerKeyId,
    };
  }
  if (!config.PAYMENTS_ENABLED) return { signer: disabledSigner(), keyId: 'disabled' };
  if (config.ORDER_SIGNER_MODE === 'private-key' && config.ORDER_SIGNER_PRIVATE_KEY !== undefined) {
    const keyId = config.ORDER_SIGNER_KMS_KEY_ID ?? 'local-order-intent-v1';
    const composed = createPrivateKeyOrderIntentSigner({
      environment: config.APP_ENV,
      orderPrivateKey: config.ORDER_SIGNER_PRIVATE_KEY as `0x${string}`,
      order: { signerKeyId: keyId, verifyingContract: config.NEXT_PUBLIC_CHECKOUT_ADDRESS },
    });
    if (
      config.ORDER_SIGNER_ADDRESS !== undefined &&
      composed.orderSignerAddress.toLowerCase() !== config.ORDER_SIGNER_ADDRESS.toLowerCase()
    ) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'The order signer address does not match configuration.',
      );
    }
    return { signer: composed.order, keyId };
  }
  if (config.ORDER_SIGNER_MODE === 'kms') {
    const composed = await createAwsKmsOrderIntentSigner({
      environment: config.APP_ENV,
      region: requireRuntimeValue(config.AWS_KMS_REGION, 'AWS_KMS_REGION'),
      keyId: requireRuntimeValue(config.ORDER_SIGNER_KMS_KEY_ID, 'ORDER_SIGNER_KMS_KEY_ID'),
      expectedSignerAddress: requireRuntimeValue(
        config.ORDER_SIGNER_ADDRESS,
        'ORDER_SIGNER_ADDRESS',
      ),
      verifyingContract: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
      client: requireRuntimeValue(kmsClient, 'Vercel OIDC AWS KMS client'),
    });
    return { signer: composed.order, keyId: composed.signerKeyId };
  }
  throw new AppError(
    'CONFIGURATION_INVALID',
    'Managed/KMS order signer composition is not configured for this runtime.',
  );
}

async function splitSigner(
  config: ServerEnvironment,
  deterministicParts: DeterministicBackendParts | undefined,
  kmsClient: AwsKmsClientLike | undefined,
): Promise<
  | {
      signer: OrderIntentSignerPort<SplitReimbursementIntent>;
      keyId: string;
      address: ReturnType<typeof EvmAddressSchema.parse>;
    }
  | undefined
> {
  if (deterministicParts !== undefined) {
    return {
      signer: deterministicParts.splitSigner,
      keyId: deterministicParts.splitSignerKeyId,
      address: deterministicParts.splitSignerAddress,
    };
  }
  if (!config.SPLITS_ENABLED) return undefined;
  if (
    config.SPLIT_SIGNER_MODE === 'private-key' &&
    config.SPLIT_SIGNER_PRIVATE_KEY !== undefined &&
    config.ORDER_SIGNER_PRIVATE_KEY !== undefined
  ) {
    const orderKeyId = config.ORDER_SIGNER_KMS_KEY_ID ?? 'local-order-intent-v1';
    const splitKeyId = config.SPLIT_SIGNER_KEY_ID ?? 'local-split-intent-v1';
    const composed = createPrivateKeyIntentSigners({
      environment: config.APP_ENV,
      orderPrivateKey: config.ORDER_SIGNER_PRIVATE_KEY as `0x${string}`,
      splitPrivateKey: config.SPLIT_SIGNER_PRIVATE_KEY as `0x${string}`,
      order: {
        signerKeyId: orderKeyId,
        verifyingContract: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
      },
      split: {
        signerKeyId: splitKeyId,
        verifyingContract: config.NEXT_PUBLIC_SPLIT_ADDRESS,
      },
    });
    if (
      config.SPLIT_SIGNER_EXPECTED_ADDRESS !== undefined &&
      composed.splitSignerAddress.toLowerCase() !==
        config.SPLIT_SIGNER_EXPECTED_ADDRESS.toLowerCase()
    ) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'The split signer address does not match configuration.',
      );
    }
    return { signer: composed.split, keyId: splitKeyId, address: composed.splitSignerAddress };
  }
  if (config.SPLIT_SIGNER_MODE === 'kms') {
    const composed = await createAwsKmsSplitIntentSigner({
      environment: config.APP_ENV,
      region: requireRuntimeValue(config.AWS_KMS_REGION, 'AWS_KMS_REGION'),
      keyId: requireRuntimeValue(config.SPLIT_SIGNER_KEY_ID, 'SPLIT_SIGNER_KEY_ID'),
      expectedSignerAddress: requireRuntimeValue(
        config.SPLIT_SIGNER_EXPECTED_ADDRESS,
        'SPLIT_SIGNER_EXPECTED_ADDRESS',
      ),
      verifyingContract: config.NEXT_PUBLIC_SPLIT_ADDRESS,
      client: requireRuntimeValue(kmsClient, 'Vercel OIDC AWS KMS client'),
    });
    return {
      signer: composed.split,
      keyId: composed.signerKeyId,
      address: composed.splitSignerAddress,
    };
  }
  throw new AppError(
    'CONFIGURATION_INVALID',
    'Managed/KMS split signer composition is not configured for this runtime.',
  );
}

export async function createBackendApiRegistry(
  env: Record<string, string | undefined>,
): Promise<BackendApiRegistry & { close(): Promise<void> }> {
  const config = parseServerEnvironment(env);
  const featureCapabilities = deriveServerFeatureCapabilities(config);
  const deterministic = config.PROVIDER_MODE === 'deterministic';
  const applicationReleaseId = resolveApplicationReleaseId(env, deterministic);
  const deterministicParts = deterministic
    ? await import('./deterministic-composition.js').then(({ createDeterministicBackendParts }) =>
        createDeterministicBackendParts(config),
      )
    : undefined;
  const databaseUrl = config.DATABASE_URL ?? deterministicParts?.databaseUrl;
  const redisUrl = config.REDIS_URL ?? deterministicParts?.redisUrl;
  if (databaseUrl === undefined || redisUrl === undefined) {
    throw new AppError('CONFIGURATION_INVALID', 'The backend API requires PostgreSQL and Redis.');
  }
  const secretRoot = config.OPENTAB_SECRET_ROOT;
  const sessionPepper = requiredSecret(
    config.SESSION_HASH_PEPPER ?? deriveApplicationSecret(secretRoot, 'session-token-hash'),
    'SESSION_HASH_PEPPER',
    deterministicParts,
    'session',
  );
  const csrfPepper = requiredSecret(
    config.CSRF_SECRET ?? deriveApplicationSecret(secretRoot, 'csrf-token-hash'),
    'CSRF_SECRET',
    deterministicParts,
    'csrf',
  );
  const capabilityPepper = requiredSecret(
    config.CAPABILITY_TOKEN_PEPPER ?? deriveApplicationSecret(secretRoot, 'capability-token-hash'),
    'CAPABILITY_TOKEN_PEPPER',
    deterministicParts,
    'capability',
  );
  const privacySecret = requiredSecret(
    config.PRIVACY_SUBJECT_HASH_SECRET ??
      deriveApplicationSecret(secretRoot, 'privacy-subject-hash'),
    'PRIVACY_SUBJECT_HASH_SECRET',
    deterministicParts,
    'privacy',
  );
  const judgeShareTokenSecret = config.JUDGE_MODE_ENABLED
    ? requiredSecret(
        config.JUDGE_SHARE_TOKEN_SECRET,
        'JUDGE_SHARE_TOKEN_SECRET',
        deterministicParts,
        'judge',
      )
    : undefined;
  const continuationPepper = createHmac('sha256', csrfPepper)
    .update('opentab:auth-continuation-pepper:v1')
    .digest('hex');
  const database = createDatabase({
    url: databaseUrl,
    applicationName: 'opentab-web',
    maxConnections: 2,
  });
  const requireLeastPrivilegeRuntime = ['staging', 'demo-mainnet', 'production'].includes(
    config.APP_ENV,
  );
  if (requireLeastPrivilegeRuntime) {
    try {
      await assertRuntimeDatabasePrivileges(database.db);
    } catch (error) {
      await database.close();
      throw error;
    }
  }
  const uow = new PostgresUnitOfWork(database.db);
  const redis = createRedis(redisUrl);
  const managedSignerLocks = new RedisDistributedLock(redis);
  const idempotency = new PostgresIdempotencyRepository(uow);
  const sessions = new PostgresSessionService(uow, {
    sessionHashPepper: sessionPepper,
    csrfHashPepper: csrfPepper,
    maxAgeSeconds: config.SESSION_MAX_AGE_SECONDS,
  });
  const authContinuations = new RedisAuthContinuationService(redis, continuationPepper);
  const rateLimits = new RedisRateLimit(redis);
  const apiLogger = createOpenTabLogger({
    service: 'opentab-web-api',
    environment: config.APP_ENV,
    level: config.LOG_LEVEL,
  });
  const users = new DrizzleUserRepository(uow);
  const merchants = new DrizzleMerchantRepository(uow);
  const products = new DrizzleProductRepository(uow);
  const workflow = new PostgresWorkflowStore(uow);
  const capabilities = new PostgresSplitCapabilityStore(uow, capabilityPepper);
  const browser = publicConfig(config, deterministicParts, applicationReleaseId);
  const queries = new PostgresBackendApiQueryStore(
    uow,
    capabilityPepper,
    judgeShareTokenSecret,
    config.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
    browser.liveAcceptanceConfigDigest,
  );
  const backend = new PostgresBackendApiStore(uow, capabilityPepper);
  await backend.recordConfigurationSnapshot({
    environment: config.APP_ENV,
    applicationVersion: applicationReleaseId,
    activatedAt: new Date(),
    safeConfig: {
      providerMode: config.PROVIDER_MODE,
      paymentsEnabled: config.PAYMENTS_ENABLED,
      particleLiveEnabled: config.PARTICLE_LIVE_ENABLED,
      sponsorEnabled: config.BOOTSTRAP_SPONSOR_ENABLED,
      refundsEnabled: config.REFUNDS_ENABLED,
      withdrawalsEnabled: config.WITHDRAWALS_ENABLED,
      splitsEnabled: config.SPLITS_ENABLED,
      judgeModeEnabled: config.JUDGE_MODE_ENABLED,
      checkoutAddress: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
      passAddress: config.NEXT_PUBLIC_PASS_ADDRESS,
      splitAddress: config.NEXT_PUBLIC_SPLIT_ADDRESS,
      confirmationDepth: config.CONFIRMATION_DEPTH.toString(),
    },
  });
  const operationsForActor =
    deterministicParts?.operationsForActor ??
    (browser.particle.enabled ? operationsFactory(config, browser.particle) : undefined);
  const kmsClient = await managedKmsClient(config, deterministicParts);
  const signer = await orderSigner(config, deterministicParts, kmsClient);
  const split = await splitSigner(config, deterministicParts, kmsClient);
  const splitRevocationSender = !config.SPLITS_ENABLED
    ? undefined
    : deterministicParts !== undefined
      ? {
          submit: async (input: { operation: { bindingDigest: string } }) => ({
            status: 'submitted' as const,
            transactionHash: TransactionHashSchema.parse(input.operation.bindingDigest),
            signerNonce: '0',
          }),
        }
      : config.SPLIT_SIGNER_MODE === 'kms'
        ? await createAwsKmsSplitRevocationSender({
            environment: config.APP_ENV,
            region: requireRuntimeValue(config.AWS_KMS_REGION, 'AWS_KMS_REGION'),
            keyId: requireRuntimeValue(config.SPLIT_SIGNER_KEY_ID, 'SPLIT_SIGNER_KEY_ID'),
            expectedSignerAddress: requireRuntimeValue(
              config.SPLIT_SIGNER_EXPECTED_ADDRESS,
              'SPLIT_SIGNER_EXPECTED_ADDRESS',
            ),
            splitContractAddress: config.NEXT_PUBLIC_SPLIT_ADDRESS,
            primaryRpcUrl: requireRuntimeValue(config.ARBITRUM_RPC_URL, 'ARBITRUM_RPC_URL'),
            fallbackRpcUrl: requireRuntimeValue(
              config.ARBITRUM_FALLBACK_RPC_URL,
              'ARBITRUM_FALLBACK_RPC_URL',
            ),
            maxFeePerGasWei: config.SPLIT_REVOCATION_MAX_FEE_PER_GAS_WEI,
            maxGasLimit: config.SPLIT_REVOCATION_MAX_GAS_LIMIT,
            client: requireRuntimeValue(kmsClient, 'Vercel OIDC AWS KMS client'),
          })
        : undefined;
  const chain =
    deterministicParts?.chain ??
    (browser.particle.enabled
      ? createLiveArbitrumChain(config, browser.particle)
      : unavailableArbitrumChain());
  const platformFeeBps = (config.PLATFORM_FEE_BPS ?? 0).toString();
  if (config.PAYMENTS_ENABLED) {
    await assertPlatformFeeParity(
      chain,
      requireRuntimeValue(config.PLATFORM_FEE_BPS, 'PLATFORM_FEE_BPS'),
    );
  }
  const clock = { now: () => new Date() };
  const judgeEvidence =
    judgeShareTokenSecret === undefined
      ? undefined
      : new PostgresJudgeEvidenceManager(
          uow,
          judgeShareTokenSecret,
          {
            environment: config.APP_ENV,
            checkoutAddress: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
            passAddress: config.NEXT_PUBLIC_PASS_ADDRESS,
            tokenAddress: config.NEXT_PUBLIC_USDC_ADDRESS,
            applicationVersion: applicationReleaseId,
            ...(browser.liveAcceptanceConfigDigest === undefined
              ? {}
              : {
                  deploymentConfigDigest: EvidenceDigestSchema.parse(
                    browser.liveAcceptanceConfigDigest,
                  ),
                }),
            particleSdkVersion: '2.0.3',
            magicSdkVersion: '33.9.0',
            contractsVersion: '1.0.0',
            provenance: judgeEvidenceProvenance(config.APP_ENV, deterministicParts !== undefined),
            ...(config.LIVE_ACCEPTANCE_ATTESTATION_SECRET === undefined
              ? {}
              : {
                  acceptanceAttestationSecret: config.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
                }),
          },
          clock.now,
        );
  const random = {
    opaqueId,
    bytes32: () => `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
    secret: randomSecret,
  };
  let verifier: MagicIdentityVerifierPort;
  let expectedAudience: string;
  if (deterministicParts !== undefined) {
    verifier = deterministicParts.verifier;
    expectedAudience = deterministicParts.expectedAudience;
  } else {
    const magicVerifier = await createMagicAdminIdentityVerifier({
      secretApiKey: requireRuntimeValue(config.MAGIC_SECRET_KEY, 'MAGIC_SECRET_KEY'),
      config: { environment: config.APP_ENV },
    });
    verifier = magicVerifier;
    expectedAudience = magicVerifier.audience;
  }

  const allowedSponsorRecipients = config.SPONSOR_ALLOWED_ADDRESSES.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => EvmAddressSchema.parse(entry));
  let sponsorGrants: PostgresSponsorGrantStore | undefined;
  let requestBootstrapGrant: RequestBootstrapGrantUseCase | undefined;
  let challengeVerifier = deterministicParts?.challengeVerifier;
  if (config.BOOTSTRAP_SPONSOR_ENABLED) {
    challengeVerifier = createTurnstileChallengeVerifier({
      secretKey: requireRuntimeValue(config.TURNSTILE_SECRET_KEY, 'TURNSTILE_SECRET_KEY'),
      expectedHostname: new URL(config.NEXT_PUBLIC_APP_ORIGIN).hostname,
      expectedAction: 'opentab-bootstrap',
    });
    let transfer: SponsorTransferPort;
    if (config.SPONSOR_SIGNER_MODE === 'private-key' && config.SPONSOR_PRIVATE_KEY !== undefined) {
      transfer = createPrivateKeySponsorTransferAdapter({
        config: {
          environment: config.APP_ENV,
          maxGrantWei: config.SPONSOR_PER_GRANT_CAP_WEI,
          minimumGrantWei: config.SPONSOR_MIN_GRANT_WEI,
          allowlistOnly: config.BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY,
          allowedRecipients: allowedSponsorRecipients,
          requestTimeoutMs: 12_000,
        },
        privateKey: config.SPONSOR_PRIVATE_KEY as `0x${string}`,
        primaryRpcUrl: requireRuntimeValue(config.ARBITRUM_RPC_URL, 'ARBITRUM_RPC_URL'),
        fallbackRpcUrl: requireRuntimeValue(
          config.ARBITRUM_FALLBACK_RPC_URL,
          'ARBITRUM_FALLBACK_RPC_URL',
        ),
      });
    } else if (config.SPONSOR_SIGNER_MODE === 'kms') {
      transfer = await createAwsKmsSponsorTransferAdapter({
        config: {
          environment: config.APP_ENV,
          maxGrantWei: config.SPONSOR_PER_GRANT_CAP_WEI,
          minimumGrantWei: config.SPONSOR_MIN_GRANT_WEI,
          allowlistOnly: config.BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY,
          allowedRecipients: allowedSponsorRecipients,
          requestTimeoutMs: 12_000,
          maxFeePerGasWei: config.SPONSOR_MAX_FEE_PER_GAS_WEI,
        },
        keyId: requireRuntimeValue(config.SPONSOR_KMS_KEY_ID, 'SPONSOR_KMS_KEY_ID'),
        expectedSignerAddress: requireRuntimeValue(
          config.SPONSOR_SIGNER_ADDRESS,
          'SPONSOR_SIGNER_ADDRESS',
        ),
        region: requireRuntimeValue(config.AWS_KMS_REGION, 'AWS_KMS_REGION'),
        primaryRpcUrl: requireRuntimeValue(config.ARBITRUM_RPC_URL, 'ARBITRUM_RPC_URL'),
        fallbackRpcUrl: requireRuntimeValue(
          config.ARBITRUM_FALLBACK_RPC_URL,
          'ARBITRUM_FALLBACK_RPC_URL',
        ),
        client: requireRuntimeValue(kmsClient, 'Vercel OIDC AWS KMS client'),
      });
    } else {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Managed/KMS sponsor signer composition is not configured for this runtime.',
      );
    }
    sponsorGrants = new PostgresSponsorGrantStore(uow);
    const logger = createOpenTabLogger({
      service: 'opentab-web-sponsor',
      environment: config.APP_ENV,
      level: config.LOG_LEVEL,
    });
    requestBootstrapGrant = new RequestBootstrapGrantUseCase({
      chain,
      transfer,
      grants: sponsorGrants,
      idempotency,
      locks: managedSignerLocks,
      rateLimits,
      flags: featureFlags(config),
      telemetry: {
        event: (name, fields) => logger.info({ event: name, safe: fields }),
        error: (error, fields) => logger.error({ err: error, safe: fields }),
        increment: (metric, labels) => logger.info({ metric, safe: labels ?? {} }),
      },
      clock,
      policy: {
        environment: config.APP_ENV,
        targetWei: config.SPONSOR_TARGET_BALANCE_WEI,
        minimumGrantWei: config.SPONSOR_MIN_GRANT_WEI,
        perGrantCapWei: config.SPONSOR_PER_GRANT_CAP_WEI,
        perAddressDailyCapWei: config.SPONSOR_PER_ADDRESS_DAILY_CAP_WEI,
        perIdentityDailyCapWei: config.SPONSOR_PER_USER_DAILY_CAP_WEI,
        perNetworkDailyCapWei: config.SPONSOR_PER_IP_DAILY_CAP_WEI,
        perDeviceDailyCapWei: config.SPONSOR_PER_DEVICE_DAILY_CAP_WEI,
        globalDailyCapWei: config.SPONSOR_GLOBAL_DAILY_CAP_WEI,
        lowBalanceAlertWei: config.SPONSOR_LOW_BALANCE_ALERT_WEI,
      },
      globalBudgetSubjectHash: hashOpaqueSecret({
        domain: 'sponsor-global-budget',
        pepper: privacySecret,
        value: config.APP_ENV,
      }),
    });
  }

  const createMerchant = new CreateMerchantUseCase({
    users,
    merchants,
    idempotency,
    unitOfWork: uow,
    random,
    clock,
  });
  const createProduct = new CreateProductUseCase({
    users,
    merchants,
    products,
    idempotency,
    unitOfWork: uow,
    random,
    clock,
  });
  const createCheckoutSession = new CreateCheckoutSessionUseCase({
    store: workflow,
    idempotency,
    random,
    clock,
    ttlSeconds: config.CHECKOUT_SESSION_TTL_SECONDS,
  });
  const createPaymentAttempt = new CreatePaymentAttemptUseCase({
    store: workflow,
    signer: signer.signer,
    idempotency,
    unitOfWork: uow,
    random,
    clock,
    checkoutAddress: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    tokenAddress: config.NEXT_PUBLIC_USDC_ADDRESS,
    platformFeeBps,
    signerKeyId: signer.keyId,
    attemptTtlSeconds: config.PAYMENT_INTENT_TTL_SECONDS,
  });
  const commands = new LiveBackendApiCommands({
    createMerchant,
    createProduct,
    createCheckoutSession,
    createPaymentAttempt,
    recordPreparedAttempt: new RecordPreparedAttemptUseCase({ store: workflow, clock }),
    startSubmission: new StartSubmissionUseCase({ store: workflow, clock }),
    attachSubmission: new AttachSubmissionUseCase({ store: workflow, clock }),
    createRefund: new CreateRefundUseCase({ users, store: workflow, idempotency, random, clock }),
    createWithdrawal: new CreateWithdrawalUseCase({
      users,
      merchants,
      store: workflow,
      idempotency,
      random,
      clock,
    }),
    createSplit: new CreateSplitUseCase({
      users,
      orders: workflow,
      capabilities,
      idempotency,
      clock,
    }),
    workflow,
    queries,
    idempotency,
    backend,
    ...(judgeEvidence === undefined ? {} : { judgeEvidence }),
    chain,
    ...(browser.particle.enabled
      ? {
          expectedDelegationImplementation: EvmAddressSchema.parse(
            browser.particle.expectedImplementationAddress,
          ),
          expectedDelegationCodeHash: browser.particle
            .expectedImplementationCodeHash as `0x${string}`,
        }
      : {}),
    checkoutAddress: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    splitAddress: config.NEXT_PUBLIC_SPLIT_ADDRESS,
    tokenAddress: config.NEXT_PUBLIC_USDC_ADDRESS,
    appOrigin: config.NEXT_PUBLIC_APP_ORIGIN,
    allowedMediaOrigins: new Set(browser.media.allowedOrigins),
    operationTtlSeconds: config.CHECKOUT_SESSION_TTL_SECONDS,
    checkoutPreviewPolicy: {
      providerMode: config.PROVIDER_MODE,
      particleLiveEnabled: config.PARTICLE_LIVE_ENABLED,
      submissionEnabled: featureCapabilities.checkoutSubmission,
      maxSlippageBps: config.PARTICLE_MAX_SLIPPAGE_BPS,
      maxFeeUsdMicros: config.PARTICLE_MAX_FEE_USD_MICROS.toString(),
      allowedSourceChainIds: config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS,
      allowedSourceAssets: config.PARTICLE_ALLOWED_SOURCE_ASSETS,
    },
    submissionPolicy: {
      merchantMutations: featureCapabilities.merchantMutations,
      refunds: featureCapabilities.refunds,
      withdrawals: featureCapabilities.withdrawals,
      splits: featureCapabilities.splits,
    },
    ...(split === undefined
      ? {}
      : {
          splitSigner: split.signer,
          splitSignerKeyId: split.keyId,
          splitSignerAddress: split.address,
        }),
    ...(splitRevocationSender === undefined ? {} : { splitRevocationSender, managedSignerLocks }),
    environment: config.APP_ENV,
    evidenceProvenance: deterministicParts === undefined ? 'live' : 'deterministic',
    ...(challengeVerifier === undefined ? {} : { challengeVerifier }),
    ...(sponsorGrants === undefined ? {} : { sponsorGrants }),
    ...(requestBootstrapGrant === undefined ? {} : { requestBootstrapGrant }),
    ...(config.BOOTSTRAP_SPONSOR_ENABLED
      ? {
          sponsorPolicy: {
            targetWei: config.SPONSOR_TARGET_BALANCE_WEI,
            minimumGrantWei: config.SPONSOR_MIN_GRANT_WEI,
            ...(config.BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY
              ? {
                  allowedRecipients: new Set(
                    allowedSponsorRecipients.map((address) => address.toLowerCase()),
                  ),
                }
              : {}),
          },
        }
      : {}),
    now: clock.now,
  });
  const resourceQueries = new LiveBackendApiResourceQueries({
    config: browser,
    queries,
    backend,
    ...(operationsForActor === undefined ? {} : { operationsForActor }),
    chain,
    checks: {
      database: () =>
        checkDatabaseHealth(database.db, {
          requireLeastPrivilegeRuntime,
        }),
      redis: async () => {
        await redis.ping();
      },
    },
  });
  const secureCookies = new URL(config.NEXT_PUBLIC_APP_ORIGIN).protocol === 'https:';
  return {
    sessions,
    authContinuations,
    exchangeSession: new ExchangeSessionUseCase({
      verifier,
      sessions,
      rateLimits,
      clock,
      expectedAudience,
      expectedApplicationId: expectedAudience,
    }),
    refreshSession: new RefreshSessionUseCase(sessions),
    logoutSession: new LogoutSessionUseCase(sessions),
    queries,
    resourceQueries,
    commands,
    featureFlags: featureFlags(config),
    rateLimits,
    requestLog: {
      info: (fields) => apiLogger.info(fields, 'API request completed'),
      error: (fields) => apiLogger.error(fields, 'API request failed'),
    },
    allowedOrigin: config.NEXT_PUBLIC_APP_ORIGIN,
    sessionCookieName: secureCookies ? '__Host-opentab_session' : 'opentab_session',
    authContinuationCookieName: secureCookies ? '__Host-opentab_auth_state' : 'opentab_auth_state',
    sessionCookieSecure: secureCookies,
    digestSecret: (domain, value) =>
      hashOpaqueSecret({ domain: `api-${domain}`.slice(0, 64), pepper: privacySecret, value }),
    networkSubject: (request) => trustedNetworkSubject(request, config.APP_ENV),
    async close() {
      await Promise.allSettled([redis.quit(), database.close()]);
    },
  };
}

let installedClose: (() => Promise<void>) | undefined;

export async function installComposedBackendApiRegistry(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const composed = await createBackendApiRegistry(env);
  installBackendApiRegistry(composed);
  installedClose = () => composed.close();
}

export async function closeComposedBackendApiRegistry(): Promise<void> {
  const close = installedClose;
  installedClose = undefined;
  await close?.();
}
