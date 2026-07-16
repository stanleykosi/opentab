import { fileURLToPath } from 'node:url';
import {
  ChainIdSchema,
  CurrentUserSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  OrderIdSchema,
  UserIdSchema,
} from '@opentab/shared';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBackendApiQueryStore } from '../src/api-query-store.js';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { PostgresIndexerStore } from '../src/indexer-store.js';
import { PostgresJudgeEvidenceManager } from '../src/judge-evidence.js';
import { createLiveAcceptancePayloadDigest } from '../src/live-acceptance-evidence.js';
import {
  canonicalLogs,
  delegationRecords,
  indexedBlocks,
  indexerCursors,
  judgeEvidence,
  orders,
  paymentAttempts,
  providerOperations,
  receipts,
  userIdentities,
  walletAccounts,
} from '../src/schema/index.js';
import { DETERMINISTIC_DEMO_IDS, seedDeterministicDemo } from '../src/seed.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const capabilityPepper = 'judge-capability-test-pepper'.padEnd(40, 'c');
const judgePepper = 'judge-public-share-test-pepper'.padEnd(40, 'j');
const passLogId = '00000000-0000-4000-8000-000000000100';
const exactIdentityId = '00000000-0000-4000-8000-000000000110';
const tieBreakDecoyIdentityId = '00000000-0000-4000-8000-000000000111';
const exactDelegationTransactionHash = `0x${'99'.repeat(32)}`;
const staleDelegationTransactionHash = `0x${'aa'.repeat(32)}`;
const otherEnvironmentDelegationTransactionHash = `0x${'bb'.repeat(32)}`;
const exactDelegationEvidenceDigest = `0x${'cc'.repeat(32)}`;
const staleDelegationEvidenceDigest = `0x${'dd'.repeat(32)}`;
const otherEnvironmentEvidenceDigest = `0x${'ee'.repeat(32)}`;
const exactImplementationAddress = DETERMINISTIC_DEMO_IDS.delegateAddress;
const staleImplementationAddress = '0x7777777777777777777777777777777777777777';
const otherEnvironmentImplementationAddress = '0x8888888888888888888888888888888888888888';
const failedAttemptId = 'pay_00000000000000000000000002';
const failedOperationId = 'decoy-particle-operation-0002';
const nonParticleActivityUrl = 'https://malicious.invalid/wrong-provider-operation';
const exactParticleActivityUrl = 'https://universalx.app/activity/exact-operation';
const issuedAt = new Date('2026-07-10T12:00:00.000Z');
const capturedAt = new Date('2026-07-14T12:00:00.000Z');
let handle: DatabaseHandle | undefined;
let manager: PostgresJudgeEvidenceManager;
let queries: PostgresBackendApiQueryStore;

const actor = CurrentUserSchema.parse({
  id: UserIdSchema.parse(DETERMINISTIC_DEMO_IDS.merchantUserId),
  walletAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.merchantAddress),
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [
    {
      merchantId: MerchantIdSchema.parse(DETERMINISTIC_DEMO_IDS.merchantId),
      role: 'owner',
    },
  ],
});
const orderId = OrderIdSchema.parse(DETERMINISTIC_DEMO_IDS.orderId);

