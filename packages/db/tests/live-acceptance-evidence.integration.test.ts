import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ChainIdSchema,
  CurrentUserSchema,
  createLiveAcceptanceReceipt,
  digestLiveAcceptanceDeploymentConfig,
  digestLiveAcceptanceFile,
  digestUnknown,
  EvmAddressSchema,
  LiveAcceptanceEvidenceInputSchema,
  MerchantIdSchema,
  OrderIdSchema,
  serializeLiveAcceptanceArtifact,
  UserIdSchema,
  verifyLiveAcceptanceReceipt,
} from '@opentab/shared';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBackendApiQueryStore } from '../src/api-query-store.js';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { assertEvidenceWriterDatabasePrivileges } from '../src/evidence-writer-privileges.js';
import { PostgresJudgeEvidenceManager } from '../src/judge-evidence.js';
import {
  createLiveAcceptanceAttestation,
  PostgresLiveAcceptanceEvidenceStore,
  verifyLiveAcceptanceAttestation,
} from '../src/live-acceptance-evidence.js';
import { PostgresPaymentReconciliationStore } from '../src/reconciliation-store.js';
import {
  canonicalLogs,
  checkoutSessions,
  delegationRecords,
  liveAcceptanceEvidence,
  orders,
  paymentAttempts,
  providerOperations,
  receipts,
  signedOrderIntents,
  userIdentities,
  walletAccounts,
} from '../src/schema/index.js';
import { DETERMINISTIC_DEMO_IDS, seedDeterministicDemo } from '../src/seed.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const execFile = promisify(execFileCallback);
const capabilityPepper = 'live-acceptance-capability-pepper'.padEnd(40, 'c');
const judgePepper = 'live-acceptance-judge-share-pepper'.padEnd(40, 'j');
const attestationSecret = 'live-acceptance-attestation-secret'.padEnd(48, 'a');
const startedAt = new Date('2026-07-09T12:00:00.000Z');
const issuedAt = new Date('2026-07-10T12:00:00.000Z');
const freshRpcObservedAt = new Date('2026-07-10T12:01:00.000Z');
const recoveryObservedAt = new Date('2026-07-10T12:05:00.000Z');
const capturedAt = new Date('2026-07-10T12:10:00.000Z');
const expiresAt = new Date('2026-07-10T12:30:00.000Z');
const live = {
  checkoutSessionId: 'chk_00000000000000000000000099',
  orderId: 'ord_00000000000000000000000099',
  attemptId: 'pay_00000000000000000000000099',
  receiptId: 'rcp_00000000000000000000000099',
  paymentLogId: '00000000-0000-4000-8000-000000000201',
  passLogId: '00000000-0000-4000-8000-000000000202',
  orderKey: `0x${'81'.repeat(32)}`,
  transactionHash: `0x${'82'.repeat(32)}`,
  blockHash: `0x${'83'.repeat(32)}`,
  intentDigest: `0x${'84'.repeat(32)}`,
  bindingDigest: `0x${'85'.repeat(32)}`,
  metadataHash: `0x${'86'.repeat(32)}`,
  providerOperationId: 'live-acceptance-particle-operation-99',
} as const;
const exactPreviewDigest = '0x50574980869720a8fc05e3814f070a49114c267b3d066e6885fb107d5c27b34b';
const exactPreparedEvidenceDigest = `0x${'92'.repeat(32)}`;
const exactProviderEvidenceDigest = `0x${'93'.repeat(32)}`;
const exactDelegationEvidenceDigest = `0x${'94'.repeat(32)}`;
const exactDelegationTransactionHash = `0x${'95'.repeat(32)}`;
const exactDelegationBlockHash = `0x${'96'.repeat(32)}`;
const exactImplementationCodeHash = `0x${'97'.repeat(32)}`;
const exactActivityUrl = 'https://universalx.app/activity/exact-live-acceptance';
const exactReleaseId = 'a1'.repeat(20);
const exactFixtureDigests = {
  deployments: `0x${'a2'.repeat(32)}`,
  authorization: `0x${'a3'.repeat(32)}`,
  submission: `0x${'a4'.repeat(32)}`,
  status: `0x${'a5'.repeat(32)}`,
} as const;
const exactSourceCallProfiles = [{ profileId: 'base-usdc-live-v1' }] as const;
const exactResponseProfileId = 'recorded-live-production-v1';
const exactDeploymentConfigDigest = digestLiveAcceptanceDeploymentConfig({
  domain: 'opentab/live-acceptance-deployment-config',
  releaseId: exactReleaseId,
  environment: 'production',
  chainId: '42161',
  checkoutAddress: DETERMINISTIC_DEMO_IDS.checkoutAddress,
  passAddress: DETERMINISTIC_DEMO_IDS.passAddress,
  tokenAddress: DETERMINISTIC_DEMO_IDS.usdcAddress,
  expectedDelegationImplementation: DETERMINISTIC_DEMO_IDS.delegateAddress,
  expectedDelegationCodeHash: exactImplementationCodeHash,
  particleSdkVersion: '2.0.3',
  particleResponseProfileId: exactResponseProfileId,
  particleFixtureSetDigest: digestUnknown(exactFixtureDigests),
  particleSourceCallProfilesDigest: digestUnknown(exactSourceCallProfiles),
  confirmationDepth: '12',
  maximumSlippageBps: '50',
  allowedSourceChainIds: ['8453'],
  allowedSourceAssets: ['USDC', 'USDT'],
});
const wrongTransactionHash = `0x${'98'.repeat(32)}`;
const wrongDeploymentConfigDigest = `0x${'ff'.repeat(32)}`;
let handle: DatabaseHandle | undefined;
let store: PostgresLiveAcceptanceEvidenceStore;
let productionJudge: PostgresJudgeEvidenceManager;
let mismatchedProvenanceJudge: PostgresJudgeEvidenceManager;
const evidenceWriterRole = `opentab_evidence_${randomUUID().replaceAll('-', '')}`;
const evidenceWriterPassword = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
let evidenceWriterDatabaseUrl: string | undefined;
let evidenceWriterRoleCreated = false;
let evidenceWriterHandle: DatabaseHandle | undefined;

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
const liveOrderId = OrderIdSchema.parse(live.orderId);

