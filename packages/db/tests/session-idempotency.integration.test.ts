import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LogoutSessionUseCase } from '@opentab/application';
import {
  CheckoutSessionIdSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  OrderIdSchema,
  PaymentAttemptIdSchema,
  ProductIdSchema,
  ProviderOperationIdSchema,
  SessionIdSchema,
  type VerifiedMagicIdentity,
} from '@opentab/shared';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { hashOpaqueSecret, opaqueId } from '../src/crypto.js';
import { PostgresIdempotencyRepository } from '../src/idempotency.js';
import {
  checkoutSessions,
  idempotencyRecords,
  merchants,
  orders,
  paymentAttempts,
  products,
  serverSessions,
  userIdentities,
  users,
} from '../src/schema/index.js';
import { PostgresSessionService } from '../src/session-service.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';
import { PostgresWorkflowStore } from '../src/workflow-store.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const OLD_SESSION_PEPPER = 'old-session-pepper-'.padEnd(40, 's');
const NEW_SESSION_PEPPER = 'new-session-pepper-'.padEnd(40, 'n');
const OLD_CSRF_PEPPER = 'old-csrf-pepper-'.padEnd(40, 'c');
const NEW_CSRF_PEPPER = 'new-csrf-pepper-'.padEnd(40, 'x');

let handle: DatabaseHandle | undefined;
let uow: PostgresUnitOfWork;
const userIds = new Set<string>();
const idempotencyScopes = new Set<string>();
const workflowFixtures: Array<{
  attemptId: string;
  orderId: string;
  checkoutId: string;
  productId: string;
  merchantId: string;
}> = [];

function digest(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}`;
}

function address() {
  return EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`);
}

