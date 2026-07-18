import { z } from 'zod';
import { ARBITRUM_ONE_CHAIN_ID, ChainIdSchema, EvmAddressSchema } from './address.js';
import { digestUnknown } from './evidence-digest.js';
import {
  Bytes32Schema,
  EvidenceDigestSchema,
  PaymentAttemptIdSchema,
  TransactionHashSchema,
} from './ids.js';
import { BaseUnitAmountSchema, UnsignedIntegerStringSchema } from './money.js';

export const PARTICLE_COMPATIBILITY_PROFILE_VERSION = 1 as const;
export const PARTICLE_CERTIFICATION_CANARY_MAX_BASE_UNITS = 1_000_000n;

const ParticleEnvironmentSchema = z.enum(['demo-mainnet', 'production']);
const ParticleProfileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/);
const ApplicationReleaseIdSchema = z.string().regex(/^[0-9a-fA-F]{40}$/);
export const ParticleCompatibilityScopeIdSchema = z.string().regex(/^[0-9a-f]{40}$/);
const ParticleChainIdSchema = ChainIdSchema.refine(
  (value) => value === ARBITRUM_ONE_CHAIN_ID,
  'Particle certification is restricted to Arbitrum One',
);
const ParticleAssetSchema = z.enum(['USDC', 'USDT', 'ETH']);
const FunctionSelectorSchema = z.string().regex(/^0x[0-9a-fA-F]{8}$/);

export const ParticleCompatibilityStageSchema = z.enum(['bootstrap', 'canary_ready', 'certified']);
export type ParticleCompatibilityStage = z.infer<typeof ParticleCompatibilityStageSchema>;

export const ParticleResponseDigestsSchema = z
  .object({
    deployments: EvidenceDigestSchema,
    auth: EvidenceDigestSchema,
    submission: EvidenceDigestSchema.optional(),
    status: EvidenceDigestSchema.optional(),
  })
  .strict();

export const ParticleNonceConventionSchema = z
  .object({
    magicAuthorizationNonceOffset: z.union([z.literal(0), z.literal(1)]),
    delegationPlanTtlSeconds: z.number().int().min(30).max(600),
  })
  .strict();

