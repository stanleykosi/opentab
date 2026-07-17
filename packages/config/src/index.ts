import {
  ARBITRUM_ONE_CHAIN_ID,
  ARBITRUM_ONE_USDC,
  Bytes32Schema,
  ChainIdSchema,
  EvmAddressSchema,
} from '@opentab/shared';
import { z } from 'zod';

const strictBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const unsignedBigInt = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform((value) => BigInt(value));
const unsignedBigIntWithDefault = (fallback: bigint) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    unsignedBigInt.default(fallback),
  );
const stringWithDefault = (fallback: string) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).default(fallback),
  );
const addressWithDefault = (fallback: ReturnType<typeof EvmAddressSchema.parse>) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    EvmAddressSchema.default(fallback),
  );
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);
const exactApplicationOrigin = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Application origin must be an exact credential-free origin',
      });
    }
  });
const optionalAddress = z.preprocess(
  (value) => (value === '' ? undefined : value),
  EvmAddressSchema.optional(),
);
const optionalBytes32 = z.preprocess(
  (value) => (value === '' ? undefined : value),
  Bytes32Schema.optional(),
);
const optionalGitReleaseId = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
);
const optionalParticleNonceOffset = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .enum(['0', '1'])
    .transform((value): 0 | 1 => (value === '0' ? 0 : 1))
    .optional(),
);
const optionalPlatformFeeBps = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().min(0).max(500).optional(),
);
const particleSourceChains = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(ChainIdSchema).min(1).max(6))
  .refine((values) => new Set(values).size === values.length, 'Source chain IDs must be unique');
const particleSourceAssets = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toUpperCase())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(z.enum(['USDC', 'USDT', 'ETH']))
      .min(1)
      .max(3),
  )
  .refine((values) => new Set(values).size === values.length, 'Source assets must be unique');
const ParticleSourceTokenSchema = z
  .string()
  .regex(/^[1-9][0-9]*:(?:USDC|USDT|ETH):0x[0-9a-fA-F]{40}$/)
  .transform((value) => {
    const [chainId, asset, address] = value.split(':');
    return {
      chainId: ChainIdSchema.parse(chainId),
      asset: z.enum(['USDC', 'USDT', 'ETH']).parse(asset),
      address: EvmAddressSchema.parse(address),
    };
  });
const particleSourceTokens = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(ParticleSourceTokenSchema).max(32))
  .refine(
    (values) =>
      new Set(
        values.map((value) => `${value.chainId}:${value.asset}:${value.address.toLowerCase()}`),
      ).size === values.length,
    'Source token entries must be unique',
  );
const ParticleSourceCallProfileSchema = z
  .object({
    profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    chainId: ChainIdSchema,
    asset: z.enum(['USDC', 'USDT', 'ETH']),
    tokenAddress: EvmAddressSchema,
    sourceAmount: z
      .string()
      .regex(/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
      .max(100),
    fixtureDigest: Bytes32Schema,
    calls: z
      .array(
        z
          .object({
            uaType: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
            to: EvmAddressSchema,
            data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
            valueWei: z.string().regex(/^(0|[1-9][0-9]*)$/),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
const particleSourceCallProfiles = z
  .preprocess((value) => {
    if (value === undefined || value === '') return [];
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }, z.array(ParticleSourceCallProfileSchema).max(32))
  .superRefine((values, context) => {
    const ids = new Set<string>();
    const digests = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (ids.has(value.profileId) || digests.has(value.fixtureDigest.toLowerCase())) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Source call profile IDs and fixture digests must be unique',
        });
      }
      ids.add(value.profileId);
      digests.add(value.fixtureDigest.toLowerCase());
    }
  });
const awsRegion = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/)
    .optional(),
);
const optionalAwsRoleArn = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .regex(/^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/)
    .optional(),
);
const productMediaOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1).max(2_048)).max(20))
  .superRefine((values, context) => {
    for (const [index, value] of values.entries()) {
      try {
        const url = new URL(value);
        if (
          url.protocol !== 'https:' ||
          url.origin !== value ||
          url.username !== '' ||
          url.password !== '' ||
          url.pathname !== '/' ||
          url.search !== '' ||
          url.hash !== ''
        ) {
          context.addIssue({
            code: 'custom',
            path: [index],
            message: 'Product media origins must be exact HTTPS origins',
          });
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Product media origin is not a valid URL',
        });
      }
    }
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Product media origins must be unique' });
    }
  });
const placeholderPattern = /(?:REPLACE(?:_ME|_WITH)?|CHANGE_ME|EXAMPLE_ONLY)/i;
const zeroAddressPattern = /^0x0{40}$/i;

function isConfigured(value: unknown): boolean {
  if (typeof value !== 'string') return value !== undefined && value !== null;
  return value.trim().length > 0 && !placeholderPattern.test(value);
}

export const AppEnvironmentSchema = z.enum([
  'local',
  'test',
  'preview',
  'staging',
  'demo-mainnet',
  'production',
]);
export const ProviderModeSchema = z.enum(['deterministic', 'live']);

type PlatformEnvironmentTarget = 'public' | 'server' | 'frontend' | 'indexer';

function normalizedHttpsOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const candidate = value.includes('://') ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function vercelApplicationEnvironment(value: string | undefined): string | undefined {
  switch (value?.trim().toLowerCase()) {
    case 'production':
      return 'production';
    case 'preview':
      return 'preview';
    case 'development':
      return 'local';
    default:
      return undefined;
  }
}

function railwayApplicationEnvironment(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (normalized === 'development') return 'local';
  if (normalized === 'pr' || normalized.startsWith('pr-')) return 'preview';
  return normalized;
}

function isRailwayService(input: Readonly<Record<string, string | undefined>>): boolean {
  return [
    'RAILWAY_SERVICE_ID',
    'RAILWAY_SERVICE_NAME',
    'RAILWAY_PROJECT_ID',
    'RAILWAY_ENVIRONMENT_ID',
    'RAILWAY_ENVIRONMENT_NAME',
  ].some((name) => (input[name]?.trim().length ?? 0) > 0);
}