describe.skipIf(databaseUrl === undefined)('Judge evidence lifecycle', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({ url: databaseUrl, applicationName: 'judge-evidence-tests' });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await seedDeterministicDemo({
      db: handle.db,
      environment: 'test',
      deterministicDemoEnabled: true,
      secretPepper: capabilityPepper,
    });

    await handle.db.insert(canonicalLogs).values({
      id: passLogId,
      chainId: '42161',
      stream: 'pass-v1',
      contractAddress: DETERMINISTIC_DEMO_IDS.passAddress,
      eventName: 'TransferSingle',
      transactionHash: DETERMINISTIC_DEMO_IDS.transactionHash,
      blockNumber: 123456789n,
      blockHash: DETERMINISTIC_DEMO_IDS.blockHash,
      logIndex: 2,
      canonical: true,
      decodedPayload: {
        decoderVersion: 'deterministic-seed-v1',
        fields: {
          operator: DETERMINISTIC_DEMO_IDS.checkoutAddress,
          from: '0x0000000000000000000000000000000000000000',
          to: DETERMINISTIC_DEMO_IDS.customerAddress,
          id: '1',
          value: '1',
        },
        confirmations: '12',
      },
      payloadDigest: `0x${'12'.repeat(32)}`,
      projectionStatus: 'applied',
      observedAt: issuedAt,
      projectedAt: issuedAt,
      createdAt: issuedAt,
    });
    await handle.db
      .update(receipts)
      .set({ chainEventId: passLogId, status: 'issued', issuedAt })
      .where(eq(receipts.orderId, DETERMINISTIC_DEMO_IDS.orderId));

    await handle.db.insert(userIdentities).values([
      {
        id: exactIdentityId,
        userId: DETERMINISTIC_DEMO_IDS.userId,
        provider: 'magic',
        providerSubjectHash: `0x${'13'.repeat(32)}`,
        authMethod: 'google',
        evidenceDigest: `0x${'14'.repeat(32)}`,
        lastVerifiedAt: new Date('2026-07-12T12:00:00.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
      {
        id: tieBreakDecoyIdentityId,
        userId: DETERMINISTIC_DEMO_IDS.userId,
        provider: 'magic',
        providerSubjectHash: `0x${'15'.repeat(32)}`,
        authMethod: 'email_otp',
        evidenceDigest: `0x${'16'.repeat(32)}`,
        lastVerifiedAt: new Date('2026-07-12T12:00:00.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
    ]);

    await handle.db.insert(walletAccounts).values([
      {
        userId: DETERMINISTIC_DEMO_IDS.userId,
        environment: 'test',
        ownerAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
        universalAccountAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
        sdkPackageVersion: '2.0.3',
        protocolVersion: 'eip7702',
        eip7702Enabled: true,
        delegationStatus: 'confirmed',
        arbitrumImplementation: exactImplementationAddress,
        delegationTransactionHash: exactDelegationTransactionHash,
        checkedAt: new Date('2026-07-10T11:00:00.000Z'),
        evidenceDigest: exactDelegationEvidenceDigest,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
      {
        userId: DETERMINISTIC_DEMO_IDS.userId,
        environment: 'local',
        ownerAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
        universalAccountAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
        sdkPackageVersion: 'decoy-sdk',
        protocolVersion: 'decoy-protocol',
        eip7702Enabled: true,
        delegationStatus: 'confirmed',
        arbitrumImplementation: otherEnvironmentImplementationAddress,
        delegationTransactionHash: otherEnvironmentDelegationTransactionHash,
        checkedAt: new Date('2026-07-14T11:00:00.000Z'),
        evidenceDigest: otherEnvironmentEvidenceDigest,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
    ]);

    await handle.db.insert(delegationRecords).values([
      {
        userId: DETERMINISTIC_DEMO_IDS.userId,
        environment: 'test',
        chainId: '42161',
        ownerAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
        implementationAddressLower: exactImplementationAddress,
        implementationCodeHash: `0x${'17'.repeat(32)}`,
        status: 'confirmed',
        transactionHash: exactDelegationTransactionHash,
        blockNumber: 123456700n,
        blockHash: `0x${'18'.repeat(32)}`,
        evidenceDigest: exactDelegationEvidenceDigest,
        checkedAt: new Date('2026-07-10T11:00:00.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
      {
        userId: DETERMINISTIC_DEMO_IDS.userId,
        environment: 'test',
        chainId: '42161',
        ownerAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
        implementationAddressLower: staleImplementationAddress,
        implementationCodeHash: `0x${'19'.repeat(32)}`,
        status: 'confirmed',
        transactionHash: staleDelegationTransactionHash,
        blockNumber: 123456600n,
        blockHash: `0x${'1a'.repeat(32)}`,
        evidenceDigest: staleDelegationEvidenceDigest,
        checkedAt: new Date('2026-07-14T11:30:00.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
      {
        userId: DETERMINISTIC_DEMO_IDS.userId,
        environment: 'local',
        chainId: '42161',
        ownerAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
        implementationAddressLower: otherEnvironmentImplementationAddress,
        implementationCodeHash: `0x${'1b'.repeat(32)}`,
        status: 'confirmed',
        transactionHash: otherEnvironmentDelegationTransactionHash,
        blockNumber: 123456800n,
        blockHash: `0x${'1c'.repeat(32)}`,
        evidenceDigest: otherEnvironmentEvidenceDigest,
        checkedAt: new Date('2026-07-14T11:45:00.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
    ]);

    await handle.db
      .update(paymentAttempts)
      .set({
        preparedRootHashDigest: `0x${'1d'.repeat(32)}`,
        previewDigest: `0x${'1e'.repeat(32)}`,
        submissionStartedAt: issuedAt,
      })
      .where(eq(paymentAttempts.id, DETERMINISTIC_DEMO_IDS.attemptId));
    await handle.db.insert(paymentAttempts).values({
      id: failedAttemptId,
      orderId: DETERMINISTIC_DEMO_IDS.orderId,
      checkoutSessionId: DETERMINISTIC_DEMO_IDS.checkoutSessionId,
      attemptNumber: 2,
      status: 'failed_confirmed',
      bindingDigest: `0x${'1f'.repeat(32)}`,
      providerOperationId: failedOperationId,
      destinationTransactionHash: `0x${'20'.repeat(32)}`,
      terminalAt: new Date('2026-07-13T13:00:00.000Z'),
      createdAt: new Date('2026-07-13T12:00:00.000Z'),
      updatedAt: new Date('2026-07-13T13:00:00.000Z'),
    });

    await handle.db.insert(providerOperations).values([
      {
        provider: 'particle',
        externalId: DETERMINISTIC_DEMO_IDS.providerOperationId,
        paymentAttemptId: DETERMINISTIC_DEMO_IDS.attemptId,
        kind: 'checkout',
        status: 'succeeded',
        submissionPossible: true,
        destinationTransactionHash: DETERMINISTIC_DEMO_IDS.transactionHash,
        activityUrl: exactParticleActivityUrl,
        evidenceDigest: `0x${'21'.repeat(32)}`,
        safeSummary: {
          environment: 'test',
          provenance: 'deterministic',
          sourceChainId: '8453',
          sourceSymbol: 'USDC',
          sourceAmount: '25.00',
          totalUsd: '37.50',
          estimatedFeeUsd: '0.04',
        },
        observedAt: new Date('2026-07-10T12:00:10.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
      {
        provider: 'not-particle',
        externalId: DETERMINISTIC_DEMO_IDS.providerOperationId,
        paymentAttemptId: DETERMINISTIC_DEMO_IDS.attemptId,
        kind: 'wrong_provider',
        status: 'succeeded',
        submissionPossible: true,
        destinationTransactionHash: DETERMINISTIC_DEMO_IDS.transactionHash,
        activityUrl: nonParticleActivityUrl,
        evidenceDigest: `0x${'23'.repeat(32)}`,
        safeSummary: {
          sourceChainId: '999999',
          sourceSymbol: 'WRONG',
          sourceAmount: '999',
          totalUsd: '999',
          estimatedFeeUsd: '999',
        },
        observedAt: new Date('2026-07-14T11:59:00.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
      {
        provider: 'particle',
        externalId: failedOperationId,
        paymentAttemptId: failedAttemptId,
        kind: 'failed_decoy',
        status: 'failed',
        submissionPossible: true,
        destinationTransactionHash: `0x${'20'.repeat(32)}`,
        activityUrl: 'https://malicious.invalid/failed-decoy-operation',
        evidenceDigest: `0x${'24'.repeat(32)}`,
        safeSummary: {
          sourceChainId: '999998',
          sourceSymbol: 'DECOY',
          sourceAmount: '998',
          totalUsd: '998',
          estimatedFeeUsd: '998',
        },
        observedAt: new Date('2026-07-14T11:58:00.000Z'),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
    ]);

    const uow = new PostgresUnitOfWork(handle.db);
    manager = new PostgresJudgeEvidenceManager(
      uow,
      judgePepper,
      {
        environment: 'test',
        checkoutAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.checkoutAddress),
        passAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.passAddress),
        tokenAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.usdcAddress),
        applicationVersion: 'test-build',
        particleSdkVersion: '2.0.3',
        magicSdkVersion: '33.9.0',
        contractsVersion: '1.0.0',
        provenance: 'deterministic',
      },
      () => capturedAt,
    );
    queries = new PostgresBackendApiQueryStore(uow, capabilityPepper, judgePepper);
  }, 30_000);

  afterAll(async () => {
    if (handle === undefined) return;
    await handle.close();
  });

  it('selects exact environment, immutable delegation, paid attempt, and Particle operation evidence', async () => {
    const materialized = await manager.materialize(actor, orderId);

    expect(materialized).toMatchObject({ status: 'unpublished' });
    expect(materialized.proof.account).toEqual({
      magicEoaBefore: DETERMINISTIC_DEMO_IDS.customerAddress,
      magicEoaAfter: DETERMINISTIC_DEMO_IDS.customerAddress,
      addressContinuous: true,
      continuityEvidence: 'deterministic_fixture',
      authMethod: 'google',
      delegationTarget: exactImplementationAddress,
      delegationTransactionHash: exactDelegationTransactionHash,
    });
    expect(materialized.proof.particle).toEqual({
      eip7702Enabled: true,
      eip7702Evidence: 'deterministic_fixture',
      universalAccountAddress: DETERMINISTIC_DEMO_IDS.customerAddress,
      routeEvidence: 'not_evidenced',
      sourceSummary: [],
      operationId: DETERMINISTIC_DEMO_IDS.providerOperationId,
      activityUrl: exactParticleActivityUrl,
    });
    expect(materialized.proof.recovery).toMatchObject({
      submissionPersistedBeforeWait: true,
      submissionPersistenceEvidence: 'deterministic_fixture',
      timing: {
        submissionToCanonicalMs: '0',
        totalDurationMs: '0',
      },
    });
    expect(materialized.proof.settlement).toMatchObject({
      chainId: '42161',
      checkoutAddress: DETERMINISTIC_DEMO_IDS.checkoutAddress,
      passAddress: DETERMINISTIC_DEMO_IDS.passAddress,
      tokenAddress: DETERMINISTIC_DEMO_IDS.usdcAddress,
      amountBaseUnits: '25000000',
      receiptId: DETERMINISTIC_DEMO_IDS.receiptId,
      passTokenId: '1',
      event: {
        eventName: 'OrderPaid',
        canonical: true,
        transactionHash: DETERMINISTIC_DEMO_IDS.transactionHash,
        fields: {
          orderKey: DETERMINISTIC_DEMO_IDS.orderKey,
          passTokenId: '1',
        },
      },
    });
    const serialized = JSON.stringify(materialized.proof);
    expect(serialized).not.toContain(staleDelegationTransactionHash);
    expect(serialized).not.toContain(otherEnvironmentDelegationTransactionHash);
    expect(serialized).not.toContain(staleImplementationAddress);
    expect(serialized).not.toContain(otherEnvironmentImplementationAddress);
    expect(serialized).not.toContain(nonParticleActivityUrl);
    expect(serialized).not.toContain(failedOperationId);
  });

  it('downgrades optional mismatches without leaking delegation or provider decoys', async () => {
    if (handle === undefined) throw new Error('Database was not initialized');
    await handle.db
      .update(walletAccounts)
      .set({ evidenceDigest: `0x${'25'.repeat(32)}` })
      .where(eq(walletAccounts.environment, 'test'));
    await handle.db
      .update(orders)
      .set({ providerOperationId: failedOperationId })
      .where(eq(orders.id, DETERMINISTIC_DEMO_IDS.orderId));

    try {
      const materialized = await manager.materialize(actor, orderId);
      expect(materialized.proof.account).toEqual({
        magicEoaBefore: DETERMINISTIC_DEMO_IDS.customerAddress,
        magicEoaAfter: DETERMINISTIC_DEMO_IDS.customerAddress,
        addressContinuous: false,
        continuityEvidence: 'not_evidenced',
        authMethod: 'google',
      });
      expect(materialized.proof.particle).toEqual({
        eip7702Enabled: false,
        eip7702Evidence: 'not_evidenced',
        universalAccountAddress: DETERMINISTIC_DEMO_IDS.customerAddress,
        routeEvidence: 'not_evidenced',
        sourceSummary: [],
      });
      expect(materialized.proof.recovery).toMatchObject({
        submissionPersistedBeforeWait: false,
        submissionPersistenceEvidence: 'not_evidenced',
      });
      const serialized = JSON.stringify(materialized.proof);
      expect(serialized).not.toContain(exactDelegationTransactionHash);
      expect(serialized).not.toContain(staleDelegationTransactionHash);
      expect(serialized).not.toContain(otherEnvironmentDelegationTransactionHash);
      expect(serialized).not.toContain(exactImplementationAddress);
      expect(serialized).not.toContain(staleImplementationAddress);
      expect(serialized).not.toContain(otherEnvironmentImplementationAddress);
      expect(serialized).not.toContain(nonParticleActivityUrl);
      expect(serialized).not.toContain(failedOperationId);
    } finally {
      await handle.db
        .update(walletAccounts)
        .set({ evidenceDigest: exactDelegationEvidenceDigest })
        .where(eq(walletAccounts.environment, 'test'));
      await handle.db
        .update(orders)
        .set({ providerOperationId: DETERMINISTIC_DEMO_IDS.providerOperationId })
        .where(eq(orders.id, DETERMINISTIC_DEMO_IDS.orderId));
    }
  });

  it('does not claim EIP-7702 evidence recorded at or after settlement', async () => {
    if (handle === undefined) throw new Error('Database was not initialized');
    const variants = [
      { blockNumber: 123456789n, checkedAt: new Date('2026-07-10T11:00:00.000Z') },
      { blockNumber: 123456700n, checkedAt: new Date('2026-07-10T12:00:01.000Z') },
    ] as const;
    try {
      for (const variant of variants) {
        await handle.db
          .update(delegationRecords)
          .set(variant)
          .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
        const materialized = await manager.materialize(actor, orderId);
        expect(materialized.proof.account).toMatchObject({
          addressContinuous: false,
          continuityEvidence: 'not_evidenced',
        });
        expect(materialized.proof.particle).toMatchObject({
          eip7702Enabled: false,
          eip7702Evidence: 'not_evidenced',
        });
      }
    } finally {
      await handle.db
        .update(delegationRecords)
        .set({
          blockNumber: 123456700n,
          checkedAt: new Date('2026-07-10T11:00:00.000Z'),
        })
        .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
    }
  });

  it('rejects an issued receipt that is not linked to its canonical pass mint', async () => {
    if (handle === undefined) throw new Error('Database was not initialized');
    await handle.db
      .update(receipts)
      .set({ chainEventId: DETERMINISTIC_DEMO_IDS.canonicalLogId })
      .where(eq(receipts.orderId, DETERMINISTIC_DEMO_IDS.orderId));
    try {
      await expect(manager.materialize(actor, orderId)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_CANONICAL',
      });
    } finally {
      await handle.db
        .update(receipts)
        .set({ chainEventId: passLogId })
        .where(eq(receipts.orderId, DETERMINISTIC_DEMO_IDS.orderId));
    }
  });

  it('rejects a canonical pass mint whose operator is not the checkout contract', async () => {
    if (handle === undefined) throw new Error('Database was not initialized');
    const exactPassPayload = {
      decoderVersion: 'deterministic-seed-v1',
      fields: {
        operator: DETERMINISTIC_DEMO_IDS.checkoutAddress,
        from: '0x0000000000000000000000000000000000000000',
        to: DETERMINISTIC_DEMO_IDS.customerAddress,
        id: '1',
        value: '1',
      },
      confirmations: '12',
    };
    await handle.db
      .update(canonicalLogs)
      .set({
        decodedPayload: {
          ...exactPassPayload,
          fields: {
            ...exactPassPayload.fields,
            operator: '0x9999999999999999999999999999999999999999',
          },
        },
      })
      .where(eq(canonicalLogs.id, passLogId));
    try {
      await expect(manager.materialize(actor, orderId)).rejects.toMatchObject({
        code: 'PAYMENT_EVENT_MISMATCH',
      });
    } finally {
      await handle.db
        .update(canonicalLogs)
        .set({ decodedPayload: exactPassPayload })
        .where(eq(canonicalLogs.id, passLogId));
    }
  });

  it('preserves evidence identity, rotates protected access on rematerialization, and revokes it', async () => {
    if (handle === undefined) throw new Error('Database was not initialized');
    const first = await manager.materialize(actor, orderId);
    const firstPublished = await manager.publish(actor, orderId, {
      protected: true,
      expiresAt: '2030-07-15T12:00:00.000Z',
    });
    expect(firstPublished.shareToken).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect((await queries.getJudgeProof(orderId, firstPublished.shareToken))?.evidenceId).toBe(
      first.proof.evidenceId,
    );

    const rematerialized = await manager.materialize(actor, orderId);
    expect(rematerialized.proof.evidenceId).toBe(first.proof.evidenceId);
    expect(await queries.getJudgeProof(orderId, firstPublished.shareToken)).toBeUndefined();
    const [stored] = await handle.db
      .select({
        evidenceId: judgeEvidence.evidenceId,
        publicProof: judgeEvidence.publicProof,
        publicProofDigest: judgeEvidence.publicProofDigest,
      })
      .from(judgeEvidence)
      .where(eq(judgeEvidence.orderId, DETERMINISTIC_DEMO_IDS.orderId));
    expect(stored?.evidenceId).toBe(rematerialized.proof.evidenceId);
    expect(stored?.publicProof.evidenceId).toBe(rematerialized.proof.evidenceId);
    expect(stored?.publicProofDigest).toBe(createLiveAcceptancePayloadDigest(rematerialized.proof));

    const republished = await manager.publish(actor, orderId, {
      protected: true,
      expiresAt: '2030-07-15T12:00:00.000Z',
    });
    expect(republished.evidenceId).toBe(rematerialized.proof.evidenceId);
    expect(republished.shareToken).not.toBe(firstPublished.shareToken);
    const publicProof = await queries.getJudgeProof(orderId, republished.shareToken);
    expect(publicProof?.evidenceId).toBe(rematerialized.proof.evidenceId);
    expect(JSON.stringify(publicProof)).not.toContain(republished.shareToken);
    expect(JSON.stringify(publicProof)).not.toMatch(
      /did[-_ ]?token|private[-_ ]?key|session[-_ ]?cookie/i,
    );

    await handle.db
      .update(canonicalLogs)
      .set({ canonical: false })
      .where(eq(canonicalLogs.id, DETERMINISTIC_DEMO_IDS.canonicalLogId));
    expect(await queries.getJudgeProof(orderId, republished.shareToken)).toBeUndefined();
    await handle.db
      .update(canonicalLogs)
      .set({ canonical: true })
      .where(eq(canonicalLogs.id, DETERMINISTIC_DEMO_IDS.canonicalLogId));
    expect((await queries.getJudgeProof(orderId, republished.shareToken))?.evidenceId).toBe(
      rematerialized.proof.evidenceId,
    );

    const ancestorHash = `0x${'31'.repeat(32)}` as const;
    const newHeadHash = `0x${'32'.repeat(32)}` as const;
    await handle.db.insert(indexedBlocks).values([
      {
        chainId: '42161',
        stream: 'checkout-v1',
        blockNumber: 123456788n,
        blockHash: ancestorHash,
        parentHash: `0x${'30'.repeat(32)}`,
        canonical: true,
        observedAt: issuedAt,
      },
      {
        chainId: '42161',
        stream: 'checkout-v1',
        blockNumber: 123456789n,
        blockHash: DETERMINISTIC_DEMO_IDS.blockHash,
        parentHash: ancestorHash,
        canonical: true,
        observedAt: issuedAt,
      },
    ]);
    await handle.db.insert(indexerCursors).values({
      chainId: '42161',
      stream: 'checkout-v1',
      nextBlock: 123456790n,
      lastProcessedBlock: 123456789n,
      lastProcessedBlockHash: DETERMINISTIC_DEMO_IDS.blockHash,
      confirmationDepth: 12,
      updatedAt: issuedAt,
    });
    const indexerStore = new PostgresIndexerStore(new PostgresUnitOfWork(handle.db));
    await indexerStore.rewind({
      cursor: {
        chainId: ChainIdSchema.parse('42161'),
        stream: 'checkout-v1',
        nextBlock: 123456790n,
        lastProcessedBlock: 123456789n,
        lastProcessedBlockHash: DETERMINISTIC_DEMO_IDS.blockHash,
        confirmationDepth: 12,
      },
      details: {
        detectedAtBlock: 123456789n,
        commonAncestorBlock: 123456788n,
        oldHeadHash: DETERMINISTIC_DEMO_IDS.blockHash,
        newHeadHash,
      },
      now: new Date('2026-07-14T12:05:00.000Z'),
    });
    expect(await queries.getJudgeProof(orderId, republished.shareToken)).toBeUndefined();
    const [revoked] = await handle.db
      .select({
        published: judgeEvidence.published,
        shareTokenHash: judgeEvidence.shareTokenHash,
        expiresAt: judgeEvidence.expiresAt,
        revokedAt: judgeEvidence.revokedAt,
      })
      .from(judgeEvidence)
      .where(eq(judgeEvidence.orderId, DETERMINISTIC_DEMO_IDS.orderId));
    expect(revoked).toEqual({
      published: false,
      shareTokenHash: null,
      expiresAt: null,
      revokedAt: new Date('2026-07-14T12:05:00.000Z'),
    });
    const [failedAttempt] = await handle.db
      .select({
        status: paymentAttempts.status,
        terminalAt: paymentAttempts.terminalAt,
        reconciliationRequired: paymentAttempts.reconciliationRequired,
      })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, failedAttemptId));
    expect(failedAttempt).toEqual({
      status: 'failed_confirmed',
      terminalAt: new Date('2026-07-13T13:00:00.000Z'),
      reconciliationRequired: false,
    });
  });
});