export const ParticleSourceTokenProfileSchema = z
  .object({
    allowedSourceChainIds: z.array(ChainIdSchema).min(2).max(30),
    allowedSourceAssets: z.array(ParticleAssetSchema).min(1).max(3),
    allowedSourceTokens: z
      .array(
        z
          .object({
            chainId: ChainIdSchema,
            asset: ParticleAssetSchema,
            address: EvmAddressSchema,
          })
          .strict(),
      )
      .min(1)
      .max(60),
    /**
     * Reusable source-call policy. It intentionally excludes user amounts and
     * full calldata; those remain dynamically bound to the server-issued
     * payment amount and fee policy. The fixture digest is evidence only.
     */
    sourceCallPolicies: z
      .array(
        z
          .object({
            policyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
            chainId: ChainIdSchema,
            asset: ParticleAssetSchema,
            tokenAddress: EvmAddressSchema,
            uaType: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
            target: EvmAddressSchema,
            functionSelector: FunctionSelectorSchema,
            nativeValueAllowed: z.boolean(),
            maxCalls: z.number().int().min(1).max(16),
            capturedFixtureDigest: EvidenceDigestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict()
  .superRefine((value, context) => {
    const chainIds = new Set(value.allowedSourceChainIds);
    const assets = new Set(value.allowedSourceAssets);
    if (chainIds.size !== value.allowedSourceChainIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['allowedSourceChainIds'],
        message: 'Source chain IDs must be unique',
      });
    }
    if (!chainIds.has(ARBITRUM_ONE_CHAIN_ID)) {
      context.addIssue({
        code: 'custom',
        path: ['allowedSourceChainIds'],
        message: 'Source policy must retain the Arbitrum settlement chain',
      });
    }
    if (![...chainIds].some((chainId) => chainId !== ARBITRUM_ONE_CHAIN_ID)) {
      context.addIssue({
        code: 'custom',
        path: ['allowedSourceChainIds'],
        message: 'Canary policy requires at least one non-Arbitrum source chain',
      });
    }
    if (assets.size !== value.allowedSourceAssets.length) {
      context.addIssue({
        code: 'custom',
        path: ['allowedSourceAssets'],
        message: 'Source assets must be unique',
      });
    }

    const tokenKeys = new Set<string>();
    for (const [index, token] of value.allowedSourceTokens.entries()) {
      if (!chainIds.has(token.chainId) || !assets.has(token.asset)) {
        context.addIssue({
          code: 'custom',
          path: ['allowedSourceTokens', index],
          message: 'Source token exceeds its chain or asset allowlist',
        });
      }
      const key = `${token.chainId}:${token.asset}:${token.address.toLowerCase()}`;
      if (tokenKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['allowedSourceTokens', index],
          message: 'Source token policy is duplicated',
        });
      }
      tokenKeys.add(key);
    }

    const policyIds = new Set<string>();
    const fixtureDigests = new Set<string>();
    for (const [index, policy] of value.sourceCallPolicies.entries()) {
      if (
        policy.chainId === ARBITRUM_ONE_CHAIN_ID ||
        !chainIds.has(policy.chainId) ||
        !assets.has(policy.asset)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['sourceCallPolicies', index],
          message: 'Source-call policy exceeds its non-Arbitrum allowlist',
        });
      }
      if (
        !value.allowedSourceTokens.some(
          (token) =>
            token.chainId === policy.chainId &&
            token.asset === policy.asset &&
            token.address.toLowerCase() === policy.tokenAddress.toLowerCase(),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['sourceCallPolicies', index, 'tokenAddress'],
          message: 'Source-call policy is not bound to an allowed token',
        });
      }
      if (policyIds.has(policy.policyId)) {
        context.addIssue({
          code: 'custom',
          path: ['sourceCallPolicies', index, 'policyId'],
          message: 'Source-call policy ID is duplicated',
        });
      }
      const fixtureDigest = policy.capturedFixtureDigest.toLowerCase();
      if (fixtureDigests.has(fixtureDigest)) {
        context.addIssue({
          code: 'custom',
          path: ['sourceCallPolicies', index, 'capturedFixtureDigest'],
          message: 'Source-call evidence digest is duplicated',
        });
      }
      policyIds.add(policy.policyId);
      fixtureDigests.add(fixtureDigest);
    }
  });

export const ParticleCanonicalCanaryEvidenceSchema = z
  .object({
    paymentAttemptId: PaymentAttemptIdSchema,
    orderKey: Bytes32Schema,
    transactionHash: TransactionHashSchema,
    blockHash: Bytes32Schema,
    acceptanceEvidenceDigest: EvidenceDigestSchema,
  })
  .strict();

/**
 * Sanitized, immutable Particle/Magic compatibility evidence. It contains no
 * authenticated wallet address, credentials, signatures, or raw vendor
 * response. Each stable Particle/deployment scope advances by appending a new,
 * stricter stage and can be reused across ordinary Git redeploys.
 */
export const ParticleCompatibilityProfileSchema = z
  .object({
    schemaVersion: z.literal(PARTICLE_COMPATIBILITY_PROFILE_VERSION),
    profileId: ParticleProfileIdSchema,
    stage: ParticleCompatibilityStageSchema,
    environment: ParticleEnvironmentSchema,
    chainId: ParticleChainIdSchema,
    particleSdkVersion: z.literal('2.0.3'),
    particleProtocolVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/),
    particleProjectConfigDigest: EvidenceDigestSchema,
    useEIP7702: z.literal(true),
    delegateAddress: EvmAddressSchema,
    delegateCodeHash: EvidenceDigestSchema,
    responseDigests: ParticleResponseDigestsSchema,
    nonceConvention: ParticleNonceConventionSchema,
    sourceTokenProfile: ParticleSourceTokenProfileSchema.optional(),
    canonicalCanaryEvidence: ParticleCanonicalCanaryEvidenceSchema.optional(),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasSubmission = value.responseDigests.submission !== undefined;
    const hasStatus = value.responseDigests.status !== undefined;
    if (hasSubmission !== hasStatus) {
      context.addIssue({
        code: 'custom',
        path: ['responseDigests'],
        message: 'Submission and status digests must be recorded together',
      });
    }
    if (value.stage === 'bootstrap') {
      if (hasSubmission || value.sourceTokenProfile || value.canonicalCanaryEvidence) {
        context.addIssue({
          code: 'custom',
          path: ['stage'],
          message: 'Bootstrap evidence must not claim canary or submission evidence',
        });
      }
      return;
    }
    if (value.sourceTokenProfile === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['sourceTokenProfile'],
        message: 'Canary-ready evidence requires a reviewed source-token policy',
      });
    }
    if (value.stage === 'canary_ready') {
      if (hasSubmission || value.canonicalCanaryEvidence) {
        context.addIssue({
          code: 'custom',
          path: ['stage'],
          message: 'Canary-ready evidence must remain pre-submission evidence',
        });
      }
      return;
    }
    if (!hasSubmission || value.canonicalCanaryEvidence === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['stage'],
        message: 'Certified evidence requires submission, status, and canonical canary proof',
      });
    }
  });

