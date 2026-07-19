import { CurrentUserSchema, MerchantSchema } from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { contractOperationEnvelope } from '../app/api/_lib/endpoints-merchant.js';
import { LiveBackendApiCommands } from '../app/api/_lib/live-commands.js';

const actor = CurrentUserSchema.parse({
  id: `usr_${'0'.repeat(25)}1`,
  walletAddress: '0x1111111111111111111111111111111111111111',
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [{ merchantId: `mer_${'0'.repeat(25)}1`, role: 'owner' }],
});

const merchant = MerchantSchema.parse({
  id: actor.merchantMemberships[0]?.merchantId,
  ownerUserId: actor.id,
  slug: 'opentab-payments-11111111',
  displayName: 'OpenTab Payments',
  supportContact: 'OpenTab payment operator',
  payoutAddress: actor.walletAddress,
  status: 'draft',
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:00:00.000Z',
});

describe('merchant activation recovery', () => {
  it('preserves the contract-operation response envelope expected by the browser', () => {
    const operation = { id: `cop_${'0'.repeat(25)}1` };
    expect(contractOperationEnvelope(operation)).toEqual({ operation });
    expect(contractOperationEnvelope(undefined)).toBeUndefined();
  });

  it('reissues an expired pending merchant operation without creating another merchant', async () => {
    const createMerchant = { execute: vi.fn() };
    const prepareContractOperation = vi.fn(
      async (input: { binding: unknown; template: unknown }) => ({
        id: `cop_${'0'.repeat(25)}2`,
        binding: input.binding,
        template: input.template,
      }),
    );
    const commands = new LiveBackendApiCommands({
      createMerchant,
      backend: {
        getMerchantProfile: vi.fn(async () => ({ merchant })),
        prepareContractOperation,
      },
      idempotency: {
        execute: async (input: { operation: () => Promise<unknown> }) => ({
          value: await input.operation(),
        }),
      },
      checkoutAddress: '0x2222222222222222222222222222222222222222',
      operationTtlSeconds: 900,
      now: () => new Date('2026-07-19T12:00:00.000Z'),
    } as never);

    const result = await commands.createMerchant({
      actor,
      body: {
        slug: merchant.slug,
        displayName: merchant.displayName,
        supportContact: merchant.supportContact,
        payoutAddress: merchant.payoutAddress,
      },
      idempotencyKeyHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      requestId: 'req_merchant_activation_recovery',
    });

    expect(createMerchant.execute).not.toHaveBeenCalled();
    expect(prepareContractOperation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ merchant, operation: { id: `cop_${'0'.repeat(25)}2` } });
    expect(prepareContractOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        aggregateId: merchant.id,
        kind: 'merchant_mutation',
        binding: expect.objectContaining({ expiresAt: '2026-07-19T12:15:00.000Z' }),
      }),
    );
  });
});
