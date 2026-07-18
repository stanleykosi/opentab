import type { ParticleCompatibilityProfile, ParticleProfileReleaseBinding } from '@opentab/shared';

export interface LoadIndexerParticleProfileInput {
  readonly databaseUrl: string;
  readonly environment: 'demo-mainnet' | 'production';
  readonly profileScopeId: string;
  readonly chainId: string;
}

export type IndexerParticleProfileBinding = Omit<
  ParticleProfileReleaseBinding,
  'applicationReleaseId'
> & {
  readonly profileScopeId: string;
};

export interface LoadedIndexerParticleProfile {
  readonly profile: ParticleCompatibilityProfile;
  readonly binding: IndexerParticleProfileBinding;
}

export type IndexerParticleProfileLoader = (
  input: LoadIndexerParticleProfileInput,
) => Promise<LoadedIndexerParticleProfile | undefined>;

interface DatabaseHandleLike {
  readonly db: unknown;
  close(): Promise<void>;
}

interface ParticleProfileDatabaseModuleLike {
  createDatabase(input: {
    url: string;
    applicationName: string;
    maxConnections: number;
  }): DatabaseHandleLike;
  assertIndexerDatabasePrivileges(db: unknown): Promise<void>;
  loadParticleCompatibilityProfileForRelease(
    db: unknown,
    input: {
      readonly environment: LoadIndexerParticleProfileInput['environment'];
      readonly applicationReleaseId: string;
      readonly chainId: string;
    },
  ): Promise<
    | {
        readonly profile: ParticleCompatibilityProfile;
        readonly binding: ParticleProfileReleaseBinding;
      }
    | undefined
  >;
}

function particleProfileDatabaseModule(value: unknown): ParticleProfileDatabaseModuleLike {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The database package did not expose a module object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record['createDatabase'] !== 'function' ||
    typeof record['assertIndexerDatabasePrivileges'] !== 'function' ||
    typeof record['loadParticleCompatibilityProfileForRelease'] !== 'function'
  ) {
    throw new Error('The database package is missing the Particle profile loader exports');
  }
  return record as unknown as ParticleProfileDatabaseModuleLike;
}

/**
 * Opens a short-lived, least-privilege connection before runtime composition.
 * The package loader validates every stored field and recomputes the immutable
 * profile digest; this boundary intentionally receives no raw vendor payload.
 */
export const loadIndexerParticleProfile: IndexerParticleProfileLoader = async (input) => {
  const runtimeModule = new URL('./db-runtime.js', import.meta.url).href;
  const module = particleProfileDatabaseModule(await import(runtimeModule));
  const database = module.createDatabase({
    url: input.databaseUrl,
    applicationName: 'opentab-indexer-particle-profile',
    maxConnections: 1,
  });
  try {
    await module.assertIndexerDatabasePrivileges(database.db);
    const loaded = await module.loadParticleCompatibilityProfileForRelease(database.db, {
      environment: input.environment,
      // The database schema retains this legacy column name. It stores the
      // stable Particle compatibility scope, not a Git application release.
      applicationReleaseId: input.profileScopeId,
      chainId: input.chainId,
    });
    if (loaded === undefined) return undefined;
    const { applicationReleaseId: profileScopeId, ...binding } = loaded.binding;
    return {
      profile: loaded.profile,
      binding: { ...binding, profileScopeId },
    };
  } finally {
    await database.close();
  }
};
