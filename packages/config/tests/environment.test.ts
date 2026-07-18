import { describe, expect, it } from 'vitest';
import {
  deriveServerFeatureCapabilities,
  parseFrontendFeatureEnvironment,
  parseIndexerEnvironment,
  parsePublicEnvironment,
  parseServerEnvironment,
  ServerEnvironmentSchema,
} from '../src/index.js';

const LIVE_CANARY_ENVIRONMENT = {
  APP_ENV: 'staging',
  NEXT_PUBLIC_APP_ENV: 'staging',
  NEXT_PUBLIC_APP_ORIGIN: 'https://staging.opentab.example',
  PROVIDER_MODE: 'live',
  DETERMINISTIC_DEMO_ENABLED: 'false',
  PAYMENTS_ENABLED: 'false',
  PARTICLE_LIVE_ENABLED: 'true',
  APPLICATION_RELEASE_ID: 'b'.repeat(40),
  MERCHANT_MUTATIONS_ENABLED: 'false',
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: 'pk_live_staging_opentab',
  NEXT_PUBLIC_PARTICLE_PROJECT_ID: 'particle-project-staging',
  NEXT_PUBLIC_PARTICLE_CLIENT_KEY: 'particle-client-staging',
  NEXT_PUBLIC_PARTICLE_APP_UUID: 'particle-app-staging',
  NEXT_PUBLIC_USDC_ADDRESS: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  NEXT_PUBLIC_CHECKOUT_ADDRESS: '0x1111111111111111111111111111111111111111',
  NEXT_PUBLIC_PASS_ADDRESS: '0x2222222222222222222222222222222222222222',
  ARBITRUM_RPC_URL: 'https://arb-primary.example/rpc',
  ARBITRUM_FALLBACK_RPC_URL: 'https://arb-fallback.example/rpc',
  PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: '0x3333333333333333333333333333333333333333',
  PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: `0x${'44'.repeat(32)}`,
  PARTICLE_RESPONSE_PROFILE_ID: 'recorded-live-staging-v1',
  PARTICLE_RESPONSE_PROFILE_PROVENANCE: 'recorded_live',
  PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: `0x${'51'.repeat(32)}`,
  PARTICLE_AUTH_FIXTURE_DIGEST: `0x${'52'.repeat(32)}`,
  PARTICLE_SUBMISSION_FIXTURE_DIGEST: `0x${'53'.repeat(32)}`,
  PARTICLE_STATUS_FIXTURE_DIGEST: `0x${'54'.repeat(32)}`,
  PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET: '0',
  PARTICLE_DELEGATION_PLAN_TTL_SECONDS: '300',
  PARTICLE_ALLOWED_SOURCE_TOKENS: '8453:USDC:0x5555555555555555555555555555555555555555',
  PARTICLE_SOURCE_CALL_PROFILES_JSON: JSON.stringify([
    {
      profileId: 'base-usdc-staging-v1',
      chainId: '8453',
      asset: 'USDC',
      tokenAddress: '0x5555555555555555555555555555555555555555',
      sourceAmount: '1.00',
      fixtureDigest: `0x${'56'.repeat(32)}`,
      calls: [
        {
          uaType: 'source-transfer',
          to: '0x5555555555555555555555555555555555555555',
          data: '0x',
          valueWei: '0',
        },
      ],
    },
  ]),
} as const;

const PRODUCTION_APPLICATION_ENVIRONMENT = {
  VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: 'opentab.example',
  VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: 'pk_live_opentab',
  MAGIC_SECRET_KEY: 'sk_live_opentab',
  DATABASE_URL: 'postgresql://runtime:secret@db.example/opentab?sslmode=verify-full',
  REDIS_URL: 'rediss://default:secret@redis.example:6380',
  OPENTAB_SECRET_ROOT: 'root-secret-material-that-is-at-least-32-bytes',
} as const;