const exactInput = LiveAcceptanceEvidenceInputSchema.parse({
  schemaVersion: 1,
  environment: 'production',
  releaseId: exactReleaseId,
  deploymentConfigDigest: exactDeploymentConfigDigest,
  orderId: live.orderId,
  paymentAttemptId: live.attemptId,
  providerOperationId: live.providerOperationId,
  providerOperation: {
    id: live.providerOperationId,
    status: 'succeeded',
    submissionPossible: true,
    destinationTransactionHash: live.transactionHash,
    activityUrl: exactActivityUrl,
    updatedAt: '2026-07-10T12:04:00.000Z',
    evidence: {
      adapter: 'particle-get-transaction',
      packageVersion: '2.0.3',
      schemaVersion: 1,
      environment: 'production',
      observedAt: '2026-07-10T12:04:00.000Z',
      evidenceDigest: exactProviderEvidenceDigest,
      provenance: 'live',
    },
  },
  context: {
    ownerAddress: DETERMINISTIC_DEMO_IDS.customerAddress,
    authMethod: 'email_otp',
    activationPath: 'self_funded_type4',
    delegationTransactionHash: exactDelegationTransactionHash,
    particleProtocolVersion: 'eip7702',
    useEIP7702: true,
    safeAccountIdentifiers: [DETERMINISTIC_DEMO_IDS.customerAddress],
  },
  startedAt: startedAt.toISOString(),
  route: {
    totalUsd: '0.51',
    estimatedFeeUsd: '0.01',
    slippageBps: '50',
    quotedAt: '2026-07-10T11:55:00.000Z',
    expiresAt: expiresAt.toISOString(),
    previewDigest: exactPreviewDigest,
    sources: [{ chainId: '8453', symbol: 'USDC', amount: '0.51', amountUsd: '0.51' }],
    activityUrl: exactActivityUrl,
  },
  settlement: {
    event: {
      eventName: 'OrderPaid',
      chainId: '42161',
      contractAddress: DETERMINISTIC_DEMO_IDS.checkoutAddress,
      transactionHash: live.transactionHash,
      blockNumber: '123456789',
      blockHash: live.blockHash,
      logIndex: '1',
      confirmations: '18',
      canonical: true,
      observedAt: freshRpcObservedAt.toISOString(),
      fields: {
        orderKey: live.orderKey,
        merchantOnchainId: '1',
        productOnchainId: '1',
        payer: DETERMINISTIC_DEMO_IDS.customerAddress,
        recipient: DETERMINISTIC_DEMO_IDS.customerAddress,
        token: DETERMINISTIC_DEMO_IDS.usdcAddress,
        quantity: '1',
        amountBaseUnits: '500000',
        platformFeeBaseUnits: '0',
        intentDigest: live.intentDigest,
        passTokenId: '1',
        refundDeadline: '1783771200',
      },
    },
    receiptId: live.receiptId,
    passTokenId: '1',
  },
  recovery: {
    browserReloadObserved: true,
    finalOrderStatus: 'paid',
    sponsorGrantCount: 0,
    delegationCount: 1,
    orderCount: 1,
    paymentAttemptCount: 1,
    providerOperationCount: 1,
    submissionCount: 1,
    receiptCount: 1,
    observedAt: recoveryObservedAt.toISOString(),
  },
  timingMs: {
    magicAuthentication: 1000,
    particlePreview: 2000,
    particleSubmission: 500,
    canonicalArbitrumPayment: 2500,
    restartRecovery: 1000,
  },
  capturedAt: capturedAt.toISOString(),
});

