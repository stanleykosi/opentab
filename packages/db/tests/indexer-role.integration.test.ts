import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ARBITRUM_ONE_CHAIN_ID } from '@opentab/shared';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { assertIndexerDatabasePrivileges } from '../src/indexer-privileges.js';
import { PostgresIndexerStore } from '../src/indexer-store.js';
import {
  auditLogs,
  canonicalLogs,
  chainTransactions,
  judgeEvidence,
  liveAcceptanceEvidence,
  serverSessions,
} from '../src/schema/index.js';
import { DETERMINISTIC_DEMO_IDS, seedDeterministicDemo } from '../src/seed.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const execFile = promisify(execFileCallback);
const indexerRole = `opentab_indexer_${randomUUID().replaceAll('-', '')}`;
const indexerPassword = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
let ownerHandle: DatabaseHandle | undefined;
let indexerHandle: DatabaseHandle | undefined;
let roleCreated = false;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function indexerUrl(): string {
  if (databaseUrl === undefined) throw new Error('Test database URL is unavailable');
  const value = new URL(databaseUrl);
  value.username = indexerRole;
  value.password = indexerPassword;
  return value.toString();
}

async function provision(): Promise<void> {
  if (databaseUrl === undefined) throw new Error('Test database URL is unavailable');
  await execFile(
    'psql',
    [
      databaseUrl,
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      fileURLToPath(new URL('../operations/provision-indexer-role.sql', import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        OPENTAB_INDEXER_ROLE: indexerRole,
        OPENTAB_INDEXER_PASSWORD: indexerPassword,
      },
    },
  );
  roleCreated = true;
}

describe.skipIf(databaseUrl === undefined)('least-privilege indexer database role', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    ownerHandle = createDatabase({ url: databaseUrl, applicationName: 'indexer-role-owner-test' });
    await migrate(ownerHandle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await seedDeterministicDemo({
      db: ownerHandle.db,
      environment: 'test',
      deterministicDemoEnabled: true,
      secretPepper: 'indexer-role-test-pepper'.padEnd(40, 'i'),
    });
    await provision();
    indexerHandle = createDatabase({
      url: indexerUrl(),
      applicationName: 'indexer-role-runtime-test',
      maxConnections: 1,
    });
  }, 30_000);

  afterAll(async () => {
    await indexerHandle?.close();
    if (databaseUrl !== undefined && ownerHandle !== undefined && roleCreated) {
      await execFile(
        'psql',
        [
          databaseUrl,
          '--no-psqlrc',
          '--set',
          'ON_ERROR_STOP=1',
          '--file',
          fileURLToPath(new URL('../operations/revoke-indexer-role.sql', import.meta.url)),
        ],
        { env: { ...process.env, OPENTAB_INDEXER_ROLE: indexerRole } },
      );
      await ownerHandle.db.execute(sql.raw(`drop role ${quoteIdentifier(indexerRole)}`));
    }
    await ownerHandle?.close();
  });

  it('permits projection work and rejects drift, auth, audit, and acceptance access', async () => {
    if (ownerHandle === undefined || indexerHandle === undefined || databaseUrl === undefined) {
      throw new Error('Indexer-role test database was not initialized');
    }
    await expect(assertIndexerDatabasePrivileges(ownerHandle.db)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).resolves.toBeUndefined();

    const store = new PostgresIndexerStore(new PostgresUnitOfWork(indexerHandle.db));
    const cursor = await store.loadOrCreateCursor({
      chainId: ARBITRUM_ONE_CHAIN_ID,
      stream: 'least-privilege-test',
      startBlock: 1n,
      confirmationDepth: 2,
    });
    expect(cursor.nextBlock).toBe(1n);
    await expect(
      store.tryAcquireLease({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        stream: 'least-privilege-test',
        owner: 'indexer-role-test',
        ttlMs: 30_000,
        now: new Date('2026-07-15T12:00:00.000Z'),
      }),
    ).resolves.toBe(true);
    await store.releaseLease({
      chainId: ARBITRUM_ONE_CHAIN_ID,
      stream: 'least-privilege-test',
      owner: 'indexer-role-test',
      now: new Date('2026-07-15T12:00:01.000Z'),
    });

    await expect(indexerHandle.db.select().from(serverSessions).limit(1)).rejects.toBeTruthy();
    await expect(indexerHandle.db.select().from(auditLogs).limit(1)).rejects.toBeTruthy();
    await expect(
      indexerHandle.db.insert(auditLogs).values({
        actorType: 'system',
        action: 'forged',
        resourceType: 'indexer',
        result: 'forged',
        requestId: 'forged-indexer-audit',
      }),
    ).rejects.toBeTruthy();
    await expect(
      indexerHandle.db.select().from(liveAcceptanceEvidence).limit(1),
    ).rejects.toBeTruthy();
    await expect(
      indexerHandle.db.update(chainTransactions).set({ status: 'confirmed' }),
    ).rejects.toBeTruthy();
    await expect(
      indexerHandle.db
        .update(judgeEvidence)
        .set({ publicProof: { forged: true } })
        .where(eq(judgeEvidence.orderId, DETERMINISTIC_DEMO_IDS.orderId)),
    ).rejects.toBeTruthy();
    await expect(
      indexerHandle.db
        .update(judgeEvidence)
        .set({ published: false, revokedAt: new Date('2026-07-15T12:00:00.000Z') })
        .where(eq(judgeEvidence.orderId, DETERMINISTIC_DEMO_IDS.orderId)),
    ).resolves.toBeDefined();
    await expect(indexerHandle.db.delete(canonicalLogs)).rejects.toBeTruthy();
    await expect(
      indexerHandle.db.execute(sql.raw('create temporary table indexer_cursors (id text)')),
    ).rejects.toBeTruthy();

    const membershipRole = `opentab_indexer_membership_${randomUUID().replaceAll('-', '')}`;
    await ownerHandle.db.execute(sql.raw(`create role ${quoteIdentifier(membershipRole)} nologin`));
    try {
      await ownerHandle.db.execute(
        sql.raw(`grant ${quoteIdentifier(membershipRole)} to ${quoteIdentifier(indexerRole)}`),
      );
      await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).rejects.toMatchObject({
        code: 'CONFIGURATION_INVALID',
      });
      await provision();
      await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).resolves.toBeUndefined();
    } finally {
      await ownerHandle.db.execute(
        sql.raw(`revoke ${quoteIdentifier(membershipRole)} from ${quoteIdentifier(indexerRole)}`),
      );
      await ownerHandle.db.execute(sql.raw(`drop role ${quoteIdentifier(membershipRole)}`));
    }

    await ownerHandle.db.execute(
      sql.raw(`grant select on public.server_sessions to ${quoteIdentifier(indexerRole)}`),
    );
    await ownerHandle.db.execute(
      sql.raw(`grant insert on public.live_acceptance_evidence to ${quoteIdentifier(indexerRole)}`),
    );
    await ownerHandle.db.execute(
      sql.raw(`grant update (result) on public.audit_logs to ${quoteIdentifier(indexerRole)}`),
    );
    await ownerHandle.db.execute(
      sql.raw(
        `grant update (public_proof) on public.judge_evidence to ${quoteIdentifier(indexerRole)}`,
      ),
    );
    await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    await provision();
    await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).resolves.toBeUndefined();

    const parsed = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    await ownerHandle.db.execute(
      sql.raw(
        `grant create, temporary on database ${quoteIdentifier(databaseName)} to ${quoteIdentifier(indexerRole)}`,
      ),
    );
    await ownerHandle.db.execute(
      sql.raw(`grant create on schema public to ${quoteIdentifier(indexerRole)}`),
    );
    await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    await provision();
    await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).resolves.toBeUndefined();

    const ownedSchema = `opentab_indexer_owned_${randomUUID().replaceAll('-', '')}`;
    await ownerHandle.db.execute(
      sql.raw(
        `create schema ${quoteIdentifier(ownedSchema)} authorization ${quoteIdentifier(indexerRole)}`,
      ),
    );
    try {
      await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).rejects.toMatchObject({
        code: 'CONFIGURATION_INVALID',
      });
      await expect(provision()).rejects.toBeTruthy();
    } finally {
      await ownerHandle.db.execute(
        sql.raw(`drop schema if exists ${quoteIdentifier(ownedSchema)} cascade`),
      );
      await provision();
    }
    await expect(assertIndexerDatabasePrivileges(indexerHandle.db)).resolves.toBeUndefined();
  }, 30_000);
});
