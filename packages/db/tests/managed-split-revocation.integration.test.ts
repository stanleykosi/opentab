import { fileURLToPath } from 'node:url';
import {
  ARBITRUM_ONE_CHAIN_ID,
  BoundOperationTemplateSchema,
  CurrentUserSchema,
  EvmAddressSchema,
  UserIdSchema,
} from '@opentab/shared';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBackendApiStore } from '../src/backend-api-store.js';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { hashSplitInvitationCapability } from '../src/crypto.js';
import { PostgresCanonicalProjector } from '../src/projectors.js';
import {
  auditLogs,
  contractOperations,
  splitInvitations,
  splitParticipants,
  splitPayments,
  splits,
} from '../src/schema/index.js';
import { DETERMINISTIC_DEMO_IDS, seedDeterministicDemo } from '../src/seed.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env['DATABASE_URL_TEST'];
const capabilityPepper = 'judge-capability-test-pepper'.padEnd(40, 'c');
const capabilityToken = 'deterministic-demo-split-capability-never-production';
const now = new Date('2026-07-14T12:00:00.000Z');
const signerAddress = EvmAddressSchema.parse('0x7777777777777777777777777777777777777777');
const splitContractAddress = EvmAddressSchema.parse('0x8888888888888888888888888888888888888888');
const transactionHash = `0x${'8'.repeat(64)}` as const;
const blockHash = `0x${'9'.repeat(64)}` as const;
let handle: DatabaseHandle | undefined;
let uow: PostgresUnitOfWork;
let store: PostgresBackendApiStore;
let paymentId: string | undefined;

const actor = CurrentUserSchema.parse({
  id: UserIdSchema.parse(DETERMINISTIC_DEMO_IDS.userId),
  walletAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.customerAddress),
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});

const unauthorizedActor = CurrentUserSchema.parse({
  id: UserIdSchema.parse(DETERMINISTIC_DEMO_IDS.merchantUserId),
  walletAddress: EvmAddressSchema.parse(DETERMINISTIC_DEMO_IDS.merchantAddress),
  authMethod: 'google',
  status: 'active',
  merchantMemberships: [],
});