export type ParticleCompatibilityProfile = z.infer<typeof ParticleCompatibilityProfileSchema>;

const CanaryMaxBaseUnitsSchema = BaseUnitAmountSchema.refine(
  (value) => BigInt(value) > 0n && BigInt(value) <= PARTICLE_CERTIFICATION_CANARY_MAX_BASE_UNITS,
  'Particle canary cap must be between one base unit and 1 USDC',
);

export const ParticleProfileReleaseBindingSchema = z
  .object({
    schemaVersion: z.literal(PARTICLE_COMPATIBILITY_PROFILE_VERSION),
    environment: ParticleEnvironmentSchema,
    /** Legacy storage name; contains the stable Particle compatibility scope ID. */
    applicationReleaseId: ApplicationReleaseIdSchema,
    chainId: ParticleChainIdSchema,
    stage: ParticleCompatibilityStageSchema,
    profileId: ParticleProfileIdSchema,
    profileDigest: EvidenceDigestSchema,
    certifiedSubjectHash: EvidenceDigestSchema,
    canaryProductId: UnsignedIntegerStringSchema.refine(
      (value) => BigInt(value) > 0n,
      'Canary product ID must be positive',
    ),
    canaryMaxBaseUnits: CanaryMaxBaseUnitsSchema,
    boundAt: z.string().datetime(),
  })
  .strict();

export type ParticleProfileReleaseBinding = z.infer<typeof ParticleProfileReleaseBindingSchema>;

const ParticleProjectConfigurationSchema = z
  .object({
    projectId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim() === value),
    projectClientKey: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim() === value),
    projectAppUuid: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim() === value),
  })
  .strict();

/** Binds compatibility evidence to one exact public Particle project tuple. */
export function digestParticleProjectConfiguration(input: {
  readonly projectId: string;
  readonly projectClientKey: string;
  readonly projectAppUuid: string;
}) {
  const parsed = ParticleProjectConfigurationSchema.parse(input);
  return EvidenceDigestSchema.parse(
    digestUnknown({
      domain: 'opentab/particle-project-configuration',
      projectId: parsed.projectId,
      projectClientKey: parsed.projectClientKey,
      projectAppUuid: parsed.projectAppUuid,
    }),
  );
}

/**
 * Stable database scope for one Particle project configuration. Unlike a Git
 * release ID, this intentionally survives web and indexer redeploys. Rotating
 * any Particle project identifier produces a new scope and requires a new
 * compatibility canary.
 */
export function deriveParticleCompatibilityScopeId(input: {
  readonly environment: 'demo-mainnet' | 'production';
  readonly chainId: string;
  readonly projectId: string;
  readonly projectClientKey: string;
  readonly projectAppUuid: string;
  readonly checkoutAddress: string;
  readonly passAddress: string;
  readonly tokenAddress: string;
}) {
  const projectDigest = digestParticleProjectConfiguration({
    projectId: input.projectId,
    projectClientKey: input.projectClientKey,
    projectAppUuid: input.projectAppUuid,
  });
  const environment = ParticleEnvironmentSchema.parse(input.environment);
  const chainId = ParticleChainIdSchema.parse(input.chainId);
  const checkoutAddress = EvmAddressSchema.parse(input.checkoutAddress).toLowerCase();
  const passAddress = EvmAddressSchema.parse(input.passAddress).toLowerCase();
  const tokenAddress = EvmAddressSchema.parse(input.tokenAddress).toLowerCase();
  const scopeDigest = digestUnknown({
    domain: 'opentab/particle-compatibility-scope',
    schemaVersion: PARTICLE_COMPATIBILITY_PROFILE_VERSION,
    particleSdkVersion: '2.0.3',
    projectDigest,
    environment,
    chainId,
    checkoutAddress,
    passAddress,
    tokenAddress,
  });
  return ParticleCompatibilityScopeIdSchema.parse(scopeDigest.slice(2, 42).toLowerCase());
}

