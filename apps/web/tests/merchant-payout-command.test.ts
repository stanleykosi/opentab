import type { BackendApiCommandPort, ContractOperationRecord } from '@opentab/application';
import {
  AppError,
  CurrentUserSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  UserIdSchema,
} from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { LiveBackendApiCommands } from '../app/api/_lib/live-commands.js';

const merchantId = MerchantIdSchema.parse('mer_01J00000000000000000000001');
const ownerId = UserIdSchema.parse('usr_01J00000000000000000000001');
const owner = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const currentPayout = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const nextPayout = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const checkout = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const actor = CurrentUserSchema.parse({
  id: ownerId,
  walletAddress: owner,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [{ merchantId, role: 'owner' }],
});

function context(body: Readonly<Record<string, unknown>>) {
  return {
    actor,
    body,
    idempotencyKeyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    requestId: 'req_01J00000000000000000000001',
  } satisfies Parameters<BackendApiCommandPort['updateMerchantProfile']>[0];
}

describe('merchant payout command boundary', () => {
  it('leaves the projection unchanged and returns an owner-bound onchain operation', async () => {
    const merchant = {
      id: merchantId,
      ownerUserId: ownerId,
      slug: 'harbor-sessions',
      displayName: 'Harbor Sessions',
      payoutAddress: currentPayout,
      status: 'active',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    } as const;
    const updateMerchantProfile = vi.fn(async () => ({ merchant, version: '3' }));
    const prepareContractOperation = vi.fn(async (input: Record<string, unknown>) => {
      const template = input.template as ContractOperationRecord['template'];
      return {
        id: 'cop_01J00000000000000000000001',
        kind: 'merchant_mutation',
        aggregateType: 'merchant',
        aggregateId: merchantId,
        binding: input.binding as Readonly<Record<string, unknown>>,
        template,
        bindingDigest: template.bindingDigest,
        status: 'prepared',
        expiresAt: template.expiresAt,
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      } satisfies ContractOperationRecord;
    });
    const commands = new LiveBackendApiCommands({
      idempotency: {
        execute: async (input: { operation: () => Promise<unknown> }) => ({
          state: 'created',
          value: await input.operation(),
        }),
      },
      backend: {
        getMerchantChainContext: async () => ({
          merchantId,
          merchantOnchainId: '7',
          payoutAddress: currentPayout,
          status: 'active',
          profile: {},
        }),
        updateMerchantProfile,
        prepareContractOperation,
      },
      checkoutAddress: checkout,
      operationTtlSeconds: 900,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    } as never);

    const result = await commands.updateMerchantProfile(
      context({ expectedVersion: '3', payoutAddress: nextPayout }),
    );

    expect(updateMerchantProfile).toHaveBeenCalledWith({
      actor,
      expectedVersion: '3',
      patch: {},
    });
    expect(result).toMatchObject({ merchant: { payoutAddress: currentPayout }, version: '3' });
    expect(prepareContractOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        kind: 'merchant_mutation',
        aggregateType: 'merchant',
        aggregateId: merchantId,
        binding: expect.objectContaining({
          ownerAddress: owner,
          mutation: {
            action: 'update_merchant_payout',
            merchantOnchainId: '7',
            payoutAddress: nextPayout,
          },
        }),
      }),
    );
  });

  it('does not mutate profile state when owner authorization is denied', async () => {
    const updateMerchantProfile = vi.fn();
    const commands = new LiveBackendApiCommands({
      idempotency: {
        execute: async (input: { operation: () => Promise<unknown> }) => ({
          state: 'created',
          value: await input.operation(),
        }),
      },
      backend: {
        getMerchantChainContext: async () => {
          throw new AppError('AUTH_FORBIDDEN', 'Owner approval is required.');
        },
        updateMerchantProfile,
      },
      checkoutAddress: checkout,
      operationTtlSeconds: 900,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    } as never);

    await expect(
      commands.updateMerchantProfile(context({ expectedVersion: '3', payoutAddress: nextPayout })),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(updateMerchantProfile).not.toHaveBeenCalled();
  });
});