function normalizePlatformEnvironment(
  input: Record<string, string | undefined>,
  target: PlatformEnvironmentTarget,
): Record<string, string | undefined> {
  const normalized = { ...input };
  if (target === 'indexer') {
    const railway = isRailwayService(input);
    if (normalized.APP_ENV === undefined) {
      normalized.APP_ENV = railwayApplicationEnvironment(input.RAILWAY_ENVIRONMENT_NAME);
    }
    if (railway) {
      normalized.INDEXER_ENABLED ??= 'true';
      normalized.INDEXER_WRITES_ENABLED ??= 'true';
      normalized.PARTICLE_LIVE_ENABLED ??= 'true';
    }
    return normalized;
  }

  const vercelEnvironment = vercelApplicationEnvironment(input.VERCEL_ENV);
  if (target !== 'public') normalized.APP_ENV ??= vercelEnvironment;
  normalized.NEXT_PUBLIC_APP_ENV ??= normalized.APP_ENV ?? vercelEnvironment;

  const environment = normalized.APP_ENV ?? normalized.NEXT_PUBLIC_APP_ENV;
  if (normalized.NEXT_PUBLIC_APP_ORIGIN === undefined) {
    if (environment === 'production' && vercelEnvironment === 'production') {
      normalized.NEXT_PUBLIC_APP_ORIGIN =
        normalizedHttpsOrigin(input.VERCEL_PROJECT_PRODUCTION_URL) ?? '';
    } else if (environment === 'preview' && vercelEnvironment === 'preview') {
      normalized.NEXT_PUBLIC_APP_ORIGIN = normalizedHttpsOrigin(input.VERCEL_URL) ?? '';
    }
  }
  if (
    (target === 'server' || target === 'frontend') &&
    normalized.PROVIDER_MODE === undefined &&
    vercelEnvironment === 'production' &&
    environment === 'production'
  ) {
    normalized.PROVIDER_MODE = 'live';
  }
  if (target === 'server' && normalized.APPLICATION_RELEASE_ID === undefined) {
    normalized.APPLICATION_RELEASE_ID = input.VERCEL_GIT_COMMIT_SHA;
  }
  if (
    target === 'server' &&
    normalized.PARTICLE_RESPONSE_PROFILE_PROVENANCE === undefined &&
    normalized.PARTICLE_LIVE_ENABLED === 'true'
  ) {
    normalized.PARTICLE_RESPONSE_PROFILE_PROVENANCE = 'recorded_live';
  }
  if (
    target === 'server' &&
    ['preview', 'staging', 'demo-mainnet', 'production'].includes(environment ?? '')
  ) {
    if (normalized.PAYMENTS_ENABLED === 'true') normalized.ORDER_SIGNER_MODE ??= 'kms';
    if (normalized.SPLITS_ENABLED === 'true') normalized.SPLIT_SIGNER_MODE ??= 'kms';
    if (normalized.BOOTSTRAP_SPONSOR_ENABLED === 'true') {
      normalized.SPONSOR_SIGNER_MODE ??= 'kms';
    }
  }
  return normalized;
}

/** Minimal, public-safe server projection used by React route presentation. */
export const FrontendFeatureEnvironmentSchema = z
  .object({
    APP_ENV: AppEnvironmentSchema.optional(),
    NEXT_PUBLIC_APP_ENV: AppEnvironmentSchema.default('local'),
    PROVIDER_MODE: ProviderModeSchema.default('deterministic'),
    DETERMINISTIC_DEMO_ENABLED: strictBoolean.default(false),
    PAYMENTS_ENABLED: strictBoolean.default(false),
    REFUNDS_ENABLED: strictBoolean.default(false),
    WITHDRAWALS_ENABLED: strictBoolean.default(false),
    SPLITS_ENABLED: strictBoolean.default(false),
    JUDGE_MODE_ENABLED: strictBoolean.default(false),
  })
  .transform((value) => ({
    environment: value.APP_ENV ?? value.NEXT_PUBLIC_APP_ENV,
    providerMode: value.PROVIDER_MODE,
    deterministicDemo: value.DETERMINISTIC_DEMO_ENABLED,
    payments: value.PAYMENTS_ENABLED,
    refunds: value.REFUNDS_ENABLED,
    withdrawals: value.WITHDRAWALS_ENABLED,
    splits: value.SPLITS_ENABLED,
    judgeMode: value.JUDGE_MODE_ENABLED,
  }));

export const PublicEnvironmentSchema = z.object({
  NEXT_PUBLIC_APP_ENV: AppEnvironmentSchema.default('local'),
  NEXT_PUBLIC_APP_ORIGIN: exactApplicationOrigin.default('http://localhost:3000'),
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: z.string().min(1).default('pk_live_REPLACE_ME'),
  NEXT_PUBLIC_PARTICLE_PROJECT_ID: stringWithDefault('REPLACE_ME'),
  NEXT_PUBLIC_PARTICLE_CLIENT_KEY: stringWithDefault('REPLACE_ME'),
  NEXT_PUBLIC_PARTICLE_APP_UUID: stringWithDefault('REPLACE_ME'),
  NEXT_PUBLIC_ARBITRUM_CHAIN_ID: ChainIdSchema.default(ARBITRUM_ONE_CHAIN_ID),
  NEXT_PUBLIC_ARBITRUM_PUBLIC_RPC_URL: z.string().url().default('https://arb1.arbitrum.io/rpc'),
  NEXT_PUBLIC_USDC_ADDRESS: EvmAddressSchema.default(ARBITRUM_ONE_USDC),
  NEXT_PUBLIC_CHECKOUT_ADDRESS: addressWithDefault(
    EvmAddressSchema.parse('0x0000000000000000000000000000000000000000'),
  ),
  NEXT_PUBLIC_PASS_ADDRESS: addressWithDefault(
    EvmAddressSchema.parse('0x0000000000000000000000000000000000000000'),
  ),
  NEXT_PUBLIC_SPLIT_ADDRESS: addressWithDefault(
    EvmAddressSchema.parse('0x0000000000000000000000000000000000000000'),
  ),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optionalString,
});

