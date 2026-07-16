import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CurrentUserSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  UserIdSchema,
} from '@opentab/shared';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBackendApiStore } from '../src/backend-api-store.js';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { opaqueId } from '../src/crypto.js';
import { merchantMembers, merchants, users } from '../src/schema/index.js';
import { PostgresUnitOfWork } from '../src/unit-of-work.js';

const databaseUrl = process.env['DATABASE_URL_TEST'];
const ownerWallet = EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`);
const adminWallet = EvmAddressSchema.parse(`0x${randomBytes(20).toString('hex')}`);
const ownerId = UserIdSchema.parse(opaqueId('usr'));
const adminId = UserIdSchema.parse(opaqueId('usr'));
const merchantId = MerchantIdSchema.parse(opaqueId('mer'));
let handle: DatabaseHandle | undefined;
let uow: PostgresUnitOfWork;
let store: PostgresBackendApiStore;

const owner = CurrentUserSchema.parse({
  id: ownerId,
  walletAddress: ownerWallet,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [{ merchantId, role: 'owner' }],
});
const admin = CurrentUserSchema.parse({
  id: adminId,
  walletAddress: adminWallet,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [{ merchantId, role: 'admin' }],
});

describe.skipIf(databaseUrl === undefined)('merchant payout authorization boundary', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    handle = createDatabase({ url: databaseUrl, applicationName: 'merchant-payout-tests' });
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    uow = new PostgresUnitOfWork(handle.db);
    store = new PostgresBackendApiStore(
      uow,
      'merchant-payout-capability-pepper'.padEnd(40, 'x'),
      () => new Date('2026-07-14T00:00:00.000Z'),
    );
    await uow
      .current()
      .insert(users)
      .values([
        {
          id: ownerId,
          magicIssuerHash: randomBytes(32).toString('hex'),
          walletAddressChecksum: ownerWallet,
          walletAddressLower: ownerWallet.toLowerCase(),
        },
        {
          id: adminId,
          magicIssuerHash: randomBytes(32).toString('hex'),
          walletAddressChecksum: adminWallet,
          walletAddressLower: adminWallet.toLowerCase(),
        },
      ]);
    await uow
      .current()
      .insert(merchants)
      .values({
        id: merchantId,
        onchainMerchantId: '7',
        ownerUserId: ownerId,
        slug: `payout-${merchantId.slice(-8).toLowerCase()}`,
        displayName: 'Payout Boundary Merchant',
        payoutAddress: ownerWallet,
        payoutAddressLower: ownerWallet.toLowerCase(),
        status: 'active',
        chainSyncStatus: 'confirmed',
      });
    await uow
      .current()
      .insert(merchantMembers)
      .values([
        { merchantId, userId: ownerId, role: 'owner' },
        { merchantId, userId: adminId, role: 'admin', invitedByUserId: ownerId },
      ]);
  }, 30_000);

  afterAll(async () => {
    if (handle === undefined) return;
    await uow.current().delete(merchantMembers).where(eq(merchantMembers.merchantId, merchantId));
    await uow.current().delete(merchants).where(eq(merchants.id, merchantId));
    await uow
      .current()
      .delete(users)
      .where(inArray(users.id, [ownerId, adminId]));
    await handle.close();
  });

  it('allows admin profile edits but reserves payout operations for the persisted owner', async () => {
    await expect(store.getMerchantChainContext(admin, merchantId)).rejects.toMatchObject({
      code: 'AUTH_FORBIDDEN',
    });
    await expect(
      store.updateMerchantProfile({
        actor: admin,
        expectedVersion: '1',
        patch: { displayName: 'Updated Public Name' },
      }),
    ).resolves.toMatchObject({ version: '2', merchant: { displayName: 'Updated Public Name' } });
    await expect(store.getMerchantChainContext(owner, merchantId)).resolves.toMatchObject({
      merchantOnchainId: '7',
      payoutAddress: ownerWallet,
    });
    await expect(
      store.updateMerchantProfile({ actor: owner, expectedVersion: '2', patch: {} }),
    ).resolves.toMatchObject({ version: '2', merchant: { payoutAddress: ownerWallet } });

    const [projection] = await uow
      .current()
      .select({ payoutAddress: merchants.payoutAddress, version: merchants.version })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    expect(projection).toEqual({ payoutAddress: ownerWallet, version: 2 });
  });
});
