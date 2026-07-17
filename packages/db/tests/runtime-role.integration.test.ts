import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CurrentUserSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  OrderIdSchema,
} from '@opentab/shared';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { PostgresJudgeEvidenceManager } from '../src/judge-evidence.js';
import { assertRuntimeDatabasePrivileges } from '../src/runtime-privileges.js';
import {
  auditLogs,
  canonicalLogs,
  judgeEvidence,
  orders,
  paymentAttempts,
  receipts,
} from '../src/schema/index.js';
import { DETERMINISTIC_DEMO_IDS, seedDeterministicDemo } from '../src/seed.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const execFile = promisify(execFileCallback);
const runtimeRole = `opentab_runtime_${randomUUID().replaceAll('-', '')}`;
const runtimePassword = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const evidenceWriterRole = `opentab_evidence_${randomUUID().replaceAll('-', '')}`;
const judgePepper = 'runtime-role-judge-share-pepper'.padEnd(40, 'j');
let ownerHandle: DatabaseHandle | undefined;
let runtimeHandle: DatabaseHandle | undefined;
let runtimeRoleCreated = false;

const actor = CurrentUserSchema.parse({
  id: DETERMINISTIC_DEMO_IDS.merchantUserId,
  walletAddress: DETERMINISTIC_DEMO_IDS.merchantAddress,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [
    {
      merchantId: MerchantIdSchema.parse(DETERMINISTIC_DEMO_IDS.merchantId),
      role: 'owner',
    },
  ],
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function provisionRuntimeRole(database: string): Promise<void> {
  await execFile(
    'psql',
    [
      database,
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      fileURLToPath(new URL('../operations/provision-runtime-role.sql', import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        OPENTAB_RUNTIME_ROLE: runtimeRole,
        OPENTAB_RUNTIME_PASSWORD: runtimePassword,
        OPENTAB_EVIDENCE_WRITER_ROLE: evidenceWriterRole,
      },
    },
  );
}

describe.skipIf(databaseUrl === undefined)('least-privilege web runtime role', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    ownerHandle = createDatabase({ url: databaseUrl, applicationName: 'runtime-role-owner-tests' });
    await migrate(ownerHandle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await seedDeterministicDemo({
      db: ownerHandle.db,
      environment: 'test',
      deterministicDemoEnabled: true,
      secretPepper: 'runtime-role-seed-pepper'.padEnd(40, 's'),
    });
    const canonicalAt = new Date('2026-07-10T12:00:00.000Z');
    // The reorg integration suite intentionally leaves the deterministic
    // projection orphaned. Re-establish this suite's independent canonical
    // fixture instead of depending on file execution order.
    await ownerHandle.db
      .update(orders)
      .set({
        status: 'paid',
        paidAmountBaseUnits: '25000000',
        refundedAmountBaseUnits: '0',
        transactionHash: DETERMINISTIC_DEMO_IDS.transactionHash,
        blockNumber: 123456789n,
        blockHash: DETERMINISTIC_DEMO_IDS.blockHash,
        logIndex: 1,
        confirmedAt: canonicalAt,
        updatedAt: canonicalAt,
      })
      .where(eq(orders.id, DETERMINISTIC_DEMO_IDS.orderId));
    await ownerHandle.db
      .update(paymentAttempts)
      .set({
        status: 'paid',
        destinationTransactionHash: DETERMINISTIC_DEMO_IDS.transactionHash,
        reconciliationRequired: false,
        terminalAt: canonicalAt,
        updatedAt: canonicalAt,
      })
      .where(eq(paymentAttempts.id, DETERMINISTIC_DEMO_IDS.attemptId));
    await ownerHandle.db
      .update(canonicalLogs)
      .set({
        canonical: true,
        projectionStatus: 'applied',
        orphanedAt: null,
        projectedAt: canonicalAt,
      })
      .where(eq(canonicalLogs.id, DETERMINISTIC_DEMO_IDS.canonicalLogId));
    const passLogId = '00000000-0000-4000-8000-000000000299';
    await ownerHandle.db
      .insert(canonicalLogs)
      .values({
        id: passLogId,
        chainId: '42161',
        stream: 'pass-v1-runtime-role',
        contractAddress: DETERMINISTIC_DEMO_IDS.passAddress,
        eventName: 'TransferSingle',
        transactionHash: DETERMINISTIC_DEMO_IDS.transactionHash,
        blockNumber: 123456789n,
        blockHash: DETERMINISTIC_DEMO_IDS.blockHash,
        // Keep this synthetic pass event distinct from the Judge lifecycle
        // fixture when both suites share one migrated integration database.
        logIndex: 29,
        canonical: true,
        decodedPayload: {
          decoderVersion: 'runtime-role-test-v1',
          fields: {
            operator: DETERMINISTIC_DEMO_IDS.checkoutAddress,
            from: '0x0000000000000000000000000000000000000000',
            to: DETERMINISTIC_DEMO_IDS.customerAddress,
            id: '1',
            value: '1',
          },
          confirmations: '12',
        },
        payloadDigest: `0x${'d1'.repeat(32)}`,
        projectionStatus: 'applied',
        observedAt: new Date('2026-07-10T12:00:00.000Z'),
        projectedAt: new Date('2026-07-10T12:00:00.000Z'),
        createdAt: new Date('2026-07-10T12:00:00.000Z'),
      })
      .onConflictDoNothing();
    await ownerHandle.db
      .update(receipts)
      .set({ chainEventId: passLogId, status: 'issued', issuedAt: canonicalAt })
      .where(eq(receipts.id, DETERMINISTIC_DEMO_IDS.receiptId));
    // Production starts without a materialized proof. The deterministic seed
    // includes one for browser demos, so remove it before exercising the
    // first-write-only runtime boundary.
    await ownerHandle.db
      .delete(judgeEvidence)
      .where(eq(judgeEvidence.orderId, DETERMINISTIC_DEMO_IDS.orderId));

    await provisionRuntimeRole(databaseUrl);
    runtimeRoleCreated = true;

    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimeHandle = createDatabase({
      url: runtimeUrl.toString(),
      maxConnections: 1,
      applicationName: 'runtime-role-application-tests',
    });
  }, 30_000);

  afterAll(async () => {
    await runtimeHandle?.close();
    if (databaseUrl !== undefined && runtimeRoleCreated) {
      await execFile(
        'psql',
        [
          databaseUrl,
          '--no-psqlrc',
          '--set',
          'ON_ERROR_STOP=1',
          '--file',
          fileURLToPath(new URL('../operations/revoke-runtime-role.sql', import.meta.url)),
        ],
        { env: { ...process.env, OPENTAB_RUNTIME_ROLE: runtimeRole } },
      );
      await ownerHandle?.db.execute(sql.raw(`drop role ${quoteIdentifier(runtimeRole)}`));
    }
    await ownerHandle?.close();
  });

  it('fails closed when RLS is enabled without the backend-only policy', async () => {
    if (ownerHandle === undefined || runtimeHandle === undefined) {
      throw new Error('Runtime-role test database was not initialized');
    }

    await ownerHandle.db.execute(
      sql.raw('alter table public.config_snapshots enable row level security'),
    );
    try {
      await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).rejects.toMatchObject({
        code: 'CONFIGURATION_INVALID',
      });
      await ownerHandle.db.execute(
        sql.raw(
          `create policy opentab_backend_roles on public.config_snapshots as permissive for all to ${quoteIdentifier(runtimeRole)} using (true) with check (true)`,
        ),
      );
      await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).resolves.toBeUndefined();
    } finally {
      await ownerHandle.db.execute(
        sql.raw('drop policy if exists opentab_backend_roles on public.config_snapshots'),
      );
      await ownerHandle.db.execute(
        sql.raw('alter table public.config_snapshots disable row level security'),
      );
    }
  });

  it('supports normal Judge materialization while denying attestation and shadow-table writes', async () => {
    if (ownerHandle === undefined || runtimeHandle === undefined) {
      throw new Error('Runtime-role test database was not initialized');
    }

    await expect(assertRuntimeDatabasePrivileges(ownerHandle.db)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).resolves.toBeUndefined();

    const membershipRole = `opentab_runtime_membership_${randomUUID().replaceAll('-', '')}`;
    await ownerHandle.db.execute(sql.raw(`create role ${quoteIdentifier(membershipRole)} nologin`));
    try {
      await ownerHandle.db.execute(
        sql.raw(`grant ${quoteIdentifier(membershipRole)} to ${quoteIdentifier(runtimeRole)}`),
      );
      await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).rejects.toMatchObject({
        code: 'CONFIGURATION_INVALID',
      });
      if (databaseUrl === undefined) throw new Error('Test database URL is unavailable');
      await provisionRuntimeRole(databaseUrl);
      await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).resolves.toBeUndefined();
    } finally {
      await ownerHandle.db.execute(
        sql.raw(`revoke ${quoteIdentifier(membershipRole)} from ${quoteIdentifier(runtimeRole)}`),
      );
      await ownerHandle.db.execute(sql.raw(`drop role ${quoteIdentifier(membershipRole)}`));
    }

    const columns = await ownerHandle.db.execute<{ columnName: string }>(sql`
      select column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public' and table_name = 'live_acceptance_evidence'
      order by ordinal_position
    `);
    const columnList = columns.map((column) => quoteIdentifier(column.columnName)).join(', ');
    expect(columnList.length).toBeGreaterThan(0);
    await ownerHandle.db.execute(
      sql.raw(
        `grant insert (${columnList}) on table public.live_acceptance_evidence to ${quoteIdentifier(runtimeRole)}`,
      ),
    );
    await ownerHandle.db.execute(
      sql.raw(
        `grant update (${columnList}) on table public.live_acceptance_evidence to ${quoteIdentifier(runtimeRole)}`,
      ),
    );
    await ownerHandle.db.execute(
      sql.raw(
        `grant references (${columnList}) on table public.live_acceptance_evidence to ${quoteIdentifier(runtimeRole)}`,
      ),
    );
    await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    if (databaseUrl === undefined) throw new Error('Test database URL is unavailable');
    await provisionRuntimeRole(databaseUrl);
    await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).resolves.toBeUndefined();

    await ownerHandle.db.execute(
      sql.raw(
        `grant update (result), references (id) on table public.audit_logs to ${quoteIdentifier(runtimeRole)}`,
      ),
    );
    await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    await provisionRuntimeRole(databaseUrl);
    await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).resolves.toBeUndefined();

    await ownerHandle.db.execute(
      sql.raw(
        `grant update (public_proof, public_proof_digest) on table public.judge_evidence to ${quoteIdentifier(runtimeRole)}`,
      ),
    );
    await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    await provisionRuntimeRole(databaseUrl);
    await expect(assertRuntimeDatabasePrivileges(runtimeHandle.db)).resolves.toBeUndefined();

    await expect(
      runtimeHandle.db.execute(sql.raw('create temporary table orders (id text)')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(
        sql.raw('insert into public.live_acceptance_evidence default values'),
      ),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(
        sql.raw('update public.live_acceptance_evidence set environment = environment'),
      ),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('delete from public.live_acceptance_evidence')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('insert into public.canonical_logs default values')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('update public.canonical_logs set canonical = canonical')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('delete from public.canonical_logs')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('insert into public.indexed_blocks default values')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('update public.indexed_blocks set canonical = canonical')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('insert into public.receipts default values')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('update public.receipts set status = status')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(sql.raw('delete from public.receipts')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db.execute(
        sql.raw(
          `update public.orders set transaction_hash = '${`0x${'e1'.repeat(32)}`}' where id = '${DETERMINISTIC_DEMO_IDS.orderId}'`,
        ),
      ),
    ).rejects.toBeTruthy();

    const manager = new PostgresJudgeEvidenceManager(
      new PostgresUnitOfWork(runtimeHandle.db),
      judgePepper,
      {
        environment: 'production',
        checkoutAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.checkoutAddress),
        passAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.passAddress),
        tokenAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.usdcAddress),
        applicationVersion: 'c3'.repeat(20),
        deploymentConfigDigest: EvidenceDigestSchema.parse(`0x${'c4'.repeat(32)}`),
        particleSdkVersion: '2.0.3',
        magicSdkVersion: '33.9.0',
        contractsVersion: '1.0.0',
        provenance: 'live',
        acceptanceAttestationSecret: 'runtime-role-attestation-secret'.padEnd(48, 'a'),
      },
      () => new Date('2026-07-14T12:00:00.000Z'),
    );
    const materialized = await manager.materialize(
      actor,
      OrderIdSchema.parse(DETERMINISTIC_DEMO_IDS.orderId),
    );
    expect(materialized.status).toBe('unpublished');
    expect(materialized.proof.settlement).toMatchObject({
      chainId: '42161',
      checkoutAddress: DETERMINISTIC_DEMO_IDS.checkoutAddress,
      receiptId: DETERMINISTIC_DEMO_IDS.receiptId,
    });
    await expect(
      manager.materialize(actor, OrderIdSchema.parse(DETERMINISTIC_DEMO_IDS.orderId)),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db
        .update(judgeEvidence)
        .set({ publicProof: { forged: true }, publicProofDigest: `0x${'ff'.repeat(32)}` })
        .where(eq(judgeEvidence.orderId, DETERMINISTIC_DEMO_IDS.orderId)),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db
        .update(judgeEvidence)
        .set({ published: true, updatedAt: new Date('2026-07-14T12:01:00.000Z') })
        .where(eq(judgeEvidence.orderId, DETERMINISTIC_DEMO_IDS.orderId)),
    ).resolves.toBeDefined();
    await expect(
      runtimeHandle.db.insert(auditLogs).values({
        actorType: 'user',
        actorId: DETERMINISTIC_DEMO_IDS.merchantUserId,
        action: 'judge_evidence.materialized',
        resourceType: 'order',
        resourceId: DETERMINISTIC_DEMO_IDS.orderId,
        result: 'success',
        requestId: 'runtime-role-audit-append',
        safeMetadata: { source: 'runtime-role-test' },
      }),
    ).resolves.toBeDefined();
    await expect(
      runtimeHandle.db
        .update(auditLogs)
        .set({ result: 'forged' })
        .where(eq(auditLogs.requestId, 'runtime-role-audit-append')),
    ).rejects.toBeTruthy();
    await expect(
      runtimeHandle.db
        .delete(auditLogs)
        .where(eq(auditLogs.requestId, 'runtime-role-audit-append')),
    ).rejects.toBeTruthy();
    const judgeRows = await runtimeHandle.db.execute<{ count: number }>(sql`
      select count(*)::int as count from public.judge_evidence
    `);
    expect(judgeRows[0]?.count).toBeGreaterThan(0);
  }, 30_000);
});