function compareChainIds(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function canonicalSourceTokenProfile(
  profile: z.infer<typeof ParticleSourceTokenProfileSchema>,
): unknown {
  return {
    allowedSourceChainIds: [...profile.allowedSourceChainIds].sort(compareChainIds),
    allowedSourceAssets: [...profile.allowedSourceAssets].sort(),
    allowedSourceTokens: [...profile.allowedSourceTokens]
      .map((token) => ({ ...token, address: token.address.toLowerCase() }))
      .sort((left, right) =>
        `${left.chainId}:${left.asset}:${left.address}`.localeCompare(
          `${right.chainId}:${right.asset}:${right.address}`,
        ),
      ),
    sourceCallPolicies: [...profile.sourceCallPolicies]
      .map((policy) => ({
        ...policy,
        tokenAddress: policy.tokenAddress.toLowerCase(),
        target: policy.target.toLowerCase(),
        functionSelector: policy.functionSelector.toLowerCase(),
        capturedFixtureDigest: policy.capturedFixtureDigest.toLowerCase(),
      }))
      .sort((left, right) => left.policyId.localeCompare(right.policyId)),
  };
}

/**
 * Computes the content identity for a profile. The human-readable profile ID
 * is deliberately excluded; every address/digest and unordered policy set is
 * canonicalized first so equivalent reviewed evidence has one digest.
 */
export function digestParticleCompatibilityProfile(input: unknown) {
  const profile = ParticleCompatibilityProfileSchema.parse(input);
  return EvidenceDigestSchema.parse(
    digestUnknown({
      domain: 'opentab/particle-compatibility-profile',
      schemaVersion: profile.schemaVersion,
      stage: profile.stage,
      environment: profile.environment,
      chainId: profile.chainId,
      particleSdkVersion: profile.particleSdkVersion,
      particleProtocolVersion: profile.particleProtocolVersion,
      particleProjectConfigDigest: profile.particleProjectConfigDigest.toLowerCase(),
      useEIP7702: profile.useEIP7702,
      delegateAddress: profile.delegateAddress.toLowerCase(),
      delegateCodeHash: profile.delegateCodeHash.toLowerCase(),
      responseDigests: {
        deployments: profile.responseDigests.deployments.toLowerCase(),
        auth: profile.responseDigests.auth.toLowerCase(),
        ...(profile.responseDigests.submission === undefined
          ? {}
          : { submission: profile.responseDigests.submission.toLowerCase() }),
        ...(profile.responseDigests.status === undefined
          ? {}
          : { status: profile.responseDigests.status.toLowerCase() }),
      },
      nonceConvention: profile.nonceConvention,
      ...(profile.sourceTokenProfile === undefined
        ? {}
        : { sourceTokenProfile: canonicalSourceTokenProfile(profile.sourceTokenProfile) }),
      ...(profile.canonicalCanaryEvidence === undefined
        ? {}
        : {
            canonicalCanaryEvidence: {
              ...profile.canonicalCanaryEvidence,
              orderKey: profile.canonicalCanaryEvidence.orderKey.toLowerCase(),
              transactionHash: profile.canonicalCanaryEvidence.transactionHash.toLowerCase(),
              blockHash: profile.canonicalCanaryEvidence.blockHash.toLowerCase(),
              acceptanceEvidenceDigest:
                profile.canonicalCanaryEvidence.acceptanceEvidenceDigest.toLowerCase(),
            },
          }),
      capturedAt: new Date(profile.capturedAt).toISOString(),
    }),
  );
}
