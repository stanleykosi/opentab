import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  ChainIdSchema,
  digestParticleCompatibilityProfile,
  EvidenceDigestSchema,
  type ParticleCompatibilityProfile,
  ParticleCompatibilityProfileSchema,
  type ParticleProfileReleaseBinding,
  ParticleProfileReleaseBindingSchema,
  PaymentAttemptIdSchema,
  type ProviderOperation,
  ProviderOperationIdSchema,
} from '@opentab/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OpenTabDatabase } from './client.js';
import {
  particleCompatibilityProfiles,
  particleProfileReleaseBindings,
  providerOperations,
} from './schema/index.js';

const LoadParticleCompatibilityProfileInputSchema = z
  .object({
    environment: z.enum(['demo-mainnet', 'production']),
    applicationReleaseId: z.string().regex(/^[0-9a-fA-F]{40}$/),
    chainId: ChainIdSchema.refine(
      (value) => value === ARBITRUM_ONE_CHAIN_ID,
      'Particle certification is restricted to Arbitrum One',
    ),
  })
  .strict();

export interface LoadParticleCompatibilityProfileForReleaseInput {
  readonly environment: 'demo-mainnet' | 'production';
  readonly applicationReleaseId: string;
  readonly chainId: string;
}

export interface LoadedParticleCompatibilityProfile {
  readonly profile: ParticleCompatibilityProfile;
  readonly binding: ParticleProfileReleaseBinding;
}

export interface CertifyParticleCompatibilityProfileInput {
  readonly profile: ParticleCompatibilityProfile;
  readonly applicationReleaseId: string;
  readonly certifiedSubjectHash: string;
  readonly canaryProductId: string;
  readonly canaryMaxBaseUnits: string;
  readonly boundAt?: string;
}

export interface ParticleCertificationProviderOperation {
  readonly externalId: string;
  readonly status: ProviderOperation['status'];
  readonly evidenceDigest: string;
}

function buildProfile(
  row: typeof particleCompatibilityProfiles.$inferSelect,
): ParticleCompatibilityProfile {
  return ParticleCompatibilityProfileSchema.parse({
    schemaVersion: row.schemaVersion,
    profileId: row.profileId,
    stage: row.stage,
    environment: row.environment,
    chainId: row.chainId,
    particleSdkVersion: row.particleSdkVersion,
    particleProtocolVersion: row.particleProtocolVersion,
    particleProjectConfigDigest: row.particleProjectConfigDigest,
    useEIP7702: row.useEip7702,
    delegateAddress: row.delegateAddress,
    delegateCodeHash: row.delegateCodeHash,
    responseDigests: row.responseDigests,
    nonceConvention: row.nonceConvention,
    ...(row.sourceTokenProfile === null ? {} : { sourceTokenProfile: row.sourceTokenProfile }),
    ...(row.canonicalCanaryEvidence === null
      ? {}
      : { canonicalCanaryEvidence: row.canonicalCanaryEvidence }),
    capturedAt: row.capturedAt.toISOString(),
  });
}

function buildBinding(
  row: typeof particleProfileReleaseBindings.$inferSelect,
): ParticleProfileReleaseBinding {
  return ParticleProfileReleaseBindingSchema.parse({
    schemaVersion: row.schemaVersion,
    environment: row.environment,
    applicationReleaseId: row.applicationReleaseId,
    chainId: row.chainId,
    stage: row.stage,
    profileId: row.profileId,
    profileDigest: row.profileDigest,
    certifiedSubjectHash: row.certifiedSubjectHash,
    canaryProductId: row.canaryProductId,
    canaryMaxBaseUnits: row.canaryMaxBaseUnits,
    boundAt: row.boundAt.toISOString(),
  });
}

/**
 * Loads the highest append-only certification stage for one exact deployed
 * release. Every database value and the canonical content digest is rechecked
 * before the profile can reach a runtime or indexer adapter.
 */
