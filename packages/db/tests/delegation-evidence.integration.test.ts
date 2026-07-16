import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  type CurrentUser,
  CurrentUserSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  UserIdSchema,
} from '@opentab/shared';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBackendApiStore } from '../src/backend-api-store.js';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { opaqueId } from '../src/crypto.js';
import { delegationRecords, users, walletAccounts } from '../src/schema/index.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const capabilityPepper = 'delegation-evidence-test-pepper'.padEnd(40, 'd');
const firstUserId = UserIdSchema.parse(opaqueId('usr'));
const secondUserId = UserIdSchema.parse(opaqueId('usr'));
const firstWallet = EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`);
const secondWallet = EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`);
const implementation = EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`);

let handle: DatabaseHandle | undefined;
let uow: PostgresUnitOfWork;
let store: PostgresBackendApiStore;

function hexDigest(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}`;
}

function evidenceDigest(): ReturnType<typeof EvidenceDigestSchema.parse> {
  return EvidenceDigestSchema.parse(hexDigest());
}

function uppercaseHex(value: string): `0x${string}` {
  return `0x${value.slice(2).toUpperCase()}`;
}

const firstActor = CurrentUserSchema.parse({
  id: firstUserId,
  walletAddress: firstWallet,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});
const secondActor = CurrentUserSchema.parse({
  id: secondUserId,
  walletAddress: secondWallet,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});

function evidence(
  actor: CurrentUser,
  input: {
    transactionHash: `0x${string}`;
    evidenceDigest: ReturnType<typeof EvidenceDigestSchema.parse>;
    observedAt?: Date;
  },
) {
  return {
    actor,
    environment: 'test' as const,
    implementationAddress: implementation,
    implementationCodeHash: hexDigest(),
    transactionHash: input.transactionHash,
    blockNumber: '31415926',
    blockHash: hexDigest(),
    evidenceDigest: input.evidenceDigest,
    observedAt: input.observedAt ?? new Date('2026-07-14T18:00:00.000Z'),
  };
}

describe.skipIf(databaseUrl === undefined)('immutable delegation evidence', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({ url: databaseUrl, applicationName: 'delegation-evidence-tests' });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    uow = new PostgresUnitOfWork(handle.db);
    store = new PostgresBackendApiStore(uow, capabilityPepper);
    await uow
      .current()
      .insert(users)
      .values([
        {
          id: firstUserId,
          magicIssuerHash: hexDigest(),
          walletAddressChecksum: firstWallet,
          walletAddressLower: firstWallet.toLowerCase(),
        },
        {
          id: secondUserId,
          magicIssuerHash: hexDigest(),
          walletAddressChecksum: secondWallet,
          walletAddressLower: secondWallet.toLowerCase(),
        },
      ]);
  }, 30_000);

  afterAll(async () => {
    if (handle === undefined) return;
    await uow
      .current()
      .delete(walletAccounts)
      .where(inArray(walletAccounts.userId, [firstUserId, secondUserId]));
    await uow
      .current()
      .delete(delegationRecords)
      .where(inArray(delegationRecords.userId, [firstUserId, secondUserId]));
    await uow
      .current()
      .delete(users)
      .where(inArray(users.id, [firstUserId, secondUserId]));
    await handle.close();
  });

  it('atomically rejects reuse of one transaction hash by a second user and owner', async () => {
    const transactionHash = hexDigest();
    const proofDigest = evidenceDigest();
    const firstProof = evidence(firstActor, { transactionHash, evidenceDigest: proofDigest });
    await store.recordDelegationEvidence(firstProof);

    await expect(
      store.recordDelegationEvidence({
        ...firstProof,
        actor: secondActor,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const [persisted] = await uow
      .current()
      .select()
      .from(delegationRecords)
      .where(eq(delegationRecords.transactionHash, transactionHash));
    expect(persisted).toMatchObject({
      userId: firstUserId,
      environment: 'test',
      ownerAddressLower: firstWallet.toLowerCase(),
      evidenceDigest: proofDigest,
    });
    const secondWalletRecords = await uow
      .current()
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, secondUserId));
    expect(secondWalletRecords).toHaveLength(0);

    const racedTransactionHash = hexDigest();
    const racedProof = evidence(firstActor, {
      transactionHash: racedTransactionHash,
      evidenceDigest: evidenceDigest(),
    });
    const outcomes = await Promise.allSettled([
      store.recordDelegationEvidence(racedProof),
      store.recordDelegationEvidence({ ...racedProof, actor: secondActor }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failures = outcomes.filter(({ status }) => status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    const [racedRecord] = await uow
      .current()
      .select()
      .from(delegationRecords)
      .where(eq(delegationRecords.transactionHash, racedTransactionHash));
    const racedWallets = await uow
      .current()
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.delegationTransactionHash, racedTransactionHash));
    expect(racedWallets).toHaveLength(1);
    expect(racedRecord?.userId).toBe(racedWallets[0]?.userId);
    expect(racedRecord?.ownerAddressLower).toBe(racedWallets[0]?.ownerAddressLower);
  });

  it('keeps exact replay idempotent and rejects proof-digest substitution without mutation', async () => {
    const transactionHash = hexDigest();
    const originalDigest = evidenceDigest();
    const originalObservedAt = new Date('2026-07-14T19:00:00.000Z');
    const proof = evidence(firstActor, {
      transactionHash,
      evidenceDigest: originalDigest,
      observedAt: originalObservedAt,
    });
    await store.recordDelegationEvidence(proof);
    await store.recordDelegationEvidence({
      ...proof,
      transactionHash: uppercaseHex(proof.transactionHash),
      implementationCodeHash: uppercaseHex(proof.implementationCodeHash),
      blockHash: uppercaseHex(proof.blockHash),
      evidenceDigest: EvidenceDigestSchema.parse(uppercaseHex(proof.evidenceDigest)),
      observedAt: new Date('2026-07-14T19:05:00.000Z'),
    });

    await expect(
      store.recordDelegationEvidence({
        ...proof,
        evidenceDigest: evidenceDigest(),
        observedAt: new Date('2026-07-14T19:10:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const records = await uow
      .current()
      .select()
      .from(delegationRecords)
      .where(eq(delegationRecords.transactionHash, transactionHash));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      evidenceDigest: originalDigest,
      checkedAt: originalObservedAt,
      updatedAt: originalObservedAt,
    });
    const [wallet] = await uow
      .current()
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.delegationTransactionHash, transactionHash));
    expect(wallet).toMatchObject({
      userId: firstUserId,
      environment: 'test',
      sdkPackageVersion: 'server-chain-proof-v2',
      evidenceDigest: originalDigest,
    });
  });
});
