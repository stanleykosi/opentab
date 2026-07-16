import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BaseUnitAmountSchema, EvmAddressSchema, TransactionHashSchema } from '@opentab/shared';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { opaqueId } from '../src/crypto.js';
import { bootstrapGrants, outboxEvents, sponsorAuditEvents, users } from '../src/schema/index.js';
import {
  PostgresSponsorGrantReconciliationStore,
  PostgresSponsorGrantStore,
} from '../src/sponsor-grants.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env['DATABASE_URL_TEST'];
const signer = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const recipients = [
  EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`),
  EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`),
] as const;
const txHash = TransactionHashSchema.parse(`0x${'2'.repeat(64)}`);
const replacementTxHash = TransactionHashSchema.parse(`0x${'5'.repeat(64)}`);
const blockHash = `0x${'3'.repeat(64)}`;
let handle: DatabaseHandle | undefined;
let uow: PostgresUnitOfWork;
let grants: PostgresSponsorGrantStore;
let reconciliation: PostgresSponsorGrantReconciliationStore;
const userIds = [opaqueId('usr'), opaqueId('usr')];
const grantIds: string[] = [];

describe.skipIf(databaseUrl === undefined)('sponsor nonce and canonical persistence', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({ url: databaseUrl, applicationName: 'sponsor-reconciliation-tests' });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    uow = new PostgresUnitOfWork(handle.db);
    grants = new PostgresSponsorGrantStore(uow);
    reconciliation = new PostgresSponsorGrantReconciliationStore(uow);
    for (const [index, userId] of userIds.entries()) {
      const wallet = recipients[index];
      if (wallet === undefined) throw new Error('Missing sponsor test wallet');
      await uow
        .current()
        .insert(users)
        .values({
          id: userId,
          magicIssuerHash: randomBytes(32).toString('hex'),
          walletAddressChecksum: wallet,
          walletAddressLower: wallet.toLowerCase(),
        });
      const [grant] = await uow
        .current()
        .insert(bootstrapGrants)
        .values({
          environment: 'test',
          userId,
          magicIssuerHash: randomBytes(32).toString('hex'),
          recipientAddressLower: wallet.toLowerCase(),
          idempotencyKeyHash: randomBytes(32).toString('hex'),
          eligibilityReason: 'eligible',
          balanceBeforeWei: '0',
          targetWei: '100000',
          amountWei: '50000',
          status: 'created',
        })
        .returning({ id: bootstrapGrants.id });
      if (grant === undefined) throw new Error('Failed to create sponsor test grant');
      grantIds.push(grant.id);
    }
  }, 30_000);

  afterAll(async () => {
    if (handle === undefined) return;
    await uow.current().delete(outboxEvents).where(inArray(outboxEvents.aggregateId, grantIds));
    await uow
      .current()
      .delete(sponsorAuditEvents)
      .where(inArray(sponsorAuditEvents.grantId, grantIds));
    await uow.current().delete(bootstrapGrants).where(inArray(bootstrapGrants.id, grantIds));
    for (const userId of userIds) await uow.current().delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  it('assigns a signer nonce to at most one grant across processes', async () => {
    const results = await Promise.allSettled(
      grantIds.map((id) =>
        grants.markSubmissionStarted({
          id,
          sponsorSignerAddress: signer,
          signerNonce: '7',
          now: new Date('2026-07-14T12:00:00.000Z'),
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'SPONSOR_SUBMISSION_UNKNOWN' } });
  });

  it('persists the exact hash before submission and reconciles confirmation/reorg idempotently', async () => {
    const [started] = await uow
      .current()
      .select()
      .from(bootstrapGrants)
      .where(eq(bootstrapGrants.status, 'submission_started'))
      .limit(1);
    if (started === undefined) throw new Error('Missing started sponsor grant');
    await grants.markTransactionPrepared({
      id: started.id,
      transactionHash: txHash,
      signerNonce: '7',
      now: new Date('2026-07-14T12:00:01.000Z'),
    });
    await grants.markTransactionPrepared({
      id: started.id,
      transactionHash: replacementTxHash,
      signerNonce: '7',
      now: new Date('2026-07-14T12:00:01.500Z'),
    });
    await grants.markTransferResult({
      id: started.id,
      result: { status: 'submitted', transactionHash: replacementTxHash, signerNonce: '7' },
      now: new Date('2026-07-14T12:00:02.000Z'),
    });
    const candidate = (await reconciliation.listCandidates({ limit: 10 })).find(
      (entry) => entry.id === started.id,
    );
    expect(candidate).toMatchObject({
      transactionHash: replacementTxHash,
      transactionHashes: [txHash, replacementTxHash],
    });
    await reconciliation.markCanonicalOutcome({
      id: started.id,
      expectedTransactionHash: txHash,
      outcome: 'confirmed',
      blockNumber: '100',
      blockHash,
      now: new Date('2026-07-14T12:00:03.000Z'),
    });
    await reconciliation.markCanonicalOutcome({
      id: started.id,
      expectedTransactionHash: txHash,
      outcome: 'confirmed',
      blockNumber: '100',
      blockHash,
      now: new Date('2026-07-14T12:00:04.000Z'),
    });
    await reconciliation.markCanonicalOutcome({
      id: started.id,
      expectedTransactionHash: txHash,
      outcome: 'orphaned',
      now: new Date('2026-07-14T12:00:05.000Z'),
    });
    const [orphaned] = await uow
      .current()
      .select()
      .from(bootstrapGrants)
      .where(eq(bootstrapGrants.id, started.id));
    expect(orphaned).toMatchObject({ status: 'orphaned', blockNumber: null, blockHash: null });
    expect(BaseUnitAmountSchema.parse(orphaned?.signerNonce)).toBe('7');
    await reconciliation.markCanonicalOutcome({
      id: started.id,
      expectedTransactionHash: txHash,
      outcome: 'confirmed',
      blockNumber: '101',
      blockHash: `0x${'4'.repeat(64)}`,
      now: new Date('2026-07-14T12:00:06.000Z'),
    });
    const [reconfirmed] = await uow
      .current()
      .select()
      .from(bootstrapGrants)
      .where(eq(bootstrapGrants.id, started.id));
    expect(reconfirmed).toMatchObject({ status: 'confirmed', blockNumber: 101n });
  });
});