export async function loadParticleCompatibilityProfileForRelease(
  db: OpenTabDatabase,
  input: LoadParticleCompatibilityProfileForReleaseInput,
): Promise<LoadedParticleCompatibilityProfile | undefined> {
  const parsed = LoadParticleCompatibilityProfileInputSchema.parse(input);
  const [row] = await db
    .select({
      profile: particleCompatibilityProfiles,
      binding: particleProfileReleaseBindings,
    })
    .from(particleProfileReleaseBindings)
    .innerJoin(
      particleCompatibilityProfiles,
      eq(particleCompatibilityProfiles.profileId, particleProfileReleaseBindings.profileId),
    )
    .where(
      and(
        eq(particleProfileReleaseBindings.environment, parsed.environment),
        eq(
          particleProfileReleaseBindings.applicationReleaseId,
          parsed.applicationReleaseId.toLowerCase(),
        ),
        eq(particleProfileReleaseBindings.chainId, parsed.chainId),
      ),
    )
    .orderBy(
      desc(
        sql`case ${particleProfileReleaseBindings.stage}
          when 'certified' then 3
          when 'canary_ready' then 2
          when 'bootstrap' then 1
          else 0
        end`,
      ),
      desc(particleProfileReleaseBindings.boundAt),
      desc(particleProfileReleaseBindings.id),
    )
    .limit(1);

  if (row === undefined) return undefined;
  try {
    const profile = buildProfile(row.profile);
    const binding = buildBinding(row.binding);
    const expectedDigest = digestParticleCompatibilityProfile(profile);
    if (
      binding.profileId !== profile.profileId ||
      binding.stage !== profile.stage ||
      binding.environment !== profile.environment ||
      binding.chainId !== profile.chainId ||
      binding.profileDigest.toLowerCase() !== expectedDigest.toLowerCase() ||
      row.profile.profileDigest.toLowerCase() !== expectedDigest.toLowerCase()
    ) {
      throw new Error('Particle compatibility binding mismatch');
    }
    return { profile, binding };
  } catch (error) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Stored Particle compatibility certification failed closed.',
      { cause: error },
    );
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Invokes the migration-owned SECURITY DEFINER boundary. The runtime role has
 * no direct INSERT/UPDATE/DELETE privilege on either immutable table.
 */
export async function certifyParticleCompatibilityProfile(
  db: OpenTabDatabase,
  input: CertifyParticleCompatibilityProfileInput,
): Promise<LoadedParticleCompatibilityProfile> {
  const profile = ParticleCompatibilityProfileSchema.parse(input.profile);
  const profileDigest = digestParticleCompatibilityProfile(profile);
  const binding = ParticleProfileReleaseBindingSchema.parse({
    schemaVersion: 1,
    environment: profile.environment,
    applicationReleaseId: input.applicationReleaseId.toLowerCase(),
    chainId: profile.chainId,
    stage: profile.stage,
    profileId: profile.profileId,
    profileDigest,
    certifiedSubjectHash: EvidenceDigestSchema.parse(input.certifiedSubjectHash),
    canaryProductId: input.canaryProductId,
    canaryMaxBaseUnits: input.canaryMaxBaseUnits,
    boundAt: input.boundAt ?? new Date().toISOString(),
  });

  try {
    await db.execute(
      sql`select public.certify_particle_compatibility_profile(
        ${JSON.stringify(profile)}::jsonb,
        ${JSON.stringify(binding)}::jsonb
      )`,
    );
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === '23505' || code === '55000') {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'Particle certification conflicts with immutable compatibility-profile evidence.',
        { cause: error },
      );
    }
    throw new AppError('CONFIGURATION_INVALID', 'Particle certification was rejected.', {
      cause: error,
    });
  }

  const loaded = await loadParticleCompatibilityProfileForRelease(db, {
    environment: profile.environment,
    applicationReleaseId: binding.applicationReleaseId,
    chainId: profile.chainId,
  });
  if (
    loaded === undefined ||
    loaded.profile.profileId !== profile.profileId ||
    loaded.binding.profileDigest.toLowerCase() !== profileDigest.toLowerCase()
  ) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'Particle certification did not become the latest immutable compatibility stage.',
    );
  }
  return loaded;
}

/**
 * Returns only the reconciliation facts required to finalize a certified
 * profile. Ambiguous Particle operations fail closed.
 */
export async function loadParticleCertificationProviderOperation(
  db: OpenTabDatabase,
  input: { readonly paymentAttemptId: string },
): Promise<ParticleCertificationProviderOperation | undefined> {
  const paymentAttemptId = PaymentAttemptIdSchema.parse(input.paymentAttemptId);
  const rows = await db
    .select({
      externalId: providerOperations.externalId,
      status: providerOperations.status,
      evidenceDigest: providerOperations.evidenceDigest,
    })
    .from(providerOperations)
    .where(
      and(
        eq(providerOperations.provider, 'particle'),
        eq(providerOperations.paymentAttemptId, paymentAttemptId),
      ),
    )
    .orderBy(desc(providerOperations.updatedAt), desc(providerOperations.id))
    .limit(2);
  if (rows.length === 0) return undefined;
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Particle certification found ambiguous provider reconciliation evidence.',
    );
  }
  return {
    externalId: ProviderOperationIdSchema.parse(rows[0].externalId),
    status: rows[0].status,
    evidenceDigest: EvidenceDigestSchema.parse(rows[0].evidenceDigest),
  };
}