function identity(now: Date): VerifiedMagicIdentity {
  return {
    issuerHash: randomBytes(32).toString('hex'),
    walletAddress: address(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    audience: 'opentab-integration',
    applicationId: 'magic-integration',
    authMethod: 'email_otp',
    evidenceDigest: digest() as VerifiedMagicIdentity['evidenceDigest'],
  };
}

function sessionService(input: {
  now: () => Date;
  sessionHashPepper?: string;
  sessionHashVersion?: number;
  previousSessionHashPeppers?: readonly { version: number; pepper: string }[];
  csrfHashPepper?: string;
  previousCsrfHashPeppers?: readonly string[];
}) {
  return new PostgresSessionService(uow, {
    sessionHashPepper: input.sessionHashPepper ?? NEW_SESSION_PEPPER,
    sessionHashVersion: input.sessionHashVersion ?? 2,
    ...(input.previousSessionHashPeppers === undefined
      ? {}
      : { previousSessionHashPeppers: input.previousSessionHashPeppers }),
    csrfHashPepper: input.csrfHashPepper ?? NEW_CSRF_PEPPER,
    ...(input.previousCsrfHashPeppers === undefined
      ? {}
      : { previousCsrfHashPeppers: input.previousCsrfHashPeppers }),
    maxAgeSeconds: 300,
    now: input.now,
  });
}

describe.skipIf(databaseUrl === undefined)(
  'PostgreSQL session, idempotency, and CAS boundaries',
  () => {
    beforeAll(async () => {
      if (databaseUrl === undefined) return;
      handle = createDatabase({ url: databaseUrl, applicationName: 'session-idempotency-tests' });
      await migrate(handle.db, {
        migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      });
      uow = new PostgresUnitOfWork(handle.db);
    }, 30_000);

    afterAll(async () => {
      if (handle === undefined) return;
      for (const fixture of workflowFixtures.reverse()) {
        await uow
          .current()
          .delete(paymentAttempts)
          .where(eq(paymentAttempts.id, fixture.attemptId));
        await uow.current().delete(orders).where(eq(orders.id, fixture.orderId));
        await uow
          .current()
          .delete(checkoutSessions)
          .where(eq(checkoutSessions.id, fixture.checkoutId));
        await uow.current().delete(products).where(eq(products.id, fixture.productId));
        await uow.current().delete(merchants).where(eq(merchants.id, fixture.merchantId));
      }
      for (const scope of idempotencyScopes) {
        await uow.current().delete(idempotencyRecords).where(eq(idempotencyRecords.scope, scope));
      }
      for (const userId of userIds) {
        await uow.current().delete(serverSessions).where(eq(serverSessions.userId, userId));
        await uow.current().delete(userIdentities).where(eq(userIdentities.userId, userId));
        await uow.current().delete(users).where(eq(users.id, userId));
      }
      await handle.close();
    });

    it('stores only independent domain-separated session and CSRF hashes', async () => {
      const now = new Date('2026-07-14T02:00:00.000Z');
      const service = sessionService({ now: () => now });
      const created = await service.create(identity(now));
      userIds.add(created.user.id);
      const [record] = await uow
        .current()
        .select()
        .from(serverSessions)
        .where(eq(serverSessions.userId, created.user.id));

      expect(record).toBeDefined();
      expect(record?.tokenHash).toBe(
        hashOpaqueSecret({
          domain: 'session-token',
          pepper: NEW_SESSION_PEPPER,
          value: created.plaintextToken,
        }),
      );
      expect(record?.csrfTokenHash).toBe(
        hashOpaqueSecret({
          domain: 'csrf-token',
          pepper: NEW_CSRF_PEPPER,
          value: created.csrfToken,
        }),
      );
      expect(record?.tokenHash).not.toBe(record?.csrfTokenHash);
      expect(JSON.stringify(record)).not.toContain(created.plaintextToken);
      expect(JSON.stringify(record)).not.toContain(created.csrfToken);
      await expect(
        service.verifyCsrf(created.plaintextToken, created.csrfToken),
      ).resolves.toMatchObject({
        id: created.user.id,
      });
    });

    it('rejects expired sessions and makes logout revocation immediate and idempotent', async () => {
      let now = new Date('2026-07-14T03:00:00.000Z');
      const proof = identity(now);
      const service = sessionService({ now: () => now });
      const expired = await service.create(proof);
      userIds.add(expired.user.id);
      now = new Date(now.getTime() + 301_000);
      await expect(service.verify(expired.plaintextToken)).rejects.toMatchObject({
        code: 'AUTH_SESSION_INVALID',
      });

      const active = await service.create(proof);
      const logout = new LogoutSessionUseCase(service);
      await logout.execute(active.plaintextToken);
      await logout.execute(active.plaintextToken);
      await expect(service.verify(active.plaintextToken)).rejects.toMatchObject({
        code: 'AUTH_SESSION_INVALID',
      });
      const [record] = await uow
        .current()
        .select({ revokedAt: serverSessions.revokedAt })
        .from(serverSessions)
        .where(
          eq(
            serverSessions.tokenHash,
            hashOpaqueSecret({
              domain: 'session-token',
              pepper: NEW_SESSION_PEPPER,
              value: active.plaintextToken,
            }),
          ),
        );
      expect(record?.revokedAt?.toISOString()).toBe(now.toISOString());
    });

    it('refreshes the exact returning Magic identity before live-acceptance work begins', async () => {
      const firstVerifiedAt = new Date('2026-07-14T03:30:00.000Z');
      const acceptanceStartedAt = new Date('2026-07-14T03:45:00.000Z');
      let now = firstVerifiedAt;
      const firstProof = identity(now);
      const service = sessionService({ now: () => now });
      const created = await service.create(firstProof);
      userIds.add(created.user.id);

      const [before] = await uow
        .current()
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.userId, created.user.id));
      if (before === undefined) throw new Error('Returning Magic identity was not persisted');
      expect(before.lastVerifiedAt.getTime()).toBeLessThan(acceptanceStartedAt.getTime());

      now = new Date('2026-07-14T03:46:00.000Z');
      const refreshedDigest = digest() as VerifiedMagicIdentity['evidenceDigest'];
      await service.create({
        ...firstProof,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        authMethod: 'google',
        evidenceDigest: refreshedDigest,
      });

      const [after] = await uow
        .current()
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.id, before.id));
      const [user] = await uow
        .current()
        .select({ lastLoginAt: users.lastLoginAt })
        .from(users)
        .where(eq(users.id, created.user.id));
      expect(after).toMatchObject({
        id: before.id,
        userId: created.user.id,
        authMethod: 'google',
        evidenceDigest: refreshedDigest,
        lastVerifiedAt: now,
        updatedAt: now,
      });
      expect(after?.lastVerifiedAt.getTime()).toBeGreaterThanOrEqual(acceptanceStartedAt.getTime());
      expect(user?.lastLoginAt).toEqual(now);
    });

    it('rotates old hash versions safely under concurrent verification', async () => {
      const now = new Date('2026-07-14T04:00:00.000Z');
      const oldService = sessionService({
        now: () => now,
        sessionHashPepper: OLD_SESSION_PEPPER,
        sessionHashVersion: 1,
        csrfHashPepper: OLD_CSRF_PEPPER,
      });
      const created = await oldService.create(identity(now));
      userIds.add(created.user.id);
      const rotatingService = sessionService({
        now: () => now,
        previousSessionHashPeppers: [{ version: 1, pepper: OLD_SESSION_PEPPER }],
        previousCsrfHashPeppers: [OLD_CSRF_PEPPER],
      });

      const verified = await Promise.all([
        rotatingService.verifyCsrf(created.plaintextToken, created.csrfToken),
        rotatingService.verifyCsrf(created.plaintextToken, created.csrfToken),
      ]);
      expect(verified.map((user) => user.id)).toEqual([created.user.id, created.user.id]);
      const [record] = await uow
        .current()
        .select()
        .from(serverSessions)
        .where(eq(serverSessions.userId, created.user.id));
      expect(record).toMatchObject({
        tokenHashVersion: 2,
        tokenHash: hashOpaqueSecret({
          domain: 'session-token',
          pepper: NEW_SESSION_PEPPER,
          value: created.plaintextToken,
        }),
        csrfTokenHash: hashOpaqueSecret({
          domain: 'csrf-token',
          pepper: NEW_CSRF_PEPPER,
          value: created.csrfToken,
        }),
      });
      await expect(oldService.verify(created.plaintextToken)).rejects.toMatchObject({
        code: 'AUTH_SESSION_INVALID',
      });
    });

    it('rejects a current-pepper session hash stored under the wrong hash version', async () => {
      const now = new Date('2026-07-14T04:15:00.000Z');
      const service = sessionService({ now: () => now });
      const created = await service.create(identity(now));
      userIds.add(created.user.id);
      const plaintextToken = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      await uow
        .current()
        .insert(serverSessions)
        .values({
          id: SessionIdSchema.parse(opaqueId('ses')),
          userId: created.user.id,
          tokenHash: hashOpaqueSecret({
            domain: 'session-token',
            pepper: NEW_SESSION_PEPPER,
            value: plaintextToken,
          }),
          tokenHashVersion: 1,
          csrfTokenHash: hashOpaqueSecret({
            domain: 'csrf-token',
            pepper: NEW_CSRF_PEPPER,
            value: csrfToken,
          }),
          expiresAt: new Date(now.getTime() + 300_000),
          lastSeenAt: now,
        });

      await expect(service.verify(plaintextToken)).rejects.toMatchObject({
        code: 'AUTH_SESSION_INVALID',
      });
      await expect(service.verifyCsrf(plaintextToken, csrfToken)).rejects.toMatchObject({
        code: 'CSRF_INVALID',
      });
    });

    it('atomically refreshes once, invalidates the old token, and preserves fixed expiry', async () => {
      const now = new Date('2026-07-14T04:30:00.000Z');
      const service = sessionService({ now: () => now });
      const created = await service.create(identity(now));
      userIds.add(created.user.id);
      const outcomes = await Promise.allSettled([
        service.refresh(created.plaintextToken),
        service.refresh(created.plaintextToken),
      ]);
      const successes = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof service.refresh>>> =>
          outcome.status === 'fulfilled',
      );
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      const refreshed = successes[0]?.value;
      expect(refreshed?.expiresAt).toBe(created.expiresAt);
      expect(JSON.stringify(refreshed)).not.toContain(created.plaintextToken);
      await expect(service.verify(created.plaintextToken)).rejects.toMatchObject({
        code: 'AUTH_SESSION_INVALID',
      });
      if (refreshed === undefined) throw new Error('Refresh did not produce a winner');
      await expect(
        service.verifyCsrf(refreshed.plaintextToken, refreshed.csrfToken),
      ).resolves.toMatchObject({
        id: created.user.id,
      });
    });

    it('serializes same-key idempotency, replays one result, and rejects changed input', async () => {
      const scope = `integration:${randomUUID()}`;
      idempotencyScopes.add(scope);
      const repository = new PostgresIdempotencyRepository(uow);
      let executions = 0;
      const keyHash = 'b'.repeat(64);
      const execute = () =>
        repository.execute({
          scope,
          keyHash,
          requestHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
          operation: async () => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { receipt: 'one' };
          },
        });
      const results = await Promise.all([execute(), execute()]);
      expect(executions).toBe(1);
      expect(results.map((result) => result.state).sort()).toEqual(['created', 'replayed']);
      await expect(
        repository.execute({
          scope,
          keyHash,
          requestHash: 'c'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
          operation: async () => ({ receipt: 'changed' }),
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('never re-executes an expired or terminal same-key result', async () => {
      let now = new Date('2026-07-14T05:00:00.000Z');
      const repository = new PostgresIdempotencyRepository(uow, () => now);
      const scope = `terminal:${randomUUID()}`;
      idempotencyScopes.add(scope);
      let completedExecutions = 0;
      const completedInput = {
        scope,
        keyHash: 'd'.repeat(64),
        requestHash: 'e'.repeat(64),
        expiresAt: new Date(now.getTime() + 1_000),
        operation: async () => {
          completedExecutions += 1;
          return { receipt: 'bounded' };
        },
      };
      await repository.execute(completedInput);
      now = new Date(now.getTime() + 1_001);
      await expect(repository.execute(completedInput)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(completedExecutions).toBe(1);

      const terminalScope = `terminal-failure:${randomUUID()}`;
      idempotencyScopes.add(terminalScope);
      let terminalExecutions = 0;
      const terminalInput = {
        scope: terminalScope,
        keyHash: 'f'.repeat(64),
        requestHash: '1'.repeat(64),
        expiresAt: new Date(now.getTime() + 60_000),
        operation: async () => {
          terminalExecutions += 1;
          throw new Error('terminal failure');
        },
      };
      await expect(repository.execute(terminalInput)).rejects.toThrow('terminal failure');
      await expect(repository.execute(terminalInput)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(terminalExecutions).toBe(1);
    });

    it('preserves the original database error after idempotency failure bookkeeping', async () => {
      const scope = `database-failure:${randomUUID()}`;
      idempotencyScopes.add(scope);
      const repository = new PostgresIdempotencyRepository(uow);
      const execution = repository.execute({
        scope,
        keyHash: '2'.repeat(64),
        requestHash: '3'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        operation: async () => {
          await uow.current().execute(sql`select 1 / 0`);
          return { unreachable: true };
        },
      });

      await expect(execution).rejects.toMatchObject({ cause: { code: '22012' } });
      const [failure] = await uow
        .current()
        .select({ status: idempotencyRecords.status })
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.scope, scope));
      expect(failure).toEqual({ status: 'failed_terminal' });
    });

    it('allows exactly one compare-and-swap transition at the submission boundary', async () => {
      const now = new Date('2026-07-14T05:00:00.000Z');
      const service = sessionService({ now: () => now });
      const created = await service.create(identity(now));
      userIds.add(created.user.id);
      const merchantId = MerchantIdSchema.parse(opaqueId('mer'));
      const productId = ProductIdSchema.parse(opaqueId('prd'));
      const checkoutId = CheckoutSessionIdSchema.parse(opaqueId('chk'));
      const orderId = OrderIdSchema.parse(opaqueId('ord'));
      const attemptId = PaymentAttemptIdSchema.parse(opaqueId('pay'));
      workflowFixtures.push({ merchantId, productId, checkoutId, orderId, attemptId });
      const payout = address();
      const orderKey = digest();
      const merchantOnchainId = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
      const productOnchainId = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
      await uow
        .current()
        .insert(merchants)
        .values({
          id: merchantId,
          onchainMerchantId: merchantOnchainId,
          ownerUserId: created.user.id,
          slug: `merchant-${randomUUID()}`,
          displayName: 'CAS merchant',
          payoutAddress: payout,
          payoutAddressLower: payout.toLowerCase(),
          status: 'active',
          chainSyncStatus: 'confirmed',
        });
      await uow
        .current()
        .insert(products)
        .values({
          id: productId,
          merchantId,
          onchainProductId: productOnchainId,
          slug: `product-${randomUUID()}`,
          title: 'CAS product',
          description: 'Concurrent transition fixture',
          unitPriceBaseUnits: '1000',
          sold: '0',
          maxPerOrder: '10',
          startsAt: new Date('2026-01-01T00:00:00.000Z'),
          refundWindowSeconds: '3600',
          loyaltyPoints: '0',
          metadataHash: digest(),
          status: 'active',
          chainSyncStatus: 'confirmed',
        });
      await uow
        .current()
        .insert(checkoutSessions)
        .values({
          id: checkoutId,
          userId: created.user.id,
          productId,
          productVersion: 1,
          quantity: '1',
          receiptRecipient: created.user.walletAddress,
          amountBaseUnits: '1000',
          orderKey,
          status: 'bound',
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          bindingDigest: digest(),
          boundAt: now,
        });
      const workflow = new PostgresWorkflowStore(uow);
      const reboundDigest = EvidenceDigestSchema.parse(digest());
      await expect(
        workflow.bindCheckoutSession({
          id: checkoutId,
          userId: created.user.id,
          receiptRecipient: created.user.walletAddress,
          bindingDigest: reboundDigest,
          now,
        }),
      ).resolves.toMatchObject({
        id: checkoutId,
        bindingDigest: reboundDigest,
        status: 'bound',
      });
      await uow
        .current()
        .insert(orders)
        .values({
          id: orderId,
          checkoutSessionId: checkoutId,
          orderKey,
          userId: created.user.id,
          merchantId,
          productId,
          payer: created.user.walletAddress,
          recipient: created.user.walletAddress,
          tokenAddress: address(),
          quantity: '1',
          amountBaseUnits: '1000',
          chainId: '42161',
          intentDigest: digest(),
          refundableUntil: new Date('2027-01-01T00:00:00.000Z'),
        });
      const bindingDigest = EvidenceDigestSchema.parse(digest());
      await uow
        .current()
        .insert(paymentAttempts)
        .values({
          id: attemptId,
          orderId,
          checkoutSessionId: checkoutId,
          attemptNumber: 1,
          status: 'prepared',
          bindingDigest,
          preparedExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
        });

      const intruder = await service.create(identity(now));
      userIds.add(intruder.user.id);
      await expect(workflow.findAuthoritativeProduct(productId)).resolves.toMatchObject({
        active: true,
        merchantOnchainId,
        productOnchainId,
      });
      await expect(
        workflow.recordPreparedAttempt({
          attemptId,
          actorUserId: intruder.user.id,
          actorWalletAddress: intruder.user.walletAddress,
          providerOperationId: ProviderOperationIdSchema.parse('particle-idor-attempt'),
          rootHashDigest: EvidenceDigestSchema.parse(digest()),
          previewDigest: EvidenceDigestSchema.parse(digest()),
          quoteSummary: { source: 'idor-regression' },
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          now,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        workflow.startSubmission({
          attemptId,
          actorUserId: intruder.user.id,
          actorWalletAddress: intruder.user.walletAddress,
          expectedBindingDigest: bindingDigest,
          now,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        workflow.attachSubmission({
          attemptId,
          actorUserId: intruder.user.id,
          actorWalletAddress: intruder.user.walletAddress,
          status: 'submitted_unknown',
          now,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const scope = `payment-submission:start:${created.user.id}:${attemptId}`;
      idempotencyScopes.add(scope);
      const idempotency = new PostgresIdempotencyRepository(uow);
      const start = (keyHash: string) =>
        idempotency.execute({
          scope,
          keyHash,
          requestHash: keyHash,
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          operation: () =>
            workflow.startSubmission({
              attemptId,
              actorUserId: created.user.id,
              actorWalletAddress: created.user.walletAddress,
              expectedBindingDigest: bindingDigest,
              now,
            }),
        });
      const transitions = await Promise.allSettled([start('2'.repeat(64)), start('3'.repeat(64))]);
      const winnerIndex = transitions.findIndex((result) => result.status === 'fulfilled');
      expect(transitions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(transitions.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(transitions.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'PAYMENT_SUBMITTED_UNKNOWN', submissionPossible: true },
      });
      const winnerKey = winnerIndex === 0 ? '2'.repeat(64) : '3'.repeat(64);
      await expect(start(winnerKey)).resolves.toMatchObject({
        state: 'replayed',
        value: { status: 'submission_started' },
      });
      const [record] = await uow
        .current()
        .select({ status: paymentAttempts.status, version: paymentAttempts.version })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, attemptId));
      expect(record).toEqual({ status: 'submission_started', version: 2 });
    });
  },
);