export const ServerEnvironmentSchema = PublicEnvironmentSchema.extend({
  APP_ENV: AppEnvironmentSchema.default('local'),
  PROVIDER_MODE: ProviderModeSchema.default('deterministic'),
  DETERMINISTIC_DEMO_ENABLED: strictBoolean.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PAYMENTS_ENABLED: strictBoolean.default(false),
  PARTICLE_LIVE_ENABLED: strictBoolean.default(false),
  BOOTSTRAP_SPONSOR_ENABLED: strictBoolean.default(false),
  BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY: strictBoolean.default(true),
  JUDGE_MODE_ENABLED: strictBoolean.default(false),
  MERCHANT_MUTATIONS_ENABLED: strictBoolean.default(true),
  REFUNDS_ENABLED: strictBoolean.default(false),
  WITHDRAWALS_ENABLED: strictBoolean.default(false),
  SPLITS_ENABLED: strictBoolean.default(false),
  MAGIC_SECRET_KEY: optionalString,
  PARTICLE_RPC_URL: optionalUrl,
  ARBITRUM_RPC_URL: optionalUrl,
  ARBITRUM_FALLBACK_RPC_URL: optionalUrl,
  CONFIRMATION_DEPTH: z.coerce.number().int().min(1).max(100).default(2),
  REORG_WINDOW_BLOCKS: z.coerce.number().int().min(16).max(100_000).default(512),
  INDEXER_DEPLOYMENT_BLOCK: unsignedBigIntWithDefault(0n),
  DATABASE_URL: optionalString,
  REDIS_URL: optionalUrl,
  OPENTAB_SECRET_ROOT: optionalString,
  SESSION_HASH_PEPPER: optionalString,
  CSRF_SECRET: optionalString,
  CAPABILITY_TOKEN_PEPPER: optionalString,
  PRIVACY_SUBJECT_HASH_SECRET: optionalString,
  JUDGE_SHARE_TOKEN_SECRET: optionalString,
  LIVE_ACCEPTANCE_ATTESTATION_SECRET: optionalString,
  APPLICATION_RELEASE_ID: optionalGitReleaseId,
  SESSION_MAX_AGE_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(604_800),
  CHECKOUT_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  PAYMENT_INTENT_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  PLATFORM_FEE_BPS: optionalPlatformFeeBps,
  PARTICLE_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(500).default(100),
  PARTICLE_MAX_FEE_USD_MICROS: unsignedBigIntWithDefault(5_000_000n),
  PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: z.preprocess(
    (value) => value ?? '1,8453,42161',
    particleSourceChains,
  ),
  PARTICLE_ALLOWED_SOURCE_ASSETS: z.preprocess(
    (value) => value ?? 'USDC,USDT,ETH',
    particleSourceAssets,
  ),
  PARTICLE_ALLOWED_SOURCE_TOKENS: z.preprocess((value) => value ?? '', particleSourceTokens),
  PARTICLE_SOURCE_CALL_PROFILES_JSON: particleSourceCallProfiles,
  PRODUCT_MEDIA_ALLOWED_ORIGINS: z.preprocess((value) => value ?? '', productMediaOrigins),
  PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: optionalAddress,
  PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: optionalBytes32,
  PARTICLE_RESPONSE_PROFILE_ID: optionalString,
  PARTICLE_RESPONSE_PROFILE_PROVENANCE: z
    .enum(['deterministic', 'recorded_live'])
    .default('deterministic'),
  PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: optionalBytes32,
  PARTICLE_AUTH_FIXTURE_DIGEST: optionalBytes32,
  PARTICLE_SUBMISSION_FIXTURE_DIGEST: optionalBytes32,
  PARTICLE_STATUS_FIXTURE_DIGEST: optionalBytes32,
  PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET: optionalParticleNonceOffset,
  PARTICLE_DELEGATION_PLAN_TTL_SECONDS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(30).max(600).default(300),
  ),
  ORDER_SIGNER_MODE: z.enum(['disabled', 'private-key', 'kms']).default('disabled'),
  ORDER_SIGNER_PRIVATE_KEY: optionalString,
  ORDER_SIGNER_KMS_KEY_ID: optionalString,
  ORDER_SIGNER_ADDRESS: optionalAddress,
  SPLIT_SIGNER_MODE: z.enum(['disabled', 'private-key', 'kms']).default('disabled'),
  SPLIT_SIGNER_PRIVATE_KEY: optionalString,
  SPLIT_SIGNER_KEY_ID: optionalString,
  SPLIT_SIGNER_EXPECTED_ADDRESS: optionalAddress,
  SPLIT_REVOCATION_MAX_FEE_PER_GAS_WEI: unsignedBigIntWithDefault(5_000_000_000n),
  SPLIT_REVOCATION_MAX_GAS_LIMIT: unsignedBigIntWithDefault(200_000n),
  AWS_KMS_REGION: awsRegion,
  VERCEL_AWS_ROLE_ARN: optionalAwsRoleArn,
  SPONSOR_SIGNER_MODE: z.enum(['disabled', 'private-key', 'kms']).default('disabled'),
  SPONSOR_PRIVATE_KEY: optionalString,
  SPONSOR_KMS_KEY_ID: optionalString,
  SPONSOR_SIGNER_ADDRESS: optionalAddress,
  SPONSOR_MAX_FEE_PER_GAS_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_MIN_GRANT_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_TARGET_BALANCE_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_PER_GRANT_CAP_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_PER_ADDRESS_DAILY_CAP_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_PER_USER_DAILY_CAP_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_PER_IP_DAILY_CAP_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_PER_DEVICE_DAILY_CAP_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_GLOBAL_DAILY_CAP_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_LOW_BALANCE_ALERT_WEI: unsignedBigIntWithDefault(0n),
  SPONSOR_ALLOWED_ADDRESSES: z.string().default(''),
  TURNSTILE_SECRET_KEY: optionalString,
}).superRefine((config, context) => {
  const requireConfigured = (name: keyof typeof config, message?: string) => {
    if (!isConfigured(config[name])) {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: message ?? `${name} must be configured with a non-placeholder value`,
      });
    }
  };
  type LegacySecuritySecret =
    | 'SESSION_HASH_PEPPER'
    | 'CSRF_SECRET'
    | 'CAPABILITY_TOKEN_PEPPER'
    | 'PRIVACY_SUBJECT_HASH_SECRET';
  const requireSecuritySecret = (name: LegacySecuritySecret, message: string) => {
    if (!isConfigured(config.OPENTAB_SECRET_ROOT) && !isConfigured(config[name])) {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: `${message}; configure ${name} or OPENTAB_SECRET_ROOT`,
      });
    }
  };

  if (config.APP_ENV !== config.NEXT_PUBLIC_APP_ENV) {
    context.addIssue({
      code: 'custom',
      path: ['NEXT_PUBLIC_APP_ENV'],
      message: 'Public and server environments must match',
    });
  }

  const productionLike = ['preview', 'staging', 'demo-mainnet', 'production'].includes(
    config.APP_ENV,
  );
  if (productionLike && new URL(config.NEXT_PUBLIC_APP_ORIGIN).protocol !== 'https:') {
    context.addIssue({
      code: 'custom',
      path: ['NEXT_PUBLIC_APP_ORIGIN'],
      message: 'HTTPS is required outside local/test',
    });
  }
  if (productionLike && config.DATABASE_URL !== undefined) {
    try {
      const databaseUrl = new URL(config.DATABASE_URL);
      const sslModes = databaseUrl.searchParams.getAll('sslmode');
      const sslMode = sslModes[0];
      if (
        !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
        sslModes.length !== 1 ||
        !['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Production-like PostgreSQL requires sslmode=require or stronger',
        });
      }
      if (databaseUrl.username.length === 0 || databaseUrl.password.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Production-like PostgreSQL requires username and password authentication',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must be a valid PostgreSQL URL',
      });
    }
  }
  if (productionLike && config.REDIS_URL !== undefined) {
    const redisUrl = new URL(config.REDIS_URL);
    const railwayPrivate =
      redisUrl.protocol === 'redis:' && redisUrl.hostname.endsWith('.railway.internal');
    if (redisUrl.protocol !== 'rediss:' && !railwayPrivate) {
      context.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message:
          'Public production-like Redis requires TLS; redis:// is allowed only on .railway.internal',
      });
    }
    if (redisUrl.password.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'Production-like Redis requires password authentication',
      });
    }
  }
  if (config.APP_ENV === 'production' && config.PROVIDER_MODE !== 'live') {
    context.addIssue({
      code: 'custom',
      path: ['PROVIDER_MODE'],
      message: 'Production cannot use deterministic providers',
    });
  }
  if (config.APP_ENV === 'production' && config.DETERMINISTIC_DEMO_ENABLED) {
    context.addIssue({
      code: 'custom',
      path: ['DETERMINISTIC_DEMO_ENABLED'],
      message: 'Production deterministic demo must be disabled',
    });
  }

  if (
    ['demo-mainnet', 'production'].includes(config.APP_ENV) &&
    config.PROVIDER_MODE === 'live' &&
    !config.DETERMINISTIC_DEMO_ENABLED
  ) {
    requireConfigured(
      'APPLICATION_RELEASE_ID',
      'APPLICATION_RELEASE_ID must be the exact lowercase 40-hex deployed Git commit',
    );
  }

  for (const secret of [
    'OPENTAB_SECRET_ROOT',
    'SESSION_HASH_PEPPER',
    'CSRF_SECRET',
    'CAPABILITY_TOKEN_PEPPER',
    'PRIVACY_SUBJECT_HASH_SECRET',
    'JUDGE_SHARE_TOKEN_SECRET',
    'LIVE_ACCEPTANCE_ATTESTATION_SECRET',
  ] as const) {
    const value = config[secret];
    if (value !== undefined && (placeholderPattern.test(value) || value.length < 32)) {
      context.addIssue({
        code: 'custom',
        path: [secret],
        message: `${secret} must be a non-placeholder value of at least 32 characters`,
      });
    }
  }

  const configuredSecuritySecrets = [
    config.OPENTAB_SECRET_ROOT,
    config.SESSION_HASH_PEPPER,
    config.CSRF_SECRET,
    config.CAPABILITY_TOKEN_PEPPER,
    config.PRIVACY_SUBJECT_HASH_SECRET,
    config.JUDGE_SHARE_TOKEN_SECRET,
    config.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
  ].filter((value): value is string => value !== undefined);
  if (new Set(configuredSecuritySecrets).size !== configuredSecuritySecrets.length) {
    context.addIssue({
      code: 'custom',
      path: ['PRIVACY_SUBJECT_HASH_SECRET'],
      message:
        'The root, session, CSRF, capability, privacy, Judge, and acceptance-attestation secrets must be independent',
    });
  }

  if (config.APP_ENV === 'production') {
    for (const name of [
      'NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY',
      'MAGIC_SECRET_KEY',
      'DATABASE_URL',
      'REDIS_URL',
    ] as const) {
      requireConfigured(name, `${name} is required for the production application`);
    }
    for (const name of [
      'SESSION_HASH_PEPPER',
      'CSRF_SECRET',
      'CAPABILITY_TOKEN_PEPPER',
      'PRIVACY_SUBJECT_HASH_SECRET',
    ] as const) {
      requireSecuritySecret(name, 'Production application security material is required');
    }
  }

  if (config.PAYMENTS_ENABLED) {
    const required: Array<[string, unknown]> = [
      ['PARTICLE_LIVE_ENABLED', config.PARTICLE_LIVE_ENABLED],
      ['NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY', config.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY],
      ['MAGIC_SECRET_KEY', config.MAGIC_SECRET_KEY],
      ['NEXT_PUBLIC_PARTICLE_PROJECT_ID', config.NEXT_PUBLIC_PARTICLE_PROJECT_ID],
      ['NEXT_PUBLIC_PARTICLE_CLIENT_KEY', config.NEXT_PUBLIC_PARTICLE_CLIENT_KEY],
      ['NEXT_PUBLIC_PARTICLE_APP_UUID', config.NEXT_PUBLIC_PARTICLE_APP_UUID],
      ['ARBITRUM_RPC_URL', config.ARBITRUM_RPC_URL],
      ['ARBITRUM_FALLBACK_RPC_URL', config.ARBITRUM_FALLBACK_RPC_URL],
      ['DATABASE_URL', config.DATABASE_URL],
      ['REDIS_URL', config.REDIS_URL],
      ['ORDER_SIGNER_ADDRESS', config.ORDER_SIGNER_ADDRESS],
    ];
    for (const [name, value] of required) {
      if (!value || !isConfigured(value))
        context.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} is required when payments are enabled`,
        });
    }
    for (const name of [
      'SESSION_HASH_PEPPER',
      'CSRF_SECRET',
      'CAPABILITY_TOKEN_PEPPER',
      'PRIVACY_SUBJECT_HASH_SECRET',
    ] as const) {
      requireSecuritySecret(name, 'Payment security material is required');
    }
    if (config.PLATFORM_FEE_BPS === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['PLATFORM_FEE_BPS'],
        message: 'PLATFORM_FEE_BPS must be explicitly configured when payments are enabled',
      });
    }
    if (config.PROVIDER_MODE !== 'live') {
      context.addIssue({
        code: 'custom',
        path: ['PROVIDER_MODE'],
        message: 'Live payments require live providers',
      });
    }
    if (config.NEXT_PUBLIC_ARBITRUM_CHAIN_ID !== ARBITRUM_ONE_CHAIN_ID) {
      context.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_ARBITRUM_CHAIN_ID'],
        message: 'Live checkout settlement requires Arbitrum One chain ID 42161',
      });
    }
    if (config.NEXT_PUBLIC_USDC_ADDRESS.toLowerCase() !== ARBITRUM_ONE_USDC.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_USDC_ADDRESS'],
        message: 'Arbitrum One checkout requires native USDC',
      });
    }
    if (
      config.ARBITRUM_RPC_URL &&
      config.ARBITRUM_FALLBACK_RPC_URL &&
      new URL(config.ARBITRUM_RPC_URL).hostname.toLowerCase() ===
        new URL(config.ARBITRUM_FALLBACK_RPC_URL).hostname.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ARBITRUM_FALLBACK_RPC_URL'],
        message: 'Primary and fallback Arbitrum RPC providers must use independent hosts',
      });
    }
    if (
      !config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS.includes(ARBITRUM_ONE_CHAIN_ID) ||
      !config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS.some((chainId) => chainId !== ARBITRUM_ONE_CHAIN_ID)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_ALLOWED_SOURCE_CHAIN_IDS'],
        message: 'Live payments require Arbitrum One plus at least one approved source chain',
      });
    }
    if (config.PARTICLE_MAX_FEE_USD_MICROS <= 0n) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_MAX_FEE_USD_MICROS'],
        message: 'Live payments require a positive hard fee ceiling',
      });
    }
    for (const [name, address] of [
      ['NEXT_PUBLIC_CHECKOUT_ADDRESS', config.NEXT_PUBLIC_CHECKOUT_ADDRESS],
      ['NEXT_PUBLIC_PASS_ADDRESS', config.NEXT_PUBLIC_PASS_ADDRESS],
    ] as const) {
      if (zeroAddressPattern.test(address))
        context.addIssue({ code: 'custom', path: [name], message: `${name} cannot be zero` });
    }
    if (config.ORDER_SIGNER_MODE === 'disabled') {
      context.addIssue({
        code: 'custom',
        path: ['ORDER_SIGNER_MODE'],
        message: 'Payments require an order signer',
      });
    }
    if (config.ORDER_SIGNER_MODE === 'private-key') {
      if (
        !config.ORDER_SIGNER_PRIVATE_KEY ||
        !/^0x[0-9a-fA-F]{64}$/.test(config.ORDER_SIGNER_PRIVATE_KEY)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['ORDER_SIGNER_PRIVATE_KEY'],
          message: 'Demo private-key signer mode requires a valid protected key',
        });
      }
    }
    if (config.ORDER_SIGNER_MODE === 'kms') {
      requireConfigured('ORDER_SIGNER_KMS_KEY_ID', 'KMS order signer mode requires a key ID');
    }
  }

  if (config.PARTICLE_LIVE_ENABLED) {
    if (config.PROVIDER_MODE !== 'live') {
      context.addIssue({
        code: 'custom',
        path: ['PROVIDER_MODE'],
        message: 'Live Particle reads and previews require live provider mode',
      });
    }
    for (const name of [
      'NEXT_PUBLIC_PARTICLE_PROJECT_ID',
      'NEXT_PUBLIC_PARTICLE_CLIENT_KEY',
      'NEXT_PUBLIC_PARTICLE_APP_UUID',
      'ARBITRUM_RPC_URL',
      'ARBITRUM_FALLBACK_RPC_URL',
    ] as const) {
      requireConfigured(name, `${name} is required for live Particle reads and previews`);
    }
    for (const name of [
      'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
      'PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH',
      'PARTICLE_RESPONSE_PROFILE_ID',
      'PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST',
      'PARTICLE_AUTH_FIXTURE_DIGEST',
      'PARTICLE_SUBMISSION_FIXTURE_DIGEST',
      'PARTICLE_STATUS_FIXTURE_DIGEST',
      'PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET',
      'PARTICLE_DELEGATION_PLAN_TTL_SECONDS',
    ] as const) {
      requireConfigured(name, `${name} is required for the live Particle adapter`);
    }
    if (config.PARTICLE_RESPONSE_PROFILE_PROVENANCE !== 'recorded_live') {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_RESPONSE_PROFILE_PROVENANCE'],
        message: 'Live Particle calls require a sanitized recorded-live response profile',
      });
    }
    if (config.NEXT_PUBLIC_ARBITRUM_CHAIN_ID !== ARBITRUM_ONE_CHAIN_ID) {
      context.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_ARBITRUM_CHAIN_ID'],
        message: 'Live Particle previews require Arbitrum One chain ID 42161',
      });
    }
    if (config.NEXT_PUBLIC_USDC_ADDRESS.toLowerCase() !== ARBITRUM_ONE_USDC.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_USDC_ADDRESS'],
        message: 'Live Particle previews require native Arbitrum One USDC',
      });
    }
    for (const [name, address] of [
      ['NEXT_PUBLIC_CHECKOUT_ADDRESS', config.NEXT_PUBLIC_CHECKOUT_ADDRESS],
      ['NEXT_PUBLIC_PASS_ADDRESS', config.NEXT_PUBLIC_PASS_ADDRESS],
    ] as const) {
      if (zeroAddressPattern.test(address)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} cannot be zero for live Particle previews`,
        });
      }
    }
    if (
      config.ARBITRUM_RPC_URL !== undefined &&
      config.ARBITRUM_FALLBACK_RPC_URL !== undefined &&
      new URL(config.ARBITRUM_RPC_URL).hostname.toLowerCase() ===
        new URL(config.ARBITRUM_FALLBACK_RPC_URL).hostname.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ARBITRUM_FALLBACK_RPC_URL'],
        message: 'Live Particle preview RPC failover must use an independent provider host',
      });
    }
    if (
      !config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS.includes(ARBITRUM_ONE_CHAIN_ID) ||
      !config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS.some((chainId) => chainId !== ARBITRUM_ONE_CHAIN_ID)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_ALLOWED_SOURCE_CHAIN_IDS'],
        message: 'Live Particle previews require Arbitrum One and an approved source chain',
      });
    }
    if (config.PARTICLE_MAX_FEE_USD_MICROS <= 0n) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_MAX_FEE_USD_MICROS'],
        message: 'Live Particle previews require a positive hard fee ceiling',
      });
    }
    if (
      config.PARTICLE_RESPONSE_PROFILE_ID !== undefined &&
      !/^[A-Za-z0-9_.:/-]{3,120}$/.test(config.PARTICLE_RESPONSE_PROFILE_ID)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_RESPONSE_PROFILE_ID'],
        message: 'Particle response profile ID is invalid',
      });
    }
    if (
      config.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS !== undefined &&
      zeroAddressPattern.test(config.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS'],
        message: 'Particle EIP-7702 implementation cannot be zero',
      });
    }
    if (
      config.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH !== undefined &&
      /^0x0{64}$/i.test(config.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH'],
        message: 'Particle EIP-7702 implementation code hash cannot be zero',
      });
    }
    if (config.PARTICLE_ALLOWED_SOURCE_TOKENS.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_ALLOWED_SOURCE_TOKENS'],
        message: 'Live Particle calls require at least one exact source-token address',
      });
    }
    if (config.PARTICLE_SOURCE_CALL_PROFILES_JSON.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['PARTICLE_SOURCE_CALL_PROFILES_JSON'],
        message: 'Live cross-chain Particle calls require reviewed source-call profiles',
      });
    }
    for (const profile of config.PARTICLE_SOURCE_CALL_PROFILES_JSON) {
      if (
        profile.chainId === ARBITRUM_ONE_CHAIN_ID ||
        !config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS.includes(profile.chainId) ||
        !config.PARTICLE_ALLOWED_SOURCE_TOKENS.some(
          (token) =>
            token.chainId === profile.chainId &&
            token.asset === profile.asset &&
            token.address.toLowerCase() === profile.tokenAddress.toLowerCase(),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['PARTICLE_SOURCE_CALL_PROFILES_JSON'],
          message: 'Every source-call profile must bind an approved non-Arbitrum chain and token',
        });
      }
    }
    for (const source of config.PARTICLE_ALLOWED_SOURCE_TOKENS) {
      if (
        !config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS.includes(source.chainId) ||
        !config.PARTICLE_ALLOWED_SOURCE_ASSETS.includes(source.asset)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['PARTICLE_ALLOWED_SOURCE_TOKENS'],
          message: 'Every exact source token must be inside the approved chain and asset policy',
        });
      }
    }
  }

  if (config.BOOTSTRAP_SPONSOR_ENABLED) {
    requireSecuritySecret(
      'PRIVACY_SUBJECT_HASH_SECRET',
      'Sponsor risk dimensions require a dedicated privacy hashing secret',
    );
    requireConfigured('TURNSTILE_SECRET_KEY', 'Sponsor requires a Turnstile secret key');
    requireConfigured(
      'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
      'Sponsor requires a public Turnstile site key',
    );
    if (!config.PAYMENTS_ENABLED || !config.REDIS_URL) {
      context.addIssue({
        code: 'custom',
        path: ['BOOTSTRAP_SPONSOR_ENABLED'],
        message: 'Sponsor requires payments and Redis',
      });
    }
    if (config.SPONSOR_SIGNER_MODE === 'disabled') {
      context.addIssue({
        code: 'custom',
        path: ['SPONSOR_SIGNER_MODE'],
        message: 'Sponsor signer is required',
      });
    }
    if (
      config.SPONSOR_MIN_GRANT_WEI <= 0n ||
      config.SPONSOR_TARGET_BALANCE_WEI <= 0n ||
      config.SPONSOR_PER_GRANT_CAP_WEI <= 0n ||
      config.SPONSOR_MIN_GRANT_WEI > config.SPONSOR_TARGET_BALANCE_WEI ||
      config.SPONSOR_TARGET_BALANCE_WEI > config.SPONSOR_PER_GRANT_CAP_WEI ||
      config.SPONSOR_GLOBAL_DAILY_CAP_WEI < config.SPONSOR_PER_GRANT_CAP_WEI ||
      config.SPONSOR_PER_ADDRESS_DAILY_CAP_WEI < config.SPONSOR_PER_GRANT_CAP_WEI ||
      config.SPONSOR_PER_USER_DAILY_CAP_WEI < config.SPONSOR_PER_GRANT_CAP_WEI ||
      config.SPONSOR_PER_IP_DAILY_CAP_WEI < config.SPONSOR_PER_GRANT_CAP_WEI ||
      config.SPONSOR_PER_DEVICE_DAILY_CAP_WEI < config.SPONSOR_PER_GRANT_CAP_WEI ||
      config.SPONSOR_LOW_BALANCE_ALERT_WEI < config.SPONSOR_PER_GRANT_CAP_WEI
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SPONSOR_PER_GRANT_CAP_WEI'],
        message: 'Sponsor caps must be positive and internally consistent',
      });
    }
    if (config.SPONSOR_SIGNER_MODE === 'private-key') {
      if (!config.SPONSOR_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(config.SPONSOR_PRIVATE_KEY)) {
        context.addIssue({
          code: 'custom',
          path: ['SPONSOR_PRIVATE_KEY'],
          message: 'Demo sponsor private-key mode requires a valid protected key',
        });
      }
    }
    if (config.SPONSOR_SIGNER_MODE === 'kms') {
      requireConfigured('SPONSOR_KMS_KEY_ID', 'KMS sponsor mode requires a key ID');
    }
    if (config.BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY) {
      const entries = config.SPONSOR_ALLOWED_ADDRESSES.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (
        entries.length === 0 ||
        entries.some((entry) => !EvmAddressSchema.safeParse(entry).success)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['SPONSOR_ALLOWED_ADDRESSES'],
          message: 'Allowlist-only sponsor mode requires valid EVM addresses',
        });
      }
    }
  }

  if (config.SPLITS_ENABLED) {
    if (!config.PAYMENTS_ENABLED || zeroAddressPattern.test(config.NEXT_PUBLIC_SPLIT_ADDRESS)) {
      context.addIssue({
        code: 'custom',
        path: ['SPLITS_ENABLED'],
        message: 'Split reimbursements require live payments and a deployed split contract',
      });
    }
    requireSecuritySecret('CAPABILITY_TOKEN_PEPPER', 'Split capabilities require a hashing pepper');
    requireConfigured(
      'SPLIT_SIGNER_EXPECTED_ADDRESS',
      'Split reimbursements require a reviewed signer address',
    );
    if (config.SPLIT_SIGNER_MODE === 'disabled') {
      context.addIssue({
        code: 'custom',
        path: ['SPLIT_SIGNER_MODE'],
        message: 'Split reimbursements require a dedicated split signer',
      });
    }
    if (config.SPLIT_SIGNER_MODE === 'private-key') {
      if (
        !config.SPLIT_SIGNER_PRIVATE_KEY ||
        !/^0x[0-9a-fA-F]{64}$/.test(config.SPLIT_SIGNER_PRIVATE_KEY)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['SPLIT_SIGNER_PRIVATE_KEY'],
          message: 'Demo split private-key signer mode requires a valid protected key',
        });
      }
    }
    if (config.SPLIT_SIGNER_MODE === 'kms') {
      requireConfigured('SPLIT_SIGNER_KEY_ID', 'Managed split signer mode requires a key ID');
      if (config.SPLIT_REVOCATION_MAX_FEE_PER_GAS_WEI <= 0n) {
        context.addIssue({
          code: 'custom',
          path: ['SPLIT_REVOCATION_MAX_FEE_PER_GAS_WEI'],
          message: 'Managed split revocation requires a positive fee-per-gas ceiling',
        });
      }
      if (config.SPLIT_REVOCATION_MAX_GAS_LIMIT < 21_000n) {
        context.addIssue({
          code: 'custom',
          path: ['SPLIT_REVOCATION_MAX_GAS_LIMIT'],
          message: 'Managed split revocation requires a gas limit of at least 21000',
        });
      }
    }
    if (
      config.ORDER_SIGNER_ADDRESS &&
      config.SPLIT_SIGNER_EXPECTED_ADDRESS &&
      config.ORDER_SIGNER_ADDRESS.toLowerCase() ===
        config.SPLIT_SIGNER_EXPECTED_ADDRESS.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SPLIT_SIGNER_EXPECTED_ADDRESS'],
        message: 'Order and split intents require separate signing roles',
      });
    }
  }

  if ((config.REFUNDS_ENABLED || config.WITHDRAWALS_ENABLED) && !config.PAYMENTS_ENABLED) {
    context.addIssue({
      code: 'custom',
      path: ['PAYMENTS_ENABLED'],
      message: 'Refunds and withdrawals cannot be enabled while payments are disabled',
    });
  }

  if (config.JUDGE_MODE_ENABLED) {
    requireConfigured('JUDGE_SHARE_TOKEN_SECRET', 'Judge Mode requires a capability secret');
    if (config.PROVIDER_MODE === 'live') {
      requireConfigured(
        'LIVE_ACCEPTANCE_ATTESTATION_SECRET',
        'Live Judge Mode requires an independent acceptance attestation secret',
      );
    }
  }

  if (productionLike) {
    if (
      config.SPONSOR_SIGNER_MODE === 'private-key' ||
      config.ORDER_SIGNER_MODE === 'private-key' ||
      config.SPLIT_SIGNER_MODE === 'private-key'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SPONSOR_SIGNER_MODE'],
        message: 'Private-key signers are restricted to local/test environments',
      });
    }
  }

  if (
    config.ORDER_SIGNER_MODE === 'kms' ||
    config.SPLIT_SIGNER_MODE === 'kms' ||
    config.SPONSOR_SIGNER_MODE === 'kms'
  ) {
    requireConfigured('AWS_KMS_REGION', 'Managed signer modes require an AWS KMS region');
    requireConfigured(
      'VERCEL_AWS_ROLE_ARN',
      'Managed web signers require a Vercel OIDC AWS role ARN',
    );
  }
  if (config.SPONSOR_SIGNER_MODE === 'kms') {
    requireConfigured(
      'SPONSOR_SIGNER_ADDRESS',
      'KMS sponsor mode requires a reviewed signer address',
    );
    if (
      config.SPONSOR_SIGNER_ADDRESS !== undefined &&
      zeroAddressPattern.test(config.SPONSOR_SIGNER_ADDRESS)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SPONSOR_SIGNER_ADDRESS'],
        message: 'Sponsor signer address cannot be zero',
      });
    }
    if (config.SPONSOR_MAX_FEE_PER_GAS_WEI <= 0n) {
      context.addIssue({
        code: 'custom',
        path: ['SPONSOR_MAX_FEE_PER_GAS_WEI'],
        message: 'Managed sponsor signing requires a positive fee-per-gas ceiling',
      });
    }
  }
});