const RAILWAY_INDEXER_ENVIRONMENT = {
  RAILWAY_SERVICE_ID: 'service-indexer',
  RAILWAY_ENVIRONMENT_NAME: 'production',
  PARTICLE_LIVE_ENABLED: 'true',
  DATABASE_URL_INDEXER: 'postgresql://indexer:secret@db.example/opentab?sslmode=verify-full',
  REDIS_URL: 'rediss://default:secret@redis.example:6380',
  ARBITRUM_RPC_URL: LIVE_CANARY_ENVIRONMENT.ARBITRUM_RPC_URL,
  ARBITRUM_FALLBACK_RPC_URL: LIVE_CANARY_ENVIRONMENT.ARBITRUM_FALLBACK_RPC_URL,
  NEXT_PUBLIC_CHECKOUT_ADDRESS: LIVE_CANARY_ENVIRONMENT.NEXT_PUBLIC_CHECKOUT_ADDRESS,
  NEXT_PUBLIC_PASS_ADDRESS: LIVE_CANARY_ENVIRONMENT.NEXT_PUBLIC_PASS_ADDRESS,
  INDEXER_DEPLOYMENT_BLOCK: '123456789',
  NEXT_PUBLIC_PARTICLE_PROJECT_ID: LIVE_CANARY_ENVIRONMENT.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
  NEXT_PUBLIC_PARTICLE_CLIENT_KEY: LIVE_CANARY_ENVIRONMENT.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
  NEXT_PUBLIC_PARTICLE_APP_UUID: LIVE_CANARY_ENVIRONMENT.NEXT_PUBLIC_PARTICLE_APP_UUID,
  NEXT_PUBLIC_USDC_ADDRESS: LIVE_CANARY_ENVIRONMENT.NEXT_PUBLIC_USDC_ADDRESS,
} as const;

it('keeps route fixtures disabled unless the dedicated demo flag is explicit', () => {
  expect(parseFrontendFeatureEnvironment({})).toMatchObject({
    environment: 'local',
    deterministicDemo: false,
    payments: false,
  });
  expect(
    parseFrontendFeatureEnvironment({ DETERMINISTIC_DEMO_ENABLED: 'true' }).deterministicDemo,
  ).toBe(true);
});

describe('platform environment normalization', () => {
  it('treats blank disabled live fields as absent in an initial Vercel deployment', () => {
    const server = parseServerEnvironment({
      ...PRODUCTION_APPLICATION_ENVIRONMENT,
      NEXT_PUBLIC_PARTICLE_PROJECT_ID: '',
      NEXT_PUBLIC_PARTICLE_CLIENT_KEY: '',
      NEXT_PUBLIC_PARTICLE_APP_UUID: '',
      NEXT_PUBLIC_CHECKOUT_ADDRESS: '',
      NEXT_PUBLIC_PASS_ADDRESS: '',
      NEXT_PUBLIC_SPLIT_ADDRESS: '',
      INDEXER_DEPLOYMENT_BLOCK: '',
    });

    expect(server).toMatchObject({
      PARTICLE_LIVE_ENABLED: false,
      PAYMENTS_ENABLED: false,
      NEXT_PUBLIC_PARTICLE_PROJECT_ID: 'REPLACE_ME',
      NEXT_PUBLIC_CHECKOUT_ADDRESS: '0x237E5Da5E0a1F7230E6AE93D737b9cecbcfDee91',
      INDEXER_DEPLOYMENT_BLOCK: 484_866_936n,
    });
  });

  it('derives production Vercel defaults without overriding explicit deployment inputs', () => {
    const server = parseServerEnvironment(PRODUCTION_APPLICATION_ENVIRONMENT);
    expect(server).toMatchObject({
      APP_ENV: 'production',
      NEXT_PUBLIC_APP_ENV: 'production',
      NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
      PROVIDER_MODE: 'live',
      APPLICATION_RELEASE_ID: 'a'.repeat(40),
    });
    expect(parsePublicEnvironment(PRODUCTION_APPLICATION_ENVIRONMENT)).toMatchObject({
      NEXT_PUBLIC_APP_ENV: 'production',
      NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
    });
    expect(parseFrontendFeatureEnvironment(PRODUCTION_APPLICATION_ENVIRONMENT)).toMatchObject({
      environment: 'production',
      providerMode: 'live',
    });

    expect(
      parseFrontendFeatureEnvironment({
        VERCEL_ENV: 'production',
        APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'preview',
        PROVIDER_MODE: 'deterministic',
      }),
    ).toMatchObject({ environment: 'preview', providerMode: 'deterministic' });
  });

  it('derives the preview origin from the Vercel deployment URL', () => {
    expect(
      parsePublicEnvironment({
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'opentab-git-feature.example.vercel.app',
      }),
    ).toMatchObject({
      NEXT_PUBLIC_APP_ENV: 'preview',
      NEXT_PUBLIC_APP_ORIGIN: 'https://opentab-git-feature.example.vercel.app',
    });
    expect(() =>
      parsePublicEnvironment({
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'https://opentab.example/path',
      }),
    ).toThrow();
  });

  it('starts a Railway indexer from stable Particle scope inputs without a release ID', () => {
    const indexer = parseIndexerEnvironment(RAILWAY_INDEXER_ENVIRONMENT);
    expect(indexer).toMatchObject({
      APP_ENV: 'production',
      INDEXER_ENABLED: true,
      INDEXER_WRITES_ENABLED: true,
      PARTICLE_LIVE_ENABLED: true,
      NEXT_PUBLIC_USDC_ADDRESS: LIVE_CANARY_ENVIRONMENT.NEXT_PUBLIC_USDC_ADDRESS,
    });
    expect(indexer).not.toHaveProperty('APPLICATION_RELEASE_ID');
    expect(
      parseIndexerEnvironment({
        RAILWAY_SERVICE_ID: 'service-indexer',
        RAILWAY_ENVIRONMENT_NAME: 'production',
        INDEXER_ENABLED: 'false',
        INDEXER_WRITES_ENABLED: 'false',
        PARTICLE_LIVE_ENABLED: 'false',
      }),
    ).toMatchObject({
      APP_ENV: 'production',
      INDEXER_ENABLED: false,
      INDEXER_WRITES_ENABLED: false,
      PARTICLE_LIVE_ENABLED: false,
    });
  });

  it('continues parsing optional legacy profile fields during the transition', () => {
    expect(
      parseServerEnvironment({
        ...LIVE_CANARY_ENVIRONMENT,
        PARTICLE_RESPONSE_PROFILE_PROVENANCE: undefined,
        PARTICLE_DELEGATION_PLAN_TTL_SECONDS: undefined,
      }),
    ).toMatchObject({
      PARTICLE_RESPONSE_PROFILE_PROVENANCE: 'recorded_live',
      PARTICLE_DELEGATION_PLAN_TTL_SECONDS: 300,
    });
    expect(parseIndexerEnvironment(RAILWAY_INDEXER_ENVIRONMENT)).not.toHaveProperty(
      'PARTICLE_RESPONSE_PROFILE_PROVENANCE',
    );
  });

  it('selects the managed signer automatically for production-like payments', () => {
    expect(
      parseServerEnvironment({
        ...LIVE_CANARY_ENVIRONMENT,
        PAYMENTS_ENABLED: 'true',
        MAGIC_SECRET_KEY: 'sk_live_staging_opentab',
        DATABASE_URL: 'postgresql://runtime:secret@db.example/opentab?sslmode=verify-full',
        REDIS_URL: 'rediss://default:secret@redis.example:6380',
        OPENTAB_SECRET_ROOT: 'root-secret-material-that-is-at-least-32-bytes',
        PLATFORM_FEE_BPS: '0',
        ORDER_SIGNER_KMS_KEY_ID: 'opentab-order-intents',
        ORDER_SIGNER_ADDRESS: '0x7777777777777777777777777777777777777777',
        AWS_KMS_REGION: 'eu-west-1',
        VERCEL_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/opentab-vercel-order-signer',
      }).ORDER_SIGNER_MODE,
    ).toBe('kms');
  });
});