function parseVariant(value: unknown) {
  return LiveAcceptanceEvidenceInputSchema.parse(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requiredEvidenceWriterUrl(): string {
  if (evidenceWriterDatabaseUrl === undefined) {
    throw new Error('Evidence-writer role was not provisioned');
  }
  return evidenceWriterDatabaseUrl;
}

describe.skipIf(databaseUrl === undefined)('append-only live acceptance evidence', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({ url: databaseUrl, applicationName: 'live-acceptance-tests' });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await seedDeterministicDemo({
      db: handle.db,
      environment: 'test',
      deterministicDemoEnabled: true,
      secretPepper: capabilityPepper,
    });

    await handle.db.insert(checkoutSessions).values({
      id: live.checkoutSessionId,
      userId: DETERMINISTIC_DEMO_IDS.userId,
      productId: DETERMINISTIC_DEMO_IDS.productId,
      productVersion: 1,
      quantity: '1',
      receiptRecipient: DETERMINISTIC_DEMO_IDS.customerAddress,
      amountBaseUnits: '500000',
      orderKey: live.orderKey,
      status: 'consumed',
      expiresAt: new Date('2030-07-10T12:00:00.000Z'),
      bindingDigest: live.bindingDigest,
      boundAt: issuedAt,
      consumedAt: issuedAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
    await handle.db.insert(signedOrderIntents).values({
      checkoutSessionId: live.checkoutSessionId,
      orderKey: live.orderKey,
      digest: live.intentDigest,
      signerAddress: DETERMINISTIC_DEMO_IDS.merchantAddress,
      signerKeyId: 'live-acceptance-test-key',
      intent: {
        orderKey: live.orderKey,
        payer: DETERMINISTIC_DEMO_IDS.customerAddress,
        recipient: DETERMINISTIC_DEMO_IDS.customerAddress,
        merchantId: '1',
        productId: '1',
        token: DETERMINISTIC_DEMO_IDS.usdcAddress,
        amountBaseUnits: '500000',
        platformFeeBaseUnits: '0',
        quantity: '1',
        refundDeadline: '1783771200',
      },
      signature: `0x${'9b'.repeat(65)}`,
      validAfter: issuedAt,
      validUntil: new Date('2030-07-10T12:00:00.000Z'),
      refundableUntil: new Date('2026-07-11T12:00:00.000Z'),
      createdAt: issuedAt,
    });
    await handle.db.insert(orders).values({
      id: live.orderId,
      checkoutSessionId: live.checkoutSessionId,
      orderKey: live.orderKey,
      userId: DETERMINISTIC_DEMO_IDS.userId,
      merchantId: DETERMINISTIC_DEMO_IDS.merchantId,
      productId: DETERMINISTIC_DEMO_IDS.productId,
      payer: DETERMINISTIC_DEMO_IDS.customerAddress,
      recipient: DETERMINISTIC_DEMO_IDS.customerAddress,
      tokenAddress: DETERMINISTIC_DEMO_IDS.usdcAddress,
      quantity: '1',
      amountBaseUnits: '500000',
      paidAmountBaseUnits: '500000',
      status: 'paid',
      chainId: '42161',
      transactionHash: live.transactionHash,
      blockNumber: 123456789n,
      blockHash: live.blockHash,
      logIndex: 1,
      providerOperationId: live.providerOperationId,
      intentDigest: live.intentDigest,
      refundableUntil: new Date('2026-07-11T12:00:00.000Z'),
      confirmedAt: issuedAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
    await handle.db.insert(paymentAttempts).values({
      id: live.attemptId,
      orderId: live.orderId,
      checkoutSessionId: live.checkoutSessionId,
      attemptNumber: 1,
      status: 'paid',
      bindingDigest: live.bindingDigest,
      preparedRootHashDigest: `0x${'9a'.repeat(32)}`,
      previewDigest: exactPreviewDigest,
      quoteSummary: {
        sourceAmountBaseUnits: '500000',
        destinationAmountBaseUnits: '500000',
        feeBaseUnits: '10000',
        routeLabel: 'Particle Universal Account to Arbitrum One',
      },
      preparedExpiresAt: expiresAt,
      providerOperationId: live.providerOperationId,
      destinationTransactionHash: live.transactionHash,
      submissionStartedAt: issuedAt,
      submittedAt: issuedAt,
      terminalAt: issuedAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
    await handle.db.insert(canonicalLogs).values({
      id: live.paymentLogId,
      chainId: '42161',
      stream: 'checkout-v1-live-acceptance',
      contractAddress: DETERMINISTIC_DEMO_IDS.checkoutAddress,
      eventName: 'OrderPaid',
      transactionHash: live.transactionHash,
      blockNumber: 123456789n,
      blockHash: live.blockHash,
      logIndex: 1,
      canonical: true,
      decodedPayload: {
        decoderVersion: 'live-acceptance-test-v1',
        fields: {
          orderKey: live.orderKey,
          merchantId: '1',
          productId: '1',
          payer: DETERMINISTIC_DEMO_IDS.customerAddress,
          recipient: DETERMINISTIC_DEMO_IDS.customerAddress,
          token: DETERMINISTIC_DEMO_IDS.usdcAddress,
          quantity: '1',
          amount: '500000',
          platformFee: '0',
          intentDigest: live.intentDigest,
          passTokenId: '1',
          refundDeadline: '1783771200',
        },
        confirmations: '12',
      },
      payloadDigest: `0x${'9c'.repeat(32)}`,
      projectionStatus: 'applied',
      observedAt: issuedAt,
      projectedAt: issuedAt,
      createdAt: issuedAt,
    });
    await handle.db.insert(canonicalLogs).values({
      id: live.passLogId,
      chainId: '42161',
      stream: 'pass-v1',
      contractAddress: DETERMINISTIC_DEMO_IDS.passAddress,
      eventName: 'TransferSingle',
      transactionHash: live.transactionHash,
      blockNumber: 123456789n,
      blockHash: live.blockHash,
      logIndex: 2,
      canonical: true,
      decodedPayload: {
        decoderVersion: 'live-acceptance-test-v1',
        fields: {
          operator: DETERMINISTIC_DEMO_IDS.checkoutAddress,
          from: '0x0000000000000000000000000000000000000000',
          to: DETERMINISTIC_DEMO_IDS.customerAddress,
          id: '1',
          value: '1',
        },
        confirmations: '12',
      },
      payloadDigest: `0x${'99'.repeat(32)}`,
      projectionStatus: 'applied',
      observedAt: issuedAt,
      projectedAt: issuedAt,
      createdAt: issuedAt,
    });
    await handle.db.insert(receipts).values({
      id: live.receiptId,
      orderId: live.orderId,
      tokenId: '1',
      metadataUri: 'https://example.invalid/opentab/live-acceptance/receipt/1',
      metadataHash: live.metadataHash,
      status: 'issued',
      chainEventId: live.passLogId,
      issuedAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
    await handle.db.insert(providerOperations).values({
      provider: 'particle',
      externalId: live.providerOperationId,
      paymentAttemptId: live.attemptId,
      kind: 'checkout',
      status: 'executing',
      submissionPossible: false,
      activityUrl: exactActivityUrl,
      evidenceDigest: `0x${'92'.repeat(32)}`,
      safeSummary: {
        stage: 'persisted_before_submission',
      },
      observedAt: issuedAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
    await handle.db.insert(walletAccounts).values({
      userId: DETERMINISTIC_DEMO_IDS.userId,
      environment: 'production',
      ownerAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
      universalAccountAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
      sdkPackageVersion: '2.0.3',
      protocolVersion: 'eip7702',
      eip7702Enabled: true,
      delegationStatus: 'confirmed',
      arbitrumImplementation: DETERMINISTIC_DEMO_IDS.delegateAddress,
      delegationTransactionHash: exactDelegationTransactionHash,
      checkedAt: new Date('2026-07-10T11:00:00.000Z'),
      evidenceDigest: exactDelegationEvidenceDigest,
      createdAt: new Date('2026-07-09T12:05:00.000Z'),
      updatedAt: issuedAt,
    });
    await handle.db.insert(delegationRecords).values({
      userId: DETERMINISTIC_DEMO_IDS.userId,
      environment: 'production',
      chainId: '42161',
      ownerAddressLower: DETERMINISTIC_DEMO_IDS.customerAddress,
      implementationAddressLower: DETERMINISTIC_DEMO_IDS.delegateAddress,
      implementationCodeHash: exactImplementationCodeHash,
      status: 'confirmed',
      transactionHash: exactDelegationTransactionHash,
      blockNumber: 123456700n,
      blockHash: exactDelegationBlockHash,
      evidenceDigest: exactDelegationEvidenceDigest,
      checkedAt: new Date('2026-07-10T11:00:00.000Z'),
      createdAt: new Date('2026-07-09T12:05:00.000Z'),
      updatedAt: issuedAt,
    });

    const parsedDatabaseUrl = new URL(databaseUrl);
    await execFile(
      'psql',
      [
        databaseUrl,
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--file',
        fileURLToPath(new URL('../operations/provision-evidence-writer-role.sql', import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          OPENTAB_EVIDENCE_WRITER_ROLE: evidenceWriterRole,
          OPENTAB_EVIDENCE_WRITER_PASSWORD: evidenceWriterPassword,
        },
      },
    );
    evidenceWriterRoleCreated = true;
    parsedDatabaseUrl.username = evidenceWriterRole;
    parsedDatabaseUrl.password = evidenceWriterPassword;
    evidenceWriterDatabaseUrl = parsedDatabaseUrl.toString();
    evidenceWriterHandle = createDatabase({
      url: evidenceWriterDatabaseUrl,
      maxConnections: 1,
      applicationName: 'live-acceptance-evidence-writer-tests',
    });

    store = new PostgresLiveAcceptanceEvidenceStore(
      new PostgresUnitOfWork(evidenceWriterHandle.db),
      {
        checkoutAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.checkoutAddress),
        passAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.passAddress),
        tokenAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.usdcAddress),
        deploymentConfigDigest: exactDeploymentConfigDigest,
        minimumConfirmations: 12n,
        allowedSourceChainIds: [ChainIdSchema.parse('8453')],
        allowedSourceSymbols: ['USDC', 'USDT'],
        maximumSlippageBps: 50n,
        attestationSecret,
      },
      () => new Date('2026-07-14T12:00:00.000Z'),
    );
    productionJudge = new PostgresJudgeEvidenceManager(
      new PostgresUnitOfWork(handle.db),
      judgePepper,
      {
        environment: 'production',
        checkoutAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.checkoutAddress),
        passAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.passAddress),
        tokenAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.usdcAddress),
        applicationVersion: exactReleaseId,
        deploymentConfigDigest: exactDeploymentConfigDigest,
        particleSdkVersion: '2.0.3',
        magicSdkVersion: '33.9.0',
        contractsVersion: '1.0.0',
        provenance: 'live',
        acceptanceAttestationSecret: attestationSecret,
      },
      () => new Date('2026-07-14T12:00:00.000Z'),
    );
    mismatchedProvenanceJudge = new PostgresJudgeEvidenceManager(
      new PostgresUnitOfWork(handle.db),
      judgePepper,
      {
        environment: 'production',
        checkoutAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.checkoutAddress),
        passAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.passAddress),
        tokenAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.usdcAddress),
        applicationVersion: exactReleaseId,
        deploymentConfigDigest: exactDeploymentConfigDigest,
        particleSdkVersion: '2.0.3',
        magicSdkVersion: '33.9.0',
        contractsVersion: '1.0.0',
        provenance: 'recorded_live',
        acceptanceAttestationSecret: attestationSecret,
      },
      () => new Date('2026-07-14T12:00:00.000Z'),
    );
  }, 30_000);

  afterAll(async () => {
    if (handle === undefined) return;
    await evidenceWriterHandle?.close();
    if (evidenceWriterRoleCreated) {
      await handle.db.execute(sql.raw(`drop owned by ${quoteIdentifier(evidenceWriterRole)}`));
      await handle.db.execute(sql.raw(`drop role ${quoteIdentifier(evidenceWriterRole)}`));
    }
    await handle.close();
  });

  it('fails closed on writer membership, CREATE, and object ownership drift', async () => {
    if (handle === undefined || evidenceWriterHandle === undefined || databaseUrl === undefined) {
      throw new Error('Evidence-writer test database was not initialized');
    }
    const membershipRole = `opentab_membership_${randomUUID().replaceAll('-', '')}`;
    const ownedSchema = `opentab_owned_${randomUUID().replaceAll('-', '')}`;
    const reprovision = async () =>
      execFile(
        'psql',
        [
          databaseUrl,
          '--no-psqlrc',
          '--set',
          'ON_ERROR_STOP=1',
          '--file',
          fileURLToPath(
            new URL('../operations/provision-evidence-writer-role.sql', import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            OPENTAB_EVIDENCE_WRITER_ROLE: evidenceWriterRole,
            OPENTAB_EVIDENCE_WRITER_PASSWORD: evidenceWriterPassword,
          },
        },
      );

    await expect(assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db)).resolves.toBe(
      undefined,
    );

    await handle.db.execute(sql.raw(`create role ${quoteIdentifier(membershipRole)} nologin`));
    try {
      await handle.db.execute(
        sql.raw(
          `grant ${quoteIdentifier(membershipRole)} to ${quoteIdentifier(evidenceWriterRole)}`,
        ),
      );
      await expect(
        assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
      await reprovision();
      await expect(assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db)).resolves.toBe(
        undefined,
      );

      await handle.db.execute(
        sql.raw(
          `grant select (id) on table public.audit_logs to ${quoteIdentifier(evidenceWriterRole)}`,
        ),
      );
      await handle.db.execute(
        sql.raw(
          `grant update (environment), references (id) on table public.live_acceptance_evidence to ${quoteIdentifier(evidenceWriterRole)}`,
        ),
      );
      await expect(
        assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
      await reprovision();
      await expect(assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db)).resolves.toBe(
        undefined,
      );

      const parsedDatabaseUrl = new URL(databaseUrl);
      const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
      await handle.db.execute(
        sql.raw(
          `grant create, temporary on database ${quoteIdentifier(databaseName)} to ${quoteIdentifier(evidenceWriterRole)}`,
        ),
      );
      await handle.db.execute(
        sql.raw(`grant create on schema public to ${quoteIdentifier(evidenceWriterRole)}`),
      );
      await expect(
        assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
      await reprovision();
      await expect(assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db)).resolves.toBe(
        undefined,
      );

      await handle.db.execute(
        sql.raw(
          `create schema ${quoteIdentifier(ownedSchema)} authorization ${quoteIdentifier(evidenceWriterRole)}`,
        ),
      );
      await expect(
        assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
      await expect(reprovision()).rejects.toBeTruthy();
    } finally {
      await handle.db.execute(
        sql.raw(`drop schema if exists ${quoteIdentifier(ownedSchema)} cascade`),
      );
      await handle.db.execute(
        sql.raw(
          `revoke ${quoteIdentifier(membershipRole)} from ${quoteIdentifier(evidenceWriterRole)}`,
        ),
      );
      await handle.db.execute(sql.raw(`drop role ${quoteIdentifier(membershipRole)}`));
      await reprovision();
    }
    await expect(assertEvidenceWriterDatabasePrivileges(evidenceWriterHandle.db)).resolves.toBe(
      undefined,
    );
  }, 30_000);

  async function evidenceCount(): Promise<number> {
    if (handle === undefined) throw new Error('Database was not initialized');
    const [row] = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(liveAcceptanceEvidence);
    return row?.count ?? 0;
  }

  async function rejectsWithoutEvidence(value: unknown): Promise<void> {
    await expect(store.accept(value)).rejects.toBeTruthy();
    expect(await evidenceCount()).toBe(0);
  }

  it('rejects forged route and every wrong durable binding without creating evidence', async () => {
    await rejectsWithoutEvidence(exactInput);
    await rejectsWithoutEvidence({
      ...exactInput,
      route: {
        ...exactInput.route,
        preparedEvidenceDigest: exactPreparedEvidenceDigest,
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      orderId: 'ord_00000000000000000000000098',
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      paymentAttemptId: 'pay_00000000000000000000000098',
    });
    await rejectsWithoutEvidence({ ...exactInput, providerOperationId: 'wrong-live-operation' });
    await rejectsWithoutEvidence({ ...exactInput, environment: 'demo-mainnet' });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: { ...exactInput.route, totalUsd: '0.52' },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: {
        ...exactInput.route,
        sources: [{ ...exactInput.route.sources[0], symbol: 'USDT' }],
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: {
        ...exactInput.route,
        sources: [{ ...exactInput.route.sources[0], amount: '0.510001' }],
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: {
        ...exactInput.route,
        sources: [
          { chainId: '8453', symbol: 'USDC', amount: '0.255', amountUsd: '0.255' },
          { chainId: '8453', symbol: 'USDC', amount: '0.255', amountUsd: '0.255' },
        ],
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: { ...exactInput.route, slippageBps: '49' },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: { ...exactInput.route, quotedAt: '2026-07-10T11:55:01.000Z' },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: {
        ...exactInput.route,
        sources: [{ ...exactInput.route.sources[0], amountUsd: '0.50' }],
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: {
        ...exactInput.route,
        sources: [{ ...exactInput.route.sources[0], chainId: '10' }],
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      route: { ...exactInput.route, activityUrl: 'https://universalx.app/activity/forged' },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      settlement: {
        ...exactInput.settlement,
        event: { ...exactInput.settlement.event, transactionHash: wrongTransactionHash },
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      settlement: {
        ...exactInput.settlement,
        event: { ...exactInput.settlement.event, blockHash: wrongTransactionHash },
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      settlement: {
        ...exactInput.settlement,
        event: { ...exactInput.settlement.event, logIndex: '9' },
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      settlement: {
        ...exactInput.settlement,
        event: {
          ...exactInput.settlement.event,
          fields: {
            ...exactInput.settlement.event.fields,
            payer: '0x9999999999999999999999999999999999999999',
          },
        },
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      settlement: {
        ...exactInput.settlement,
        event: { ...exactInput.settlement.event, confirmations: '11' },
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      settlement: { ...exactInput.settlement, receiptId: 'rcp_00000000000000000000000098' },
    });

    if (handle === undefined) throw new Error('Database was not initialized');
    await handle.db
      .update(delegationRecords)
      .set({ status: 'mismatch' })
      .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db
        .update(delegationRecords)
        .set({ status: 'confirmed' })
        .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
    }

    const originalQuoteSummary = {
      sourceAmountBaseUnits: '500000',
      destinationAmountBaseUnits: '500000',
      feeBaseUnits: '10000',
      routeLabel: 'Particle Universal Account to Arbitrum One',
    };
    await handle.db
      .update(paymentAttempts)
      .set({ quoteSummary: { ...originalQuoteSummary, destinationAmountBaseUnits: '1' } })
      .where(eq(paymentAttempts.id, live.attemptId));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db
        .update(paymentAttempts)
        .set({ quoteSummary: originalQuoteSummary })
        .where(eq(paymentAttempts.id, live.attemptId));
    }

    const absentProof = await productionJudge.materialize(actor, liveOrderId);
    expect(absentProof.proof.particle).toMatchObject({
      routeEvidence: 'not_evidenced',
      sourceSummary: [],
    });
    expect(absentProof.proof.particle).not.toHaveProperty('totalUsd');
    expect(absentProof.proof.recovery).toMatchObject({
      reloadRecovered: false,
      reloadRecoveryEvidence: 'not_evidenced',
      duplicatePrevented: false,
      duplicatePreventionEvidence: 'not_evidenced',
    });
  });

  it('accepts a fresher RPC observation of the exact indexed event idempotently', async () => {
    if (handle === undefined) throw new Error('Database was not initialized');
    const reconciliation = new PostgresPaymentReconciliationStore(
      new PostgresUnitOfWork(handle.db),
    );
    const candidate = await reconciliation.load(exactInput.paymentAttemptId);
    if (candidate === undefined) throw new Error('Paid reconciliation candidate is unavailable');
    const [attemptBefore] = await handle.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, live.attemptId));
    const [providerBefore] = await handle.db
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.externalId, live.providerOperationId));
    expect((await reconciliation.listPending(20)).map((entry) => entry.attemptId)).toContain(
      live.attemptId,
    );
    await expect(
      reconciliation.recordProviderObservation({
        candidate,
        operation: exactInput.providerOperation,
        nextStatus: 'confirming',
        reconciliationRequired: false,
        now: new Date('2026-07-10T12:04:30.000Z'),
      }),
    ).resolves.toBe('updated');
    const [attemptAfter] = await handle.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, live.attemptId));
    const [providerAfter] = await handle.db
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.externalId, live.providerOperationId));
    expect(attemptAfter).toEqual(attemptBefore);
    expect(providerAfter).toMatchObject({
      paymentAttemptId: live.attemptId,
      kind: 'checkout',
      status: 'succeeded',
      submissionPossible: true,
      destinationTransactionHash: live.transactionHash,
      activityUrl: exactActivityUrl,
      evidenceDigest: exactProviderEvidenceDigest,
      observedAt: new Date('2026-07-10T12:04:00.000Z'),
    });
    expect(providerAfter?.createdAt).toEqual(providerBefore?.createdAt);
    expect(providerAfter?.safeSummary).toMatchObject({
      adapter: 'particle-get-transaction',
      finalObservedAt: '2026-07-10T12:04:00.000Z',
      providerUpdatedAt: '2026-07-10T12:04:00.000Z',
    });
    expect((await reconciliation.listPending(20)).map((entry) => entry.attemptId)).not.toContain(
      live.attemptId,
    );

    await rejectsWithoutEvidence({
      ...exactInput,
      providerOperation: {
        ...exactInput.providerOperation,
        evidence: {
          ...exactInput.providerOperation.evidence,
          evidenceDigest: `0x${'ab'.repeat(32)}`,
        },
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      providerOperation: {
        ...exactInput.providerOperation,
        updatedAt: '2026-07-10T12:06:00.000Z',
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      context: { ...exactInput.context, authMethod: 'google' },
    });
    await handle.db
      .update(userIdentities)
      .set({ lastVerifiedAt: new Date(startedAt.getTime() - 1) })
      .where(eq(userIdentities.id, DETERMINISTIC_DEMO_IDS.customerIdentityId));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db
        .update(userIdentities)
        .set({ lastVerifiedAt: issuedAt })
        .where(eq(userIdentities.id, DETERMINISTIC_DEMO_IDS.customerIdentityId));
    }
    await rejectsWithoutEvidence({
      ...exactInput,
      context: { ...exactInput.context, activationPath: 'provider_atomic' },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      context: {
        ...exactInput.context,
        delegationTransactionHash: `0x${'ac'.repeat(32)}`,
      },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      context: { ...exactInput.context, particleProtocolVersion: 'forged-protocol' },
    });
    await rejectsWithoutEvidence({
      ...exactInput,
      settlement: {
        ...exactInput.settlement,
        event: {
          ...exactInput.settlement.event,
          observedAt: '2026-07-09T11:59:59.000Z',
        },
      },
    });
    if (providerAfter === undefined) throw new Error('Reconciled provider row is unavailable');
    await handle.db
      .delete(providerOperations)
      .where(eq(providerOperations.externalId, live.providerOperationId));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db.insert(providerOperations).values(providerAfter);
    }
    await handle.db
      .update(providerOperations)
      .set({ updatedAt: new Date('2026-07-10T12:06:00.000Z') })
      .where(eq(providerOperations.externalId, live.providerOperationId));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db
        .update(providerOperations)
        .set({ updatedAt: new Date('2026-07-10T12:04:30.000Z') })
        .where(eq(providerOperations.externalId, live.providerOperationId));
    }
    await handle.db
      .update(canonicalLogs)
      .set({ observedAt: new Date('2026-07-09T11:59:59.000Z') })
      .where(eq(canonicalLogs.id, live.paymentLogId));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db
        .update(canonicalLogs)
        .set({ observedAt: issuedAt })
        .where(eq(canonicalLogs.id, live.paymentLogId));
    }
    await handle.db
      .update(delegationRecords)
      .set({ blockNumber: 123456789n })
      .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db
        .update(delegationRecords)
        .set({ blockNumber: 123456700n })
        .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
    }
    await handle.db
      .update(delegationRecords)
      .set({ checkedAt: new Date('2026-07-10T12:00:01.000Z') })
      .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
    try {
      await rejectsWithoutEvidence(exactInput);
    } finally {
      await handle.db
        .update(delegationRecords)
        .set({ checkedAt: new Date('2026-07-10T11:00:00.000Z') })
        .where(eq(delegationRecords.transactionHash, exactDelegationTransactionHash));
    }
    await handle.db
      .update(canonicalLogs)
      .set({
        decodedPayload: {
          ...(await handle.db
            .select({ payload: canonicalLogs.decodedPayload })
            .from(canonicalLogs)
            .where(eq(canonicalLogs.id, live.paymentLogId))
            .then((rows) => rows[0]?.payload ?? {})),
          confirmations: '11',
        },
      })
      .where(eq(canonicalLogs.id, live.paymentLogId));
    await rejectsWithoutEvidence(exactInput);
    await handle.db
      .update(canonicalLogs)
      .set({
        decodedPayload: {
          decoderVersion: 'live-acceptance-test-v1',
          fields: {
            orderKey: live.orderKey,
            merchantId: '1',
            productId: '1',
            payer: DETERMINISTIC_DEMO_IDS.customerAddress,
            recipient: DETERMINISTIC_DEMO_IDS.customerAddress,
            token: DETERMINISTIC_DEMO_IDS.usdcAddress,
            quantity: '1',
            amount: '500000',
            platformFee: '0',
            intentDigest: live.intentDigest,
            passTokenId: '1',
            refundDeadline: '1783771200',
          },
          confirmations: '12',
        },
      })
      .where(eq(canonicalLogs.id, live.paymentLogId));

    const payloadDigestBeforeStoredConfigTampering = `0x${'fe'.repeat(32)}`;
    const attestationBeforeStoredConfigTampering = createLiveAcceptanceAttestation(
      attestationSecret,
      {
        environment: 'production',
        releaseId: exactReleaseId,
        deploymentConfigDigest: exactDeploymentConfigDigest,
        orderId: live.orderId,
        paymentAttemptId: live.attemptId,
        providerOperationId: live.providerOperationId,
        previewDigest: exactPreviewDigest,
        providerEvidenceDigest: exactProviderEvidenceDigest,
        providerProvenance: 'live',
        delegationEvidenceDigest: exactDelegationEvidenceDigest,
        delegationTransactionHash: exactDelegationTransactionHash,
        route: exactInput.route,
        chainId: '42161',
        checkoutAddress: DETERMINISTIC_DEMO_IDS.checkoutAddress,
        settlementTransactionHash: live.transactionHash,
        settlementBlockNumber: 123456789n,
        settlementBlockHash: live.blockHash,
        settlementLogIndex: 1,
        receiptId: live.receiptId,
        passTokenId: '1',
        recovery: exactInput.recovery,
        timingMs: exactInput.timingMs,
        payloadDigest: payloadDigestBeforeStoredConfigTampering,
        startedAt,
        capturedAt,
      },
    );
    const rollbackTamperedDeploymentDigest = new Error(
      'rollback-tampered-deployment-digest-fixture',
    );
    await expect(
      handle.db.transaction(async (transaction) => {
        await transaction.insert(liveAcceptanceEvidence).values({
          environment: 'production',
          releaseId: exactReleaseId,
          deploymentConfigDigest: wrongDeploymentConfigDigest,
          orderId: live.orderId,
          paymentAttemptId: live.attemptId,
          providerOperationId: live.providerOperationId,
          previewDigest: exactPreviewDigest,
          providerEvidenceDigest: exactProviderEvidenceDigest,
          providerProvenance: 'live',
          delegationEvidenceDigest: exactDelegationEvidenceDigest,
          delegationTransactionHash: exactDelegationTransactionHash,
          route: exactInput.route,
          settlementEvent: exactInput.settlement.event,
          chainId: '42161',
          checkoutAddress: DETERMINISTIC_DEMO_IDS.checkoutAddress,
          settlementTransactionHash: live.transactionHash,
          settlementBlockNumber: 123456789n,
          settlementBlockHash: live.blockHash,
          settlementLogIndex: 1,
          receiptId: live.receiptId,
          passTokenId: '1',
          recovery: exactInput.recovery,
          timingMs: exactInput.timingMs,
          payloadDigest: payloadDigestBeforeStoredConfigTampering,
          attestationVersion: 'hmac-sha256-v1',
          attestationMac: attestationBeforeStoredConfigTampering,
          startedAt,
          capturedAt,
        });
        const [tampered] = await transaction
          .select()
          .from(liveAcceptanceEvidence)
          .where(eq(liveAcceptanceEvidence.orderId, live.orderId));
        expect(tampered).toBeDefined();
        if (tampered === undefined) throw new Error('Tampered evidence fixture was not inserted');
        expect(
          verifyLiveAcceptanceAttestation(
            attestationSecret,
            tampered,
            tampered.attestationVersion,
            tampered.attestationMac,
          ),
        ).toBe(false);
        const transactionManager = new PostgresJudgeEvidenceManager(
          new PostgresUnitOfWork(transaction as unknown as DatabaseHandle['db']),
          judgePepper,
          {
            environment: 'production',
            checkoutAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.checkoutAddress),
            passAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.passAddress),
            tokenAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.usdcAddress),
            applicationVersion: exactReleaseId,
            deploymentConfigDigest: exactDeploymentConfigDigest,
            particleSdkVersion: '2.0.3',
            magicSdkVersion: '33.9.0',
            contractsVersion: '1.0.0',
            provenance: 'live',
            acceptanceAttestationSecret: attestationSecret,
          },
          () => new Date('2026-07-14T12:00:00.000Z'),
        );
        const invalidProof = await transactionManager.materialize(actor, liveOrderId);
        expect(invalidProof.proof.particle).toMatchObject({
          routeEvidence: 'not_evidenced',
          sourceSummary: [],
        });
        expect(invalidProof.proof.recovery).toMatchObject({
          reloadRecovered: false,
          reloadRecoveryEvidence: 'not_evidenced',
          duplicatePrevented: false,
          duplicatePreventionEvidence: 'not_evidenced',
        });
        throw rollbackTamperedDeploymentDigest;
      }),
    ).rejects.toBe(rollbackTamperedDeploymentDigest);
    expect(await evidenceCount()).toBe(0);
    await rejectsWithoutEvidence({
      ...exactInput,
      deploymentConfigDigest: wrongDeploymentConfigDigest,
    });

    const restrictedHandle = createDatabase({
      url: requiredEvidenceWriterUrl(),
      maxConnections: 1,
      applicationName: 'live-acceptance-least-privilege-test',
    });
    let accepted: Awaited<ReturnType<PostgresLiveAcceptanceEvidenceStore['accept']>>;
    try {
      const privileges = await restrictedHandle.db.execute<{
        canSelectIdentity: boolean;
        canSelectOrders: boolean;
        canSelectProvider: boolean;
        canUpdateProvider: boolean;
        canInsertAcceptance: boolean;
        canUpdateAcceptance: boolean;
        canCreatePublicSchema: boolean;
        canCreateTemporaryTables: boolean;
      }>(sql`
        select
          has_table_privilege(current_user, 'user_identities', 'SELECT') as "canSelectIdentity",
          has_table_privilege(current_user, 'orders', 'SELECT') as "canSelectOrders",
          has_table_privilege(current_user, 'provider_operations', 'SELECT') as "canSelectProvider",
          has_table_privilege(current_user, 'provider_operations', 'UPDATE') as "canUpdateProvider",
          has_table_privilege(current_user, 'live_acceptance_evidence', 'INSERT') as "canInsertAcceptance",
          has_table_privilege(current_user, 'live_acceptance_evidence', 'UPDATE') as "canUpdateAcceptance",
          has_schema_privilege(current_user, 'public', 'CREATE') as "canCreatePublicSchema",
          has_database_privilege(current_user, current_database(), 'TEMP') as "canCreateTemporaryTables"
      `);
      expect(privileges[0]).toEqual({
        canSelectIdentity: true,
        canSelectOrders: true,
        canSelectProvider: true,
        canUpdateProvider: false,
        canInsertAcceptance: true,
        canUpdateAcceptance: false,
        canCreatePublicSchema: false,
        canCreateTemporaryTables: false,
      });
      await expect(
        restrictedHandle.db.execute(sql.raw('create temporary table orders (id text)')),
      ).rejects.toThrow();
      const restrictedStore = new PostgresLiveAcceptanceEvidenceStore(
        new PostgresUnitOfWork(restrictedHandle.db),
        {
          checkoutAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.checkoutAddress),
          passAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.passAddress),
          tokenAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.usdcAddress),
          deploymentConfigDigest: exactDeploymentConfigDigest,
          minimumConfirmations: 12n,
          allowedSourceChainIds: [ChainIdSchema.parse('8453')],
          allowedSourceSymbols: ['USDC', 'USDT'],
          maximumSlippageBps: 50n,
          attestationSecret,
        },
        () => new Date('2026-07-14T12:00:00.000Z'),
      );
      accepted = await restrictedStore.accept(exactInput);
    } finally {
      await restrictedHandle.close();
    }
    const reorderedTiming = parseVariant({
      ...exactInput,
      timingMs: {
        restartRecovery: 1000,
        canonicalArbitrumPayment: 2500,
        particleSubmission: 500,
        particlePreview: 2000,
        magicAuthentication: 1000,
      },
    });
    const repeated = await store.accept(reorderedTiming);

    expect(repeated).toEqual(accepted);
    expect(accepted.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await evidenceCount()).toBe(1);
    if (handle === undefined) throw new Error('Database was not initialized');
    const [stored] = await handle.db.select().from(liveAcceptanceEvidence);
    expect(stored).toMatchObject({
      id: accepted.id,
      environment: 'production',
      releaseId: exactReleaseId,
      deploymentConfigDigest: exactDeploymentConfigDigest,
      orderId: live.orderId,
      paymentAttemptId: live.attemptId,
      providerOperationId: live.providerOperationId,
      providerEvidenceDigest: exactProviderEvidenceDigest,
      delegationEvidenceDigest: exactDelegationEvidenceDigest,
      delegationTransactionHash: exactDelegationTransactionHash,
      settlementTransactionHash: live.transactionHash,
      receiptId: live.receiptId,
      passTokenId: '1',
      payloadDigest: accepted.digest,
      attestationVersion: 'hmac-sha256-v1',
    });
    expect(stored?.attestationMac).toMatch(/^0x[0-9a-f]{64}$/);

    const liveProof = await productionJudge.materialize(actor, liveOrderId);
    expect(liveProof.proof.account.authMethod).toBe('email_otp');
    expect(liveProof.proof.particle).toEqual({
      eip7702Enabled: true,
      eip7702Evidence: 'evidenced',
      universalAccountAddress: DETERMINISTIC_DEMO_IDS.customerAddress,
      routeEvidence: 'evidenced',
      totalUsd: '0.51',
      sourceSummary: [{ chainId: '8453', symbol: 'USDC', amount: '0.51', amountUsd: '0.51' }],
      estimatedFeeUsd: '0.01',
      slippageBps: '50',
      quoteObservedAt: '2026-07-10T11:55:00.000Z',
      previewDigest: exactPreviewDigest,
      operationId: live.providerOperationId,
      activityUrl: exactActivityUrl,
    });
    expect(liveProof.proof.recovery).toMatchObject({
      submissionPersistedBeforeWait: true,
      submissionPersistenceEvidence: 'evidenced',
      reloadRecovered: true,
      reloadRecoveryEvidence: 'evidenced',
      duplicatePrevented: true,
      duplicatePreventionEvidence: 'evidenced',
      timing: {
        authenticationMs: '1000',
        routePreparationMs: '2000',
        submissionToCanonicalMs: '3000',
        recoveryVerificationMs: '1000',
        totalDurationMs: '7000',
      },
    });

    await productionJudge.publish(actor, liveOrderId, { protected: false });
    const currentConfigQueries = new PostgresBackendApiQueryStore(
      new PostgresUnitOfWork(handle.db),
      capabilityPepper,
      judgePepper,
      attestationSecret,
      exactDeploymentConfigDigest,
    );
    const wrongConfigQueries = new PostgresBackendApiQueryStore(
      new PostgresUnitOfWork(handle.db),
      capabilityPepper,
      judgePepper,
      attestationSecret,
      wrongDeploymentConfigDigest,
    );
    expect((await currentConfigQueries.getJudgeProof(liveOrderId))?.particle.routeEvidence).toBe(
      'evidenced',
    );
    await expect(wrongConfigQueries.getJudgeProof(liveOrderId)).resolves.toBeUndefined();

    const mismatchedProof = await mismatchedProvenanceJudge.materialize(actor, liveOrderId);
    expect(mismatchedProof.proof.particle).toMatchObject({
      routeEvidence: 'not_evidenced',
      sourceSummary: [],
    });
    expect(mismatchedProof.proof.particle).not.toHaveProperty('totalUsd');
    expect(mismatchedProof.proof.particle).not.toHaveProperty('operationId');
    expect(mismatchedProof.proof.particle).not.toHaveProperty('activityUrl');
    expect(mismatchedProof.proof.recovery).toMatchObject({
      submissionPersistedBeforeWait: false,
      submissionPersistenceEvidence: 'not_evidenced',
      reloadRecovered: false,
      reloadRecoveryEvidence: 'not_evidenced',
      duplicatePrevented: false,
      duplicatePreventionEvidence: 'not_evidenced',
    });
  });

  it('ingests through the real protected CLI boundary and rejects unsafe paths', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const evidenceDirectory = path.join(
      repositoryRoot,
      'artifacts',
      'autonomous-build',
      'evidence',
    );
    const outsideDirectory = path.join(repositoryRoot, 'artifacts', 'autonomous-build');
    await mkdir(evidenceDirectory, { recursive: true });
    const nonce = randomUUID();
    const protectedPath = path.join(evidenceDirectory, `${nonce}.ingest.json`);
    const broadPath = path.join(evidenceDirectory, `${nonce}-broad.ingest.json`);
    const symlinkPath = path.join(evidenceDirectory, `${nonce}-symlink.ingest.json`);
    const escapedPath = path.join(outsideDirectory, `${nonce}-escaped.ingest.json`);
    const acceptedPath = protectedPath.replace(/\.ingest\.json$/, '.accepted.json');
    const pendingPath = protectedPath.replace(/\.ingest\.json$/, '.pending.json');
    const mismatchedPath = path.join(evidenceDirectory, `${nonce}-mismatch.ingest.json`);
    const mismatchedAcceptedPath = mismatchedPath.replace(/\.ingest\.json$/, '.accepted.json');
    const mismatchedPendingPath = mismatchedPath.replace(/\.ingest\.json$/, '.pending.json');
    const receiptSymlinkInput = path.join(evidenceDirectory, `${nonce}-receipt-link.ingest.json`);
    const receiptSymlinkPath = receiptSymlinkInput.replace(/\.ingest\.json$/, '.accepted.json');
    const receiptSymlinkPendingPath = receiptSymlinkInput.replace(
      /\.ingest\.json$/,
      '.pending.json',
    );
    const crossBindingInput = path.join(evidenceDirectory, `${nonce}-cross-bind.ingest.json`);
    const crossBindingPendingPath = crossBindingInput.replace(/\.ingest\.json$/, '.pending.json');
    const crossBindingAcceptedPath = crossBindingInput.replace(/\.ingest\.json$/, '.accepted.json');
    const unknownFieldInput = path.join(evidenceDirectory, `${nonce}-unknown.ingest.json`);
    const unknownFieldPendingPath = unknownFieldInput.replace(/\.ingest\.json$/, '.pending.json');
    const unknownFieldAcceptedPath = unknownFieldInput.replace(/\.ingest\.json$/, '.accepted.json');
    const cliPath = path.join(
      repositoryRoot,
      'packages',
      'db',
      'src',
      'live-acceptance-ingest-cli.ts',
    );
    const tsxCliPath = fileURLToPath(import.meta.resolve('tsx/cli'));
    const serialized = `${JSON.stringify(exactInput)}\n`;
    const pendingArtifactValue = {
      status: 'LIVE_ACCEPTANCE_EVIDENCED',
      schemaVersion: 1,
      environment: 'production',
      releaseId: exactReleaseId,
      deploymentConfigDigest: exactDeploymentConfigDigest,
      orderId: live.orderId,
      paymentAttemptId: live.attemptId,
      startedAt: exactInput.startedAt,
      capturedAt: exactInput.capturedAt,
      ownerAddressBefore: DETERMINISTIC_DEMO_IDS.customerAddress,
      ownerAddressAfter: DETERMINISTIC_DEMO_IDS.customerAddress,
      authMethod: 'email_otp',
      activationPath: 'self_funded_type4',
      delegationTransactionHash: exactDelegationTransactionHash,
      providerOperation: exactInput.providerOperation,
      particle: {
        protocolVersion: 'eip7702',
        useEIP7702: true,
        safeAccountIdentifiers: [DETERMINISTIC_DEMO_IDS.customerAddress],
        providerOperationId: live.providerOperationId,
        activityUrl: exactActivityUrl,
        sources: exactInput.route.sources,
        totalUsd: exactInput.route.totalUsd,
        estimatedFeeUsd: exactInput.route.estimatedFeeUsd,
        slippageBps: exactInput.route.slippageBps,
        quotedAt: exactInput.route.quotedAt,
        expiresAt: exactInput.route.expiresAt,
        previewDigest: exactInput.route.previewDigest,
      },
      arbitrum: exactInput.settlement,
      recovery: {
        ...exactInput.recovery,
        providerOperationId: live.providerOperationId,
      },
      timingMs: exactInput.timingMs,
    } as const;
    const pendingArtifact = serializeLiveAcceptanceArtifact(pendingArtifactValue);
    await writeFile(protectedPath, serialized, { mode: 0o600 });
    await writeFile(pendingPath, pendingArtifact, { mode: 0o600 });
    await writeFile(broadPath, serialized, { mode: 0o644 });
    await chmod(broadPath, 0o644);
    await writeFile(escapedPath, serialized, { mode: 0o600 });
    await writeFile(mismatchedPath, serialized, { mode: 0o600 });
    await writeFile(mismatchedPendingPath, pendingArtifact, { mode: 0o600 });
    await writeFile(receiptSymlinkInput, serialized, { mode: 0o600 });
    await writeFile(receiptSymlinkPendingPath, pendingArtifact, { mode: 0o600 });
    await writeFile(crossBindingInput, serialized, { mode: 0o600 });
    await writeFile(
      crossBindingPendingPath,
      serializeLiveAcceptanceArtifact({
        ...pendingArtifactValue,
        timingMs: { ...pendingArtifactValue.timingMs, particlePreview: 2001 },
      }),
      { mode: 0o600 },
    );
    await writeFile(unknownFieldInput, serialized, { mode: 0o600 });
    await writeFile(
      unknownFieldPendingPath,
      `${JSON.stringify({
        ...pendingArtifactValue,
        particle: { ...pendingArtifactValue.particle, unexpectedSignerPayload: 'forbidden' },
      })}\n`,
      { mode: 0o600 },
    );
    await symlink(protectedPath, symlinkPath);

    const environment = {
      ...process.env,
      APP_ENV: 'production',
      LIVE_ACCEPTANCE_RELEASE_ID: exactReleaseId,
      DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid',
      DATABASE_URL_EVIDENCE_WRITER: requiredEvidenceWriterUrl(),
      LIVE_ACCEPTANCE_ATTESTATION_SECRET: attestationSecret,
      NEXT_PUBLIC_CHECKOUT_ADDRESS: DETERMINISTIC_DEMO_IDS.checkoutAddress,
      NEXT_PUBLIC_PASS_ADDRESS: DETERMINISTIC_DEMO_IDS.passAddress,
      NEXT_PUBLIC_USDC_ADDRESS: DETERMINISTIC_DEMO_IDS.usdcAddress,
      CONFIRMATION_DEPTH: '12',
      PARTICLE_MAX_SLIPPAGE_BPS: '50',
      PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: '8453',
      PARTICLE_ALLOWED_SOURCE_ASSETS: 'USDC,USDT',
      PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: DETERMINISTIC_DEMO_IDS.delegateAddress,
      PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: exactImplementationCodeHash,
      PARTICLE_RESPONSE_PROFILE_ID: exactResponseProfileId,
      PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: exactFixtureDigests.deployments,
      PARTICLE_AUTH_FIXTURE_DIGEST: exactFixtureDigests.authorization,
      PARTICLE_SUBMISSION_FIXTURE_DIGEST: exactFixtureDigests.submission,
      PARTICLE_STATUS_FIXTURE_DIGEST: exactFixtureDigests.status,
      PARTICLE_SOURCE_CALL_PROFILES_JSON: JSON.stringify(exactSourceCallProfiles),
    };
    const runCli = async (args: readonly string[]) =>
      execFile(process.execPath, [tsxCliPath, cliPath, ...args], {
        cwd: repositoryRoot,
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    const expectRejected = async (args: readonly string[]) => {
      try {
        await runCli(args);
        throw new Error('Expected the evidence CLI to reject the invocation');
      } catch (error) {
        const result = error as { readonly code?: unknown; readonly stderr?: unknown };
        expect(result.code).toBe(1);
        expect(String(result.stderr)).toContain('"status":"rejected"');
      }
    };

    try {
      const direct = await runCli([protectedPath]);
      const acceptedOutput = JSON.parse(direct.stdout) as {
        readonly status: string;
        readonly id: string;
        readonly digest: string;
      };
      expect(acceptedOutput).toMatchObject({ status: 'accepted' });
      const receiptBytes = await readFile(acceptedPath, 'utf8');
      const receipt = verifyLiveAcceptanceReceipt(attestationSecret, JSON.parse(receiptBytes));
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        status: 'accepted',
        evidenceId: acceptedOutput.id,
        releaseId: exactReleaseId,
        deploymentConfigDigest: exactDeploymentConfigDigest,
        orderId: live.orderId,
        paymentAttemptId: live.attemptId,
        providerOperationId: live.providerOperationId,
        payloadDigest: acceptedOutput.digest,
        ingestionFileDigest: digestLiveAcceptanceFile(serialized),
        artifactFileDigest: digestLiveAcceptanceFile(pendingArtifact),
      });
      expect((await lstat(acceptedPath)).mode & 0o077).toBe(0);
      await symlink(acceptedPath, receiptSymlinkPath);
      await expectRejected([receiptSymlinkInput]);
      const delimited = await runCli(['--', protectedPath]);
      expect(JSON.parse(delimited.stdout)).toEqual(JSON.parse(direct.stdout));
      expect(await readFile(acceptedPath, 'utf8')).toBe(receiptBytes);
      await writeFile(pendingPath, `${pendingArtifact.trimEnd()} \n`, { mode: 0o600 });
      await expectRejected([protectedPath]);
      await writeFile(pendingPath, pendingArtifact, { mode: 0o600 });
      await writeFile(protectedPath, `${serialized.trimEnd()} \n`, { mode: 0o600 });
      await expectRejected([protectedPath]);
      await writeFile(protectedPath, serialized, { mode: 0o600 });
      await expectRejected([crossBindingInput]);
      await expect(lstat(crossBindingAcceptedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expectRejected([unknownFieldInput]);
      await expect(lstat(unknownFieldAcceptedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(
        mismatchedAcceptedPath,
        `${JSON.stringify(
          createLiveAcceptanceReceipt(attestationSecret, {
            schemaVersion: 1,
            status: 'accepted',
            evidenceId: acceptedOutput.id,
            releaseId: exactReleaseId,
            deploymentConfigDigest: exactDeploymentConfigDigest,
            orderId: 'ord_00000000000000000000000098',
            paymentAttemptId: live.attemptId,
            providerOperationId: live.providerOperationId,
            payloadDigest: acceptedOutput.digest,
            ingestionFileDigest: digestLiveAcceptanceFile(serialized),
            artifactFileDigest: digestLiveAcceptanceFile(pendingArtifact),
            acceptedAt: new Date('2026-07-14T12:00:00.000Z').toISOString(),
          }),
        )}\n`,
        { mode: 0o600 },
      );
      await expectRejected([mismatchedPath]);
      await expectRejected(['--']);
      await expectRejected([symlinkPath]);
      await expectRejected([escapedPath]);
      await expectRejected([broadPath]);
    } finally {
      await Promise.all(
        [
          protectedPath,
          acceptedPath,
          pendingPath,
          broadPath,
          symlinkPath,
          escapedPath,
          mismatchedPath,
          mismatchedAcceptedPath,
          mismatchedPendingPath,
          receiptSymlinkInput,
          receiptSymlinkPath,
          receiptSymlinkPendingPath,
          crossBindingInput,
          crossBindingPendingPath,
          crossBindingAcceptedPath,
          unknownFieldInput,
          unknownFieldPendingPath,
          unknownFieldAcceptedPath,
        ].map((target) => rm(target, { force: true })),
      );
    }
  }, 150_000);

  it('rejects conflicting evidence and database UPDATE or DELETE mutations', async () => {
    await expect(
      store.accept(
        parseVariant({
          ...exactInput,
          timingMs: { ...exactInput.timingMs, settlement: 3001 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await evidenceCount()).toBe(1);

    if (handle === undefined) throw new Error('Database was not initialized');
    await expect(
      handle.db
        .update(liveAcceptanceEvidence)
        .set({ providerProvenance: 'recorded_live' })
        .where(eq(liveAcceptanceEvidence.orderId, live.orderId)),
    ).rejects.toBeTruthy();
    await expect(
      handle.db
        .delete(liveAcceptanceEvidence)
        .where(eq(liveAcceptanceEvidence.orderId, live.orderId)),
    ).rejects.toBeTruthy();
    expect(await evidenceCount()).toBe(1);
  });
});