/**
 * Least-privilege environment contract for the long-running indexer. It
 * intentionally excludes Magic Admin, browser auth, session, CSRF, Judge,
 * sponsor, order-signer, and merchant API secrets.
 */
export const IndexerEnvironmentSchema = z
  .object({
    APP_ENV: AppEnvironmentSchema.default('local'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    INDEXER_ENABLED: strictBoolean.default(false),
    INDEXER_WRITES_ENABLED: strictBoolean.default(false),
    INDEXER_RECONCILIATION_ENABLED: strictBoolean.default(true),
    DATABASE_URL_INDEXER: optionalString,
    REDIS_URL: optionalUrl,
    ARBITRUM_RPC_URL: optionalUrl,
    ARBITRUM_FALLBACK_RPC_URL: optionalUrl,
    NEXT_PUBLIC_ARBITRUM_CHAIN_ID: ChainIdSchema.default(ARBITRUM_ONE_CHAIN_ID),
    NEXT_PUBLIC_CHECKOUT_ADDRESS: addressWithDefault(
      EvmAddressSchema.parse('0x0000000000000000000000000000000000000000'),
    ),
    NEXT_PUBLIC_PASS_ADDRESS: addressWithDefault(
      EvmAddressSchema.parse('0x0000000000000000000000000000000000000000'),
    ),
    NEXT_PUBLIC_SPLIT_ADDRESS: addressWithDefault(
      EvmAddressSchema.parse('0x0000000000000000000000000000000000000000'),
    ),
    CONFIRMATION_DEPTH: z.coerce.number().int().min(1).max(100).default(2),
    REORG_WINDOW_BLOCKS: z.coerce.number().int().min(16).max(100_000).default(512),
    INDEXER_DEPLOYMENT_BLOCK: unsignedBigIntWithDefault(0n),
    PARTICLE_LIVE_ENABLED: strictBoolean.default(false),
    NEXT_PUBLIC_PARTICLE_PROJECT_ID: stringWithDefault('REPLACE_ME'),
    NEXT_PUBLIC_PARTICLE_CLIENT_KEY: stringWithDefault('REPLACE_ME'),
    NEXT_PUBLIC_PARTICLE_APP_UUID: stringWithDefault('REPLACE_ME'),
    PARTICLE_RPC_URL: optionalUrl,
    PARTICLE_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(500).default(100),
    PARTICLE_MAX_FEE_USD_MICROS: unsignedBigIntWithDefault(5_000_000n),
    PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: z.preprocess(
      (value) => value ?? '1,8453,42161',
      particleSourceChains,
    ),
    PARTICLE_ALLOWED_SOURCE_ASSETS: z.preprocess(
      (value) => value ?? 'USDC,USDT,ETH',
      particleSourceAssets,
    ),
    PARTICLE_ALLOWED_SOURCE_TOKENS: z.preprocess((value) => value ?? '', particleSourceTokens),
    PARTICLE_SOURCE_CALL_PROFILES_JSON: particleSourceCallProfiles,
    PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: optionalAddress,
    PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: optionalBytes32,
    PARTICLE_RESPONSE_PROFILE_ID: optionalString,
    PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: optionalBytes32,
    PARTICLE_AUTH_FIXTURE_DIGEST: optionalBytes32,
    PARTICLE_SUBMISSION_FIXTURE_DIGEST: optionalBytes32,
    PARTICLE_STATUS_FIXTURE_DIGEST: optionalBytes32,
    PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET: optionalParticleNonceOffset,
    PARTICLE_DELEGATION_PLAN_TTL_SECONDS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().int().min(30).max(600).default(300),
    ),
  })
  .superRefine((config, context) => {
    const required = (name: keyof typeof config, message: string) => {
      if (!isConfigured(config[name])) {
        context.addIssue({ code: 'custom', path: [name], message });
      }
    };
    if (config.NEXT_PUBLIC_ARBITRUM_CHAIN_ID !== ARBITRUM_ONE_CHAIN_ID) {
      context.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_ARBITRUM_CHAIN_ID'],
        message: 'The indexer must target Arbitrum One',
      });
    }
    if (config.INDEXER_WRITES_ENABLED && !config.INDEXER_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['INDEXER_WRITES_ENABLED'],
        message: 'Indexer writes cannot be enabled while the indexer is disabled',
      });
    }
    if (!config.INDEXER_ENABLED) return;
    required('DATABASE_URL_INDEXER', 'The enabled indexer requires dedicated PostgreSQL');
    required('ARBITRUM_RPC_URL', 'The enabled indexer requires a primary Arbitrum RPC');
    required(
      'ARBITRUM_FALLBACK_RPC_URL',
      'The enabled indexer requires an independent fallback RPC',
    );
    required(
      'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
      'The enabled indexer requires the reviewed EIP-7702 implementation address',
    );
    if (
      zeroAddressPattern.test(config.NEXT_PUBLIC_CHECKOUT_ADDRESS) ||
      zeroAddressPattern.test(config.NEXT_PUBLIC_PASS_ADDRESS)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_CHECKOUT_ADDRESS'],
        message: 'The enabled indexer requires reviewed checkout and pass addresses',
      });
    }
    if (config.ARBITRUM_RPC_URL !== undefined && config.ARBITRUM_FALLBACK_RPC_URL !== undefined) {
      const primary = new URL(config.ARBITRUM_RPC_URL);
      const fallback = new URL(config.ARBITRUM_FALLBACK_RPC_URL);
      if (primary.hostname.toLowerCase() === fallback.hostname.toLowerCase()) {
        context.addIssue({
          code: 'custom',
          path: ['ARBITRUM_FALLBACK_RPC_URL'],
          message: 'Indexer RPC failover must use an independent provider host',
        });
      }
    }
    if (config.INDEXER_RECONCILIATION_ENABLED) {
      required('REDIS_URL', 'Indexer reconciliation requires Redis');
      if (!config.PARTICLE_LIVE_ENABLED) {
        context.addIssue({
          code: 'custom',
          path: ['PARTICLE_LIVE_ENABLED'],
          message: 'Indexer reconciliation requires the reviewed live Particle profile',
        });
      }
      for (const name of [
        'NEXT_PUBLIC_PARTICLE_PROJECT_ID',
        'NEXT_PUBLIC_PARTICLE_CLIENT_KEY',
        'NEXT_PUBLIC_PARTICLE_APP_UUID',
        'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
        'PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH',
        'PARTICLE_RESPONSE_PROFILE_ID',
        'PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST',
        'PARTICLE_AUTH_FIXTURE_DIGEST',
        'PARTICLE_SUBMISSION_FIXTURE_DIGEST',
        'PARTICLE_STATUS_FIXTURE_DIGEST',
        'PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET',
        'PARTICLE_DELEGATION_PLAN_TTL_SECONDS',
      ] as const) {
        required(name, `${name} is required by indexer reconciliation`);
      }
      if (config.PARTICLE_ALLOWED_SOURCE_TOKENS.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['PARTICLE_ALLOWED_SOURCE_TOKENS'],
          message: 'Indexer reconciliation requires exact source-token policy',
        });
      }
      if (config.PARTICLE_SOURCE_CALL_PROFILES_JSON.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['PARTICLE_SOURCE_CALL_PROFILES_JSON'],
          message: 'Indexer reconciliation requires reviewed source-call profiles',
        });
      }
    }
    const productionLike = ['preview', 'staging', 'demo-mainnet', 'production'].includes(
      config.APP_ENV,
    );
    if (productionLike && config.DATABASE_URL_INDEXER !== undefined) {
      try {
        const url = new URL(config.DATABASE_URL_INDEXER);
        const sslModes = url.searchParams.getAll('sslmode');
        if (
          !['postgres:', 'postgresql:'].includes(url.protocol) ||
          sslModes.length !== 1 ||
          !['require', 'verify-ca', 'verify-full'].includes(sslModes[0] ?? '')
        ) {
          context.addIssue({
            code: 'custom',
            path: ['DATABASE_URL_INDEXER'],
            message: 'Production-like indexer PostgreSQL requires sslmode=require or stronger',
          });
        }
        if (url.username.length === 0 || url.password.length === 0) {
          context.addIssue({
            code: 'custom',
            path: ['DATABASE_URL_INDEXER'],
            message:
              'Production-like indexer PostgreSQL requires username and password authentication',
          });
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL_INDEXER'],
          message: 'DATABASE_URL_INDEXER must be a valid PostgreSQL URL',
        });
      }
    }
    if (productionLike && config.REDIS_URL !== undefined) {
      const url = new URL(config.REDIS_URL);
      const railwayPrivate =
        url.protocol === 'redis:' && url.hostname.endsWith('.railway.internal');
      if (url.protocol !== 'rediss:' && !railwayPrivate) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message: 'Public production-like indexer Redis requires TLS',
        });
      }
      if (url.password.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message: 'Production-like indexer Redis requires password authentication',
        });
      }
    }
    if (productionLike) {
      for (const name of ['ARBITRUM_RPC_URL', 'ARBITRUM_FALLBACK_RPC_URL'] as const) {
        const value = config[name];
        if (value !== undefined && new URL(value).protocol !== 'https:') {
          context.addIssue({
            code: 'custom',
            path: [name],
            message: 'Production-like indexer RPC URLs require HTTPS',
          });
        }
      }
    }
    if (config.APP_ENV === 'production') {
      if (config.INDEXER_DEPLOYMENT_BLOCK === 0n) {
        context.addIssue({
          code: 'custom',
          path: ['INDEXER_DEPLOYMENT_BLOCK'],
          message: 'Production indexer requires a reviewed deployment block',
        });
      }
      if (!config.INDEXER_RECONCILIATION_ENABLED) {
        context.addIssue({
          code: 'custom',
          path: ['INDEXER_RECONCILIATION_ENABLED'],
          message: 'Production indexer reconciliation cannot be disabled',
        });
      }
    }
  });