describe('server environment safety', () => {
  it('keeps deterministic provider capabilities off when the server flag is omitted', () => {
    const config = parseServerEnvironment({});
    expect(config.DETERMINISTIC_DEMO_ENABLED).toBe(false);
    expect(deriveServerFeatureCapabilities(config)).toMatchObject({
      particleReads: false,
      checkoutPreview: false,
      checkoutSubmission: false,
      merchantMutations: true,
      refunds: false,
      withdrawals: false,
      splits: false,
      bootstrapSponsor: false,
      judgeMode: false,
    });
  });

  it('requires an exact Vercel application commit for live Judge evidence', () => {
    const base = {
      APP_ENV: 'demo-mainnet',
      NEXT_PUBLIC_APP_ENV: 'demo-mainnet',
      NEXT_PUBLIC_APP_ORIGIN: 'https://demo.opentab.example',
      PROVIDER_MODE: 'live',
      DETERMINISTIC_DEMO_ENABLED: 'false',
    } as const;
    expect(() => parseServerEnvironment(base)).toThrow(/APPLICATION_RELEASE_ID/);
    for (const releaseId of [
      'a'.repeat(39),
      'a'.repeat(41),
      'A'.repeat(40),
      ` ${'a'.repeat(40)}`,
      'main',
    ]) {
      expect(() =>
        parseServerEnvironment({ ...base, APPLICATION_RELEASE_ID: releaseId }),
      ).toThrow();
    }
    expect(
      parseServerEnvironment({ ...base, APPLICATION_RELEASE_ID: 'a'.repeat(40) })
        .APPLICATION_RELEASE_ID,
    ).toBe('a'.repeat(40));
    expect(() =>
      parseServerEnvironment({
        ...base,
        PROVIDER_MODE: 'deterministic',
        DETERMINISTIC_DEMO_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it('enables ordinary merchant mutations by default while retaining an explicit kill switch', () => {
    expect(
      parseServerEnvironment({ APP_ENV: 'local', NEXT_PUBLIC_APP_ENV: 'local' })
        .MERCHANT_MUTATIONS_ENABLED,
    ).toBe(true);
    expect(
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        MERCHANT_MUTATIONS_ENABLED: 'false',
      }).MERCHANT_MUTATIONS_ENABLED,
    ).toBe(false);
  });

  it('supports the guarded production-like Particle read/preview canary without a signer', () => {
    const config = parseServerEnvironment(LIVE_CANARY_ENVIRONMENT);
    const capabilities = deriveServerFeatureCapabilities(config);

    expect(config.ORDER_SIGNER_MODE).toBe('disabled');
    expect(capabilities).toMatchObject({
      particleReads: true,
      checkoutPreview: true,
      checkoutSubmission: false,
      merchantMutations: false,
      refunds: false,
      withdrawals: false,
      splits: false,
      bootstrapSponsor: false,
    });
  });

  it('requires an independent attestation secret for live Judge evidence', () => {
    const missing = ServerEnvironmentSchema.safeParse({
      ...LIVE_CANARY_ENVIRONMENT,
      JUDGE_MODE_ENABLED: 'true',
      JUDGE_SHARE_TOKEN_SECRET: 'judge-share-secret-that-is-at-least-32-bytes',
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'LIVE_ACCEPTANCE_ATTESTATION_SECRET',
      );
    }

    expect(() =>
      parseServerEnvironment({
        ...LIVE_CANARY_ENVIRONMENT,
        JUDGE_MODE_ENABLED: 'true',
        JUDGE_SHARE_TOKEN_SECRET: 'judge-share-secret-that-is-at-least-32-bytes',
        LIVE_ACCEPTANCE_ATTESTATION_SECRET: 'live-acceptance-secret-that-is-at-least-32-bytes',
      }),
    ).not.toThrow();
  });

  it('strips deployment-job and unused observability fields from the web contract', () => {
    const parsed = parseServerEnvironment({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      DATABASE_URL_MIGRATIONS: 'not-a-runtime-credential',
      DATABASE_URL_EVIDENCE_WRITER: 'not-a-runtime-credential',
      NEXT_PUBLIC_SENTRY_DSN: 'not-a-url',
      SENTRY_DSN: 'not-a-url',
      UPSTASH_REDIS_REST_TOKEN: 'unused',
    });
    expect(parsed).not.toHaveProperty('DATABASE_URL_MIGRATIONS');
    expect(parsed).not.toHaveProperty('DATABASE_URL_EVIDENCE_WRITER');
    expect(parsed).not.toHaveProperty('NEXT_PUBLIC_SENTRY_DSN');
    expect(parsed).not.toHaveProperty('SENTRY_DSN');
    expect(parsed).not.toHaveProperty('UPSTASH_REDIS_REST_TOKEN');
  });

  it('keeps the documented six-step canary capability order monotonic and fail closed', () => {
    const parsed = parseServerEnvironment(LIVE_CANARY_ENVIRONMENT);
    const base = {
      ...parsed,
      PARTICLE_LIVE_ENABLED: false,
      PAYMENTS_ENABLED: false,
      JUDGE_MODE_ENABLED: false,
      BOOTSTRAP_SPONSOR_ENABLED: false,
      MERCHANT_MUTATIONS_ENABLED: false,
      REFUNDS_ENABLED: false,
      WITHDRAWALS_ENABLED: false,
      SPLITS_ENABLED: false,
    };
    const indexerFirst = deriveServerFeatureCapabilities(base);
    const particleReadCanary = deriveServerFeatureCapabilities({
      ...base,
      PARTICLE_LIVE_ENABLED: true,
    });
    const judgeScoped = deriveServerFeatureCapabilities({
      ...base,
      PARTICLE_LIVE_ENABLED: true,
      JUDGE_MODE_ENABLED: true,
    });
    const paymentCanary = deriveServerFeatureCapabilities({
      ...base,
      PARTICLE_LIVE_ENABLED: true,
      JUDGE_MODE_ENABLED: true,
      PAYMENTS_ENABLED: true,
    });
    const sponsorCanary = deriveServerFeatureCapabilities({
      ...base,
      PARTICLE_LIVE_ENABLED: true,
      JUDGE_MODE_ENABLED: true,
      PAYMENTS_ENABLED: true,
      BOOTSTRAP_SPONSOR_ENABLED: true,
    });

    expect(indexerFirst).toMatchObject({
      particleReads: false,
      checkoutPreview: false,
      checkoutSubmission: false,
    });
    expect(particleReadCanary).toMatchObject({
      particleReads: true,
      checkoutPreview: true,
      checkoutSubmission: false,
    });
    expect(judgeScoped.judgeMode).toBe(true);
    expect(paymentCanary.checkoutSubmission).toBe(true);
    expect(sponsorCanary.bootstrapSponsor).toBe(true);
    expect(sponsorCanary).toMatchObject({
      merchantMutations: false,
      refunds: false,
      withdrawals: false,
      splits: false,
    });
  });

  it('requires an exact credential-free application origin', () => {
    for (const origin of [
      'https://user:secret@opentab.example',
      'https://opentab.example/',
      'https://opentab.example/path',
      'https://opentab.example?query=1',
      'https://opentab.example#fragment',
    ]) {
      expect(() =>
        parseServerEnvironment({
          APP_ENV: 'preview',
          NEXT_PUBLIC_APP_ENV: 'preview',
          NEXT_PUBLIC_APP_ORIGIN: origin,
        }),
      ).toThrow();
    }
    expect(
      parseServerEnvironment({
        APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
      }).NEXT_PUBLIC_APP_ORIGIN,
    ).toBe('https://opentab.example');
  });

  it('rejects ambiguous duplicate PostgreSQL sslmode values', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
        DATABASE_URL: 'postgresql://user:pass@db.example/opentab?sslmode=require&sslmode=disable',
      }),
    ).toThrow();
    expect(() =>
      parseIndexerEnvironment({
        APP_ENV: 'preview',
        INDEXER_ENABLED: 'true',
        INDEXER_WRITES_ENABLED: 'false',
        INDEXER_RECONCILIATION_ENABLED: 'false',
        DATABASE_URL_INDEXER:
          'postgresql://user:pass@db.example/opentab?sslmode=require&sslmode=disable',
        ARBITRUM_RPC_URL: 'https://arb-primary.example/rpc',
        ARBITRUM_FALLBACK_RPC_URL: 'https://arb-fallback.example/rpc',
        NEXT_PUBLIC_CHECKOUT_ADDRESS: '0x1111111111111111111111111111111111111111',
        NEXT_PUBLIC_PASS_ADDRESS: '0x2222222222222222222222222222222222222222',
        PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: '0x3333333333333333333333333333333333333333',
      }),
    ).toThrow();
  });

  it('requires username and password authentication for production-like PostgreSQL', () => {
    for (const databaseUrl of [
      'postgresql://db.example/opentab?sslmode=require',
      'postgresql://user@db.example/opentab?sslmode=require',
      'postgresql://:pass@db.example/opentab?sslmode=require',
    ]) {
      expect(() =>
        parseServerEnvironment({
          APP_ENV: 'preview',
          NEXT_PUBLIC_APP_ENV: 'preview',
          NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
          DATABASE_URL: databaseUrl,
        }),
      ).toThrow(/username and password/);
      expect(() =>
        parseIndexerEnvironment({
          APP_ENV: 'preview',
          INDEXER_ENABLED: 'true',
          INDEXER_WRITES_ENABLED: 'false',
          INDEXER_RECONCILIATION_ENABLED: 'false',
          DATABASE_URL_INDEXER: databaseUrl,
          ARBITRUM_RPC_URL: 'https://arb-primary.example/rpc',
          ARBITRUM_FALLBACK_RPC_URL: 'https://arb-fallback.example/rpc',
          NEXT_PUBLIC_CHECKOUT_ADDRESS: '0x1111111111111111111111111111111111111111',
          NEXT_PUBLIC_PASS_ADDRESS: '0x2222222222222222222222222222222222222222',
          PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: '0x3333333333333333333333333333333333333333',
        }),
      ).toThrow(/username and password/);
    }
    expect(
      parseServerEnvironment({
        APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
        DATABASE_URL: 'postgresql://user:pass@db.example/opentab?sslmode=verify-full',
      }).DATABASE_URL,
    ).toContain('user:pass');
  });
  it('accepts explicit deterministic local mode with money flags off', () => {
    const config = parseServerEnvironment({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      PROVIDER_MODE: 'deterministic',
      DETERMINISTIC_DEMO_ENABLED: 'true',
      PAYMENTS_ENABLED: 'false',
    });
    expect(config.PROVIDER_MODE).toBe('deterministic');
    expect(config.PAYMENTS_ENABLED).toBe(false);
    expect(config.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS).toEqual(['1', '8453', '42161']);
    expect(config.PARTICLE_ALLOWED_SOURCE_ASSETS).toEqual(['USDC', 'USDT', 'ETH']);
    expect(config.PARTICLE_ALLOWED_SOURCE_TOKENS).toEqual([]);
    expect(config.PARTICLE_MAX_FEE_USD_MICROS).toBe(5_000_000n);
    expect(config.PARTICLE_RESPONSE_PROFILE_PROVENANCE).toBe('deterministic');
    expect(config.SPLIT_SIGNER_MODE).toBe('disabled');
  });

  it('rejects deterministic production and unsafe private-key signer modes', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'production',
        NEXT_PUBLIC_APP_ENV: 'production',
        NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
        PROVIDER_MODE: 'deterministic',
        DETERMINISTIC_DEMO_ENABLED: 'true',
        SPONSOR_SIGNER_MODE: 'private-key',
        SPLIT_SIGNER_MODE: 'private-key',
      }),
    ).toThrow();
  });

  it.each([
    'preview',
    'staging',
    'demo-mainnet',
    'production',
  ] as const)('rejects private-key sponsor signers in production-like %s', (environment) => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: environment,
        NEXT_PUBLIC_APP_ENV: environment,
        NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
        SPONSOR_SIGNER_MODE: 'private-key',
      }),
    ).toThrow(/local\/test/);
  });

  it.each(['preview', 'staging', 'production'] as const)(
    'rejects private-key order signing in %s even with the demo opt-in',
    (environment) => {
      expect(() =>
        parseServerEnvironment({
          APP_ENV: environment,
          NEXT_PUBLIC_APP_ENV: environment,
          NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
          PROVIDER_MODE: 'live',
          DEMO_PRIVATE_KEY_ORDER_SIGNER_ENABLED: 'true',
          ORDER_SIGNER_MODE: 'private-key',
        }),
      ).toThrow(/demo-mainnet/);
    },
  );

  it('requires an explicit opt-in for demo-mainnet private-key order signing', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'demo-mainnet',
        NEXT_PUBLIC_APP_ENV: 'demo-mainnet',
        NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
        PROVIDER_MODE: 'live',
        ORDER_SIGNER_MODE: 'private-key',
      }),
    ).toThrow(/explicit demo-mainnet opt-in/);
  });

  it('allows only the dedicated order signer in an explicit demo-mainnet payment canary', () => {
    const config = parseServerEnvironment({
      ...LIVE_CANARY_ENVIRONMENT,
      APP_ENV: 'demo-mainnet',
      NEXT_PUBLIC_APP_ENV: 'demo-mainnet',
      NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
      APPLICATION_RELEASE_ID: 'b'.repeat(40),
      PARTICLE_CERTIFICATION_TOKEN: 'particle-certification-token-at-least-32-characters',
      PAYMENTS_ENABLED: 'true',
      MAGIC_SECRET_KEY: 'sk_live_demo_opentab',
      DATABASE_URL: 'postgresql://runtime:secret@db.example/opentab?sslmode=verify-full',
      REDIS_URL: 'rediss://default:secret@redis.example:6380',
      OPENTAB_SECRET_ROOT: 'root-secret-material-that-is-at-least-32-bytes',
      PLATFORM_FEE_BPS: '0',
      DEMO_PRIVATE_KEY_ORDER_SIGNER_ENABLED: 'true',
      ORDER_SIGNER_MODE: 'private-key',
      ORDER_SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      ORDER_SIGNER_ADDRESS: '0x7777777777777777777777777777777777777777',
    });

    expect(config).toMatchObject({
      APP_ENV: 'demo-mainnet',
      DEMO_PRIVATE_KEY_ORDER_SIGNER_ENABLED: true,
      ORDER_SIGNER_MODE: 'private-key',
      SPONSOR_SIGNER_MODE: 'disabled',
      SPLIT_SIGNER_MODE: 'disabled',
    });
  });

  it('keeps order and split signing roles independently configured', () => {
    const result = parseServerEnvironment;
    expect(() =>
      result({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        SPLITS_ENABLED: 'true',
        ORDER_SIGNER_ADDRESS: '0x1111111111111111111111111111111111111111',
        SPLIT_SIGNER_MODE: 'kms',
        SPLIT_SIGNER_KEY_ID: 'split-intents-local',
        SPLIT_SIGNER_EXPECTED_ADDRESS: '0x1111111111111111111111111111111111111111',
      }),
    ).toThrow(/separate signing roles/);
  });

  it('rejects enabled payments without provider, chain, session, and signer dependencies', () => {
    const result = ServerEnvironmentSchema.safeParse({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      PAYMENTS_ENABLED: 'true',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('PLATFORM_FEE_BPS');
  });

  it('accepts only an exact integer platform fee within the contract cap', () => {
    expect(
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PLATFORM_FEE_BPS: '0',
      }).PLATFORM_FEE_BPS,
    ).toBe(0);
    for (const value of ['-1', '1.5', '501']) {
      expect(() =>
        parseServerEnvironment({
          APP_ENV: 'local',
          NEXT_PUBLIC_APP_ENV: 'local',
          PLATFORM_FEE_BPS: value,
        }),
      ).toThrow();
    }
  });

  it('rejects placeholder vendor values when money movement is enabled', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PROVIDER_MODE: 'live',
        PAYMENTS_ENABLED: 'true',
        PARTICLE_LIVE_ENABLED: 'true',
        NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: 'pk_live_REPLACE_ME',
        NEXT_PUBLIC_PARTICLE_PROJECT_ID: 'REPLACE_ME',
      }),
    ).toThrow();
  });

  it('rejects risky dependent features when the payment kill switch is off', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PAYMENTS_ENABLED: 'false',
        REFUNDS_ENABLED: 'true',
        WITHDRAWALS_ENABLED: 'true',
        SPLITS_ENABLED: 'true',
      }),
    ).toThrow();
  });

  it('rejects short security peppers even when the related feature is disabled', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        SESSION_HASH_PEPPER: 'too-short',
      }),
    ).toThrow();
  });

  it('accepts one domain-separated root as the production security-secret source', () => {
    const config = parseServerEnvironment(PRODUCTION_APPLICATION_ENVIRONMENT);
    expect(config.OPENTAB_SECRET_ROOT).toBe(PRODUCTION_APPLICATION_ENVIRONMENT.OPENTAB_SECRET_ROOT);
    expect(config.SESSION_HASH_PEPPER).toBeUndefined();
    expect(config.CSRF_SECRET).toBeUndefined();
    expect(config.CAPABILITY_TOKEN_PEPPER).toBeUndefined();
    expect(config.PRIVACY_SUBJECT_HASH_SECRET).toBeUndefined();

    for (const value of ['short', 'REPLACE_WITH_32_PLUS_RANDOM_BYTES']) {
      expect(() =>
        parseServerEnvironment({
          APP_ENV: 'local',
          NEXT_PUBLIC_APP_ENV: 'local',
          OPENTAB_SECRET_ROOT: value,
        }),
      ).toThrow(/OPENTAB_SECRET_ROOT/);
    }
  });

  it('accepts the root substitute at payment, split, and sponsor security boundaries', () => {
    for (const feature of [
      { PAYMENTS_ENABLED: 'true' },
      { SPLITS_ENABLED: 'true' },
      { BOOTSTRAP_SPONSOR_ENABLED: 'true' },
    ] as const) {
      const result = ServerEnvironmentSchema.safeParse({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        OPENTAB_SECRET_ROOT: PRODUCTION_APPLICATION_ENVIRONMENT.OPENTAB_SECRET_ROOT,
        ...feature,
      });
      expect(result.success).toBe(false);
      if (result.success) continue;
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).not.toContain('SESSION_HASH_PEPPER');
      expect(paths).not.toContain('CSRF_SECRET');
      expect(paths).not.toContain('CAPABILITY_TOKEN_PEPPER');
      expect(paths).not.toContain('PRIVACY_SUBJECT_HASH_SECRET');
    }
  });

  it('rejects reused security-domain secrets', () => {
    const reused = 'independent-secrets-must-not-share-this-value';
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        SESSION_HASH_PEPPER: reused,
        PRIVACY_SUBJECT_HASH_SECRET: reused,
      }),
    ).toThrow(/must be independent/);
  });

  it('rejects duplicate or unsupported Particle source policy entries', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: '1,1,42161',
      }),
    ).toThrow();
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PARTICLE_ALLOWED_SOURCE_ASSETS: 'USDC,DAI',
      }),
    ).toThrow();
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PARTICLE_ALLOWED_SOURCE_TOKENS:
          '8453:USDC:0x1111111111111111111111111111111111111111,8453:USDC:0x1111111111111111111111111111111111111111',
      }),
    ).toThrow(/unique/);
  });

  it('requires a region, reviewed address, and fee cap for managed signer modes', () => {
    const result = ServerEnvironmentSchema.safeParse({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      SPONSOR_SIGNER_MODE: 'kms',
      SPONSOR_KMS_KEY_ID: 'sponsor-key',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('AWS_KMS_REGION');
    expect(paths).toContain('VERCEL_AWS_ROLE_ARN');
  });

  it('validates the exact Vercel OIDC AWS role ARN boundary', () => {
    expect(() =>
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        VERCEL_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:user/not-a-role',
      }),
    ).toThrow();
    expect(
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        VERCEL_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/opentab/vercel-web',
      }).VERCEL_AWS_ROLE_ARN,
    ).toBe('arn:aws:iam::123456789012:role/opentab/vercel-web');
  });

  it('parses exact Particle source tokens for authoritative preview policy', () => {
    const config = parseServerEnvironment({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      PARTICLE_ALLOWED_SOURCE_TOKENS: '8453:USDC:0x1111111111111111111111111111111111111111',
    });
    expect(config.PARTICLE_ALLOWED_SOURCE_TOKENS).toEqual([
      {
        chainId: '8453',
        asset: 'USDC',
        address: '0x1111111111111111111111111111111111111111',
      },
    ]);
  });

  it('returns Zod issues for malformed product media origins instead of throwing', () => {
    for (const value of [
      'not-a-url',
      'https://user:secret@media.example',
      'https://media.example/path',
      'http://media.example',
      'https://media.example,https://media.example',
    ]) {
      const result = ServerEnvironmentSchema.safeParse({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PRODUCT_MEDIA_ALLOWED_ORIGINS: value,
      });
      expect(result.success).toBe(false);
    }
    expect(
      parseServerEnvironment({
        APP_ENV: 'local',
        NEXT_PUBLIC_APP_ENV: 'local',
        PRODUCT_MEDIA_ALLOWED_ORIGINS: 'https://media.example,https://images.example',
      }).PRODUCT_MEDIA_ALLOWED_ORIGINS,
    ).toEqual(['https://media.example', 'https://images.example']);
  });

  it('does not duplicate central Particle profile or source policy requirements in environment', () => {
    const env: Record<string, string | undefined> = { ...LIVE_CANARY_ENVIRONMENT };
    for (const name of [
      'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
      'PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH',
      'PARTICLE_RESPONSE_PROFILE_ID',
      'PARTICLE_RESPONSE_PROFILE_PROVENANCE',
      'PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST',
      'PARTICLE_AUTH_FIXTURE_DIGEST',
      'PARTICLE_SUBMISSION_FIXTURE_DIGEST',
      'PARTICLE_STATUS_FIXTURE_DIGEST',
      'PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET',
      'PARTICLE_DELEGATION_PLAN_TTL_SECONDS',
      'PARTICLE_ALLOWED_SOURCE_CHAIN_IDS',
      'PARTICLE_ALLOWED_SOURCE_ASSETS',
      'PARTICLE_ALLOWED_SOURCE_TOKENS',
      'PARTICLE_SOURCE_CALL_PROFILES_JSON',
    ]) {
      delete env[name];
    }

    expect(() => parseServerEnvironment(env)).not.toThrow();
  });

  it('rejects primary and fallback Arbitrum URLs on the same provider host', () => {
    const result = ServerEnvironmentSchema.safeParse({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      PROVIDER_MODE: 'live',
      PAYMENTS_ENABLED: 'true',
      PARTICLE_LIVE_ENABLED: 'true',
      ARBITRUM_RPC_URL: 'https://rpc.example/v1/primary',
      ARBITRUM_FALLBACK_RPC_URL: 'https://rpc.example/v1/fallback',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['ARBITRUM_FALLBACK_RPC_URL'] })]),
    );
  });

  it('allows Railway private Redis but requires TLS for public production-like Redis', () => {
    expect(
      ServerEnvironmentSchema.safeParse({
        APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ORIGIN: 'https://preview.opentab.example',
        REDIS_URL: 'redis://default:test-password@redis.railway.internal:6379',
      }).success,
    ).toBe(true);
    for (const url of [
      'redis://public.proxy.rlwy.net:12345',
      'redis://railway.internal.attacker.example:6379',
      'redis://redis.railway.internal:6379',
      'rediss://public.redis.example:6380',
    ]) {
      const result = ServerEnvironmentSchema.safeParse({
        APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ORIGIN: 'https://preview.opentab.example',
        REDIS_URL: url,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('REDIS_URL');
      }
    }
    expect(
      ServerEnvironmentSchema.safeParse({
        APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'preview',
        NEXT_PUBLIC_APP_ORIGIN: 'https://preview.opentab.example',
        REDIS_URL: 'rediss://default:test-password@public.redis.example:6380',
      }).success,
    ).toBe(true);
  });

  it('keeps the Vercel application release ID for live-payment and Judge evidence', () => {
    const result = ServerEnvironmentSchema.safeParse({
      ...LIVE_CANARY_ENVIRONMENT,
      APPLICATION_RELEASE_ID: undefined,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('APPLICATION_RELEASE_ID');

    const paymentsOnly = ServerEnvironmentSchema.safeParse({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      PAYMENTS_ENABLED: 'true',
      APPLICATION_RELEASE_ID: undefined,
    });
    expect(paymentsOnly.success).toBe(false);
    if (!paymentsOnly.success) {
      expect(paymentsOnly.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'APPLICATION_RELEASE_ID',
      );
    }
  });

  it('requires a strong server-only certification token for prod-like live Particle mode', () => {
    const base = {
      ...LIVE_CANARY_ENVIRONMENT,
      APP_ENV: 'demo-mainnet',
      NEXT_PUBLIC_APP_ENV: 'demo-mainnet',
    } as const;
    const missing = ServerEnvironmentSchema.safeParse(base);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'PARTICLE_CERTIFICATION_TOKEN',
      );
    }
    expect(() =>
      parseServerEnvironment({
        ...base,
        PARTICLE_CERTIFICATION_TOKEN: 'particle-certification-token-at-least-32-characters',
      }),
    ).not.toThrow();
  });
});
