import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ARBITRUM_ONE_CHAIN_ID,
  BoundOperationTemplateSchema,
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
import { auditLogs, contractOperations, users } from '../src/schema/index.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env['DATABASE_URL_TEST'];
const wallet = EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`);
const target = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const capabilityPepper = 'contract-operation-test-pepper'.padEnd(40, 'x');
let handle: DatabaseHandle | undefined;
let uow: PostgresUnitOfWork;
let store: PostgresBackendApiStore;
let userId: ReturnType<typeof UserIdSchema.parse>;
const operationIds: string[] = [];

function digest(digit: string) {
  return EvidenceDigestSchema.parse(`0x${digit.repeat(64)}`);
}

function operationTemplate(digit: string, expiresAt = '2027-07-14T00:00:00.000Z') {
  return BoundOperationTemplateSchema.parse({
    kind: 'refund',
    ownerAddress: wallet,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    calls: [{ to: target, data: '0x1234', valueWei: '0' }],
    bindingDigest: digest(digit),
    expiresAt,
  });
}

describe.skipIf(databaseUrl === undefined)('persisted contract operation transitions', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({ url: databaseUrl, applicationName: 'contract-operation-tests' });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    uow = new PostgresUnitOfWork(handle.db);
    store = new PostgresBackendApiStore(
      uow,
      capabilityPepper,
      () => new Date('2026-07-14T00:00:00.000Z'),
    );
    userId = UserIdSchema.parse(opaqueId('usr'));
    await uow
      .current()
      .insert(users)
      .values({
        id: userId,
        magicIssuerHash: digest('a'),
        walletAddressChecksum: wallet,
        walletAddressLower: wallet.toLowerCase(),
      });
  }, 30_000);

  afterAll(async () => {
    if (handle === undefined) return;
    if (operationIds.length > 0) {
      await uow.current().delete(auditLogs).where(inArray(auditLogs.resourceId, operationIds));
      await uow
        .current()
        .delete(contractOperations)
        .where(inArray(contractOperations.id, operationIds));
    }
    await uow.current().delete(auditLogs).where(eq(auditLogs.actorId, userId));
    await uow.current().delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  it('permits only monotonic submission states with an immutable provider ID', async () => {
    const actor = CurrentUserSchema.parse({
      id: userId,
      walletAddress: wallet,
      authMethod: 'email_otp',
      status: 'active',
      merchantMemberships: [],
    });
    const template = operationTemplate('3');
    const operation = await store.prepareContractOperation({
      actor,
      kind: 'refund',
      aggregateType: 'refund',
      aggregateId: `refund-transition-${userId}`,
      binding: { test: 'monotonic' },
      template,
      requestId: 'req_contract_transition',
    });
    operationIds.push(operation.id);
    await expect(
      store.registerContractOperationSubmission({
        actor,
        operationId: operation.id,
        status: 'submitted',
        providerOperationId: 'provider-operation-one',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_SUBMITTED' });

    const started = await store.registerContractOperationSubmission({
      actor,
      operationId: operation.id,
      status: 'submission_started',
      providerOperationId: 'provider-operation-one',
    });
    expect(started.status).toBe('submission_started');
    const unknown = await store.registerContractOperationSubmission({
      actor,
      operationId: operation.id,
      status: 'submitted_unknown',
      providerOperationId: 'provider-operation-one',
    });
    expect(unknown.status).toBe('submitted_unknown');
    const submitted = await store.registerContractOperationSubmission({
      actor,
      operationId: operation.id,
      status: 'submitted',
      providerOperationId: 'provider-operation-one',
    });
    expect(submitted.status).toBe('submitted');
    await expect(
      store.registerContractOperationSubmission({
        actor,
        operationId: operation.id,
        status: 'submitted_unknown',
        providerOperationId: 'provider-operation-one',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_SUBMITTED' });
    await expect(
      store.registerContractOperationSubmission({
        actor,
        operationId: operation.id,
        status: 'submitted',
        providerOperationId: 'different-operation',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      store.registerContractOperationSubmission({
        actor,
        operationId: operation.id,
        status: 'submitted',
        providerOperationId: 'provider-operation-one',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
  });
});