describe.skipIf(databaseUrl === undefined)('managed split revocation lifecycle', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({
      url: databaseUrl,
      applicationName: 'managed-split-revocation-tests',
    });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await seedDeterministicDemo({
      db: handle.db,
      environment: 'test',
      deterministicDemoEnabled: true,
      secretPepper: capabilityPepper,
    });
    uow = new PostgresUnitOfWork(handle.db);
    store = new PostgresBackendApiStore(uow, capabilityPepper, () => now);
    await uow
      .current()
      .update(splitInvitations)
      .set({
        capabilityHash: hashSplitInvitationCapability({
          invitationId: DETERMINISTIC_DEMO_IDS.invitationId,
          pepper: capabilityPepper,
          capabilityToken,
        }),
        status: 'unpaid',
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(splitInvitations.id, DETERMINISTIC_DEMO_IDS.invitationId));
    await uow
      .current()
      .update(splits)
      .set({
        status: 'active',
        confirmedBaseUnits: '0',
        revokedAt: null,
        version: 1,
        updatedAt: now,
      })
      .where(eq(splits.id, DETERMINISTIC_DEMO_IDS.splitId));
  }, 30_000);

  afterAll(async () => {
    if (handle === undefined) return;
    if (paymentId !== undefined) {
      await uow
        .current()
        .delete(auditLogs)
        .where(inArray(auditLogs.resourceId, [DETERMINISTIC_DEMO_IDS.splitId, paymentId]));
      await uow
        .current()
        .delete(contractOperations)
        .where(eq(contractOperations.aggregateId, paymentId));
      await uow.current().delete(splitPayments).where(eq(splitPayments.id, paymentId));
    }
    await uow
      .current()
      .update(splitInvitations)
      .set({
        status: 'unpaid',
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(splitInvitations.id, DETERMINISTIC_DEMO_IDS.invitationId));
    await uow
      .current()
      .update(splitParticipants)
      .set({
        participantUserId: null,
        confirmedBaseUnits: '0',
        updatedAt: now,
      })
      .where(eq(splitParticipants.id, DETERMINISTIC_DEMO_IDS.splitParticipantId));
    await uow
      .current()
      .update(splits)
      .set({
        status: 'active',
        confirmedBaseUnits: '0',
        revokedAt: null,
        version: 1,
        updatedAt: now,
      })
      .where(eq(splits.id, DETERMINISTIC_DEMO_IDS.splitId));
    await handle.close();
  });

  it('persists the signer boundary and waits for canonical revocation truth', async () => {
    const preparedPayment = await store.prepareSplitPayment({
      actor,
      splitId: DETERMINISTIC_DEMO_IDS.splitId,
      invitationId: DETERMINISTIC_DEMO_IDS.invitationId,
      capabilityReference: `${DETERMINISTIC_DEMO_IDS.invitationId}.${capabilityToken}`,
      amountBaseUnits: '12500000',
    });
    paymentId = preparedPayment.payment.id;

    await expect(
      store.prepareSplitRevocation({
        actor: unauthorizedActor,
        splitId: DETERMINISTIC_DEMO_IDS.splitId,
        reason: 'unauthorized',
        requestId: 'req_split_revoke_unauthorized',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const revocation = await store.prepareSplitRevocation({
      actor,
      splitId: DETERMINISTIC_DEMO_IDS.splitId,
      reason: 'plans changed',
      requestId: 'req_split_revoke_prepare',
    });
    expect(revocation).toMatchObject({
      status: 'revoking',
      paymentRevocations: [{ paymentId }],
    });
    if (revocation.status !== 'revoking') throw new Error('Expected managed revocation');
    const payment = revocation.paymentRevocations[0];
    if (payment === undefined) throw new Error('Expected an issued payment key');
    const expiresAt = '2027-07-14T12:00:00.000Z';
    const binding = {
      invitationId: payment.invitationId,
      signerAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      splitContractAddress,
      paymentKey: payment.paymentKey,
      splitDigest: payment.splitDigest,
      expiresAt,
    };
    const template = BoundOperationTemplateSchema.parse({
      kind: 'split_revocation',
      ownerAddress: signerAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      calls: [
        {
          to: splitContractAddress,
          data: '0x12345678',
          valueWei: '0',
        },
      ],
      bindingDigest: `0x${'7'.repeat(64)}`,
      expiresAt,
    });
    const operation = await store.prepareManagedSplitRevocationOperation({
      actor,
      aggregateId: payment.paymentId,
      signerAddress,
      binding,
      template,
      requestId: 'req_split_revoke_operation',
    });
    expect(operation.status).toBe('prepared');

    const started = await store.startManagedSplitRevocationSubmission({
      actor,
      operationId: operation.id,
    });
    expect(started.status).toBe('submission_started');
    const unknown = await store.recordManagedSplitRevocationSubmission({
      actor,
      operationId: operation.id,
      status: 'submitted_unknown',
      signerNonce: '7',
    });
    expect(unknown.status).toBe('submitted_unknown');
    await expect(
      store.recordManagedSplitRevocationSubmission({
        actor,
        operationId: operation.id,
        status: 'submitted_unknown',
        signerNonce: '8',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      store.failManagedSplitRevocationSubmission({
        actor,
        operationId: operation.id,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_SUBMITTED' });

    const [persistedBoundary] = await uow
      .current()
      .select()
      .from(contractOperations)
      .where(eq(contractOperations.id, operation.id))
      .limit(1);
    expect(persistedBoundary).toMatchObject({
      status: 'submitted_unknown',
      managedSignerNonce: '7',
      transactionHash: null,
    });

    const projector = new PostgresCanonicalProjector(uow);
    await expect(
      projector.apply({
        canonicalLogId: 'managed-split-revocation-log',
        decoded: {
          eventName: 'SplitPaymentRevoked',
          fields: {
            paymentKey: payment.paymentKey,
            splitDigest: payment.splitDigest,
          },
          decoderVersion: 'managed-split-revocation-test-v1',
        },
        position: {
          chainId: ARBITRUM_ONE_CHAIN_ID,
          contractAddress: splitContractAddress,
          transactionHash,
          blockNumber: 123456790n,
          blockHash,
          logIndex: 0,
          confirmations: 12n,
          observedAt: now,
        },
      }),
    ).resolves.toEqual({ kind: 'applied' });

    const [revokedPayment] = await uow
      .current()
      .select()
      .from(splitPayments)
      .where(eq(splitPayments.id, payment.paymentId))
      .limit(1);
    const [revokedInvitation] = await uow
      .current()
      .select()
      .from(splitInvitations)
      .where(eq(splitInvitations.id, payment.invitationId))
      .limit(1);
    const [revokedSplit] = await uow
      .current()
      .select()
      .from(splits)
      .where(eq(splits.id, DETERMINISTIC_DEMO_IDS.splitId))
      .limit(1);
    expect(revokedPayment).toMatchObject({ status: 'revoked', transactionHash });
    expect(revokedInvitation?.status).toBe('revoked');
    expect(revokedSplit?.status).toBe('revoked');
    await expect(store.getContractOperation(operation.id, actor)).resolves.toMatchObject({
      status: 'confirmed',
      transactionHash,
      canonicalEventName: 'SplitPaymentRevoked',
    });

    await expect(
      store.prepareSplitRevocation({
        actor,
        splitId: DETERMINISTIC_DEMO_IDS.splitId,
        reason: 'idempotent retry',
        requestId: 'req_split_revoke_retry',
      }),
    ).resolves.toMatchObject({ status: 'revoked', paymentRevocations: [] });
  });
});