export type PublicEnvironment = z.infer<typeof PublicEnvironmentSchema>;
export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;
export type IndexerEnvironment = z.infer<typeof IndexerEnvironmentSchema>;
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

export interface ServerFeatureCapabilities {
  /** Provider/account reads that cannot authorize or submit value movement. */
  readonly particleReads: boolean;
  /** Checkout-session and policy-only preview preparation. */
  readonly checkoutPreview: boolean;
  /** Signed commercial intent creation and the new-submission boundary. */
  readonly checkoutSubmission: boolean;
  readonly merchantMutations: boolean;
  readonly refunds: boolean;
  readonly withdrawals: boolean;
  readonly splits: boolean;
  readonly bootstrapSponsor: boolean;
  readonly judgeMode: boolean;
}

/**
 * Derive server-authoritative capabilities without conflating provider reads,
 * non-spending preview, and value-movement authorization. Deterministic demo
 * execution remains an explicit local/test/preview capability and never makes
 * a live production payment possible.
 */
export function deriveServerFeatureCapabilities(
  config: Pick<
    ServerEnvironment,
    | 'PROVIDER_MODE'
    | 'DETERMINISTIC_DEMO_ENABLED'
    | 'PAYMENTS_ENABLED'
    | 'PARTICLE_LIVE_ENABLED'
    | 'MERCHANT_MUTATIONS_ENABLED'
    | 'REFUNDS_ENABLED'
    | 'WITHDRAWALS_ENABLED'
    | 'SPLITS_ENABLED'
    | 'BOOTSTRAP_SPONSOR_ENABLED'
    | 'JUDGE_MODE_ENABLED'
  >,
): ServerFeatureCapabilities {
  const deterministicDemo =
    config.PROVIDER_MODE === 'deterministic' && config.DETERMINISTIC_DEMO_ENABLED;
  const particleReads = config.PARTICLE_LIVE_ENABLED || deterministicDemo;
  return Object.freeze({
    particleReads,
    checkoutPreview: particleReads,
    checkoutSubmission: config.PAYMENTS_ENABLED || deterministicDemo,
    merchantMutations: config.MERCHANT_MUTATIONS_ENABLED,
    refunds: config.REFUNDS_ENABLED,
    withdrawals: config.WITHDRAWALS_ENABLED,
    splits: config.SPLITS_ENABLED,
    bootstrapSponsor: config.BOOTSTRAP_SPONSOR_ENABLED,
    judgeMode: config.JUDGE_MODE_ENABLED,
  });
}

export function parsePublicEnvironment(
  input: Record<string, string | undefined>,
): PublicEnvironment {
  return PublicEnvironmentSchema.parse(normalizePlatformEnvironment(input, 'public'));
}

export function parseFrontendFeatureEnvironment(input: Record<string, string | undefined>) {
  return FrontendFeatureEnvironmentSchema.parse(normalizePlatformEnvironment(input, 'frontend'));
}

export function parseServerEnvironment(
  input: Record<string, string | undefined>,
): ServerEnvironment {
  return ServerEnvironmentSchema.parse(normalizePlatformEnvironment(input, 'server'));
}

export function parseIndexerEnvironment(
  input: Record<string, string | undefined>,
): IndexerEnvironment {
  return IndexerEnvironmentSchema.parse(normalizePlatformEnvironment(input, 'indexer'));
}

export const OPEN_TAB_CONFIG_SCHEMA_VERSION = 12 as const;
