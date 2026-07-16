import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  EvmAddressSchema,
} from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createPrivateKeySponsorTransferAdapter,
  PolicyBoundSponsorTransferAdapter,
} from '../src/sponsor.js';

const sponsor = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const recipient = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const secondRecipient = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const hash = (character: string) => `0x${character.repeat(64)}` as `0x${string}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'test',
    minimumGrantWei: 1_000n,
    maxGrantWei: 10_000n,
    allowlistOnly: true,
    allowedRecipients: [recipient, secondRecipient],
    ...overrides,
  };
}

function setup(input: { sendFails?: boolean; code?: `0x${string}` } = {}) {
  let pendingNonce = 5;
  const chain = {
    getBalance: vi.fn(async () => 1_000_000n),
    getCode: vi.fn(async () => input.code ?? ('0x' as const)),
    getTransactionCount: vi.fn(async () => pendingNonce),
  };
  const signer = {
    address: sponsor,
    prepareNativeTransfer: vi.fn(
      async (_transfer: { recipient: typeof recipient; amountWei: bigint; nonce: number }) => {
        const result = hash((pendingNonce % 10).toString());
        return {
          transactionHash: result,
          broadcast: async () => {
            if (input.sendFails) throw new Error('transport closed after send');
            pendingNonce += 1;
            return result;
          },
        };
      },
    ),
  };
  return { chain, signer, adapter: new PolicyBoundSponsorTransferAdapter(chain, signer, config()) };
}

describe('policy-bound activation gas sponsor', () => {
  it('queries distinct pending nonces across sequential, externally locked requests', async () => {
    const { adapter, chain, signer } = setup();
    const first = await (
      await adapter.prepareActivationGas({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        recipient,
        amountWei: BaseUnitAmountSchema.parse('2000'),
        idempotencyReference: 'grant_reference_one',
        signerNonce: '5',
      })
    ).submit();
    const second = await (
      await adapter.prepareActivationGas({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        recipient: secondRecipient,
        amountWei: BaseUnitAmountSchema.parse('2000'),
        idempotencyReference: 'grant_reference_two',
        signerNonce: '6',
      })
    ).submit();

    expect(first).toMatchObject({ status: 'submitted', signerNonce: '5' });
    expect(second).toMatchObject({ status: 'submitted', signerNonce: '6' });
    expect(chain.getTransactionCount).toHaveBeenCalledTimes(2);
    expect(signer.prepareNativeTransfer.mock.calls.map(([call]) => call.nonce)).toEqual([5, 6]);
  });

  it('returns its cached result for a duplicate local reference without a second send', async () => {
    const { adapter, signer } = setup();
    const request = {
      chainId: ARBITRUM_ONE_CHAIN_ID,
      recipient,
      amountWei: BaseUnitAmountSchema.parse('2000'),
      idempotencyReference: 'grant_duplicate_reference',
      signerNonce: '5',
    };
    const first = await (await adapter.prepareActivationGas(request)).submit();
    const second = await (await adapter.prepareActivationGas(request)).submit();
    expect(second).toEqual(first);
    expect(signer.prepareNativeTransfer).toHaveBeenCalledTimes(1);
  });

  it('marks any error after signer invocation submitted-unknown and never retries it locally', async () => {
    const { adapter, signer } = setup({ sendFails: true });
    const request = {
      chainId: ARBITRUM_ONE_CHAIN_ID,
      recipient,
      amountWei: BaseUnitAmountSchema.parse('2000'),
      idempotencyReference: 'grant_unknown_reference',
      signerNonce: '5',
    };
    await expect((await adapter.prepareActivationGas(request)).submit()).resolves.toEqual({
      status: 'submitted_unknown',
      transactionHash: hash('5'),
      signerNonce: '5',
    });
    await (await adapter.prepareActivationGas(request)).submit();
    expect(signer.prepareNativeTransfer).toHaveBeenCalledTimes(1);
  });

  it('propagates a known pre-broadcast managed-signer failure for safe retry', async () => {
    const prepared = setup();
    prepared.signer.prepareNativeTransfer.mockRejectedValueOnce(
      new AppError('RATE_LIMITED', 'Managed signer is rate limited.', { retryable: true }),
    );
    await expect(
      prepared.adapter.prepareActivationGas({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        recipient,
        amountWei: BaseUnitAmountSchema.parse('2000'),
        idempotencyReference: 'grant_prebroadcast_retry',
        signerNonce: '5',
      }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      submissionPossible: false,
    });
  });

  it('rejects arbitrary recipients, values, delegated accounts, and the signer itself', async () => {
    const unlisted = EvmAddressSchema.parse(`0x${'9'.repeat(40)}`);
    const { adapter } = setup();
    await expect(
      adapter.prepareActivationGas({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        recipient: unlisted,
        amountWei: BaseUnitAmountSchema.parse('2000'),
        idempotencyReference: 'grant_unlisted_reference',
        signerNonce: '5',
      }),
    ).rejects.toMatchObject({ code: 'SPONSOR_INELIGIBLE' });
    await expect(
      adapter.prepareActivationGas({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        recipient,
        amountWei: BaseUnitAmountSchema.parse('999999'),
        idempotencyReference: 'grant_oversize_reference',
        signerNonce: '5',
      }),
    ).rejects.toMatchObject({ code: 'SPONSOR_INELIGIBLE' });

    const delegated = setup({ code: `0xef0100${'4'.repeat(40)}` });
    await expect(
      delegated.adapter.prepareActivationGas({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        recipient,
        amountWei: BaseUnitAmountSchema.parse('2000'),
        idempotencyReference: 'grant_delegated_reference',
        signerNonce: '5',
      }),
    ).rejects.toMatchObject({ code: 'SPONSOR_INELIGIBLE' });

    const selfAllowed = new PolicyBoundSponsorTransferAdapter(
      setup().chain,
      setup().signer,
      config({ allowedRecipients: [sponsor] }),
    );
    await expect(
      selfAllowed.prepareActivationGas({
        chainId: ARBITRUM_ONE_CHAIN_ID,
        recipient: sponsor,
        amountWei: BaseUnitAmountSchema.parse('2000'),
        idempotencyReference: 'grant_self_reference',
        signerNonce: '5',
      }),
    ).rejects.toMatchObject({ code: 'SPONSOR_INELIGIBLE' });
  });

  it('enforces HTTPS, provider independence, bounded timeouts, and managed production signing', () => {
    const base = {
      config: config({ environment: 'test' }),
      privateKey: `0x${'11'.repeat(32)}` as const,
      primaryRpcUrl: 'https://rpc-one.example',
      fallbackRpcUrl: 'https://rpc-two.example',
    };
    expect(() =>
      createPrivateKeySponsorTransferAdapter({
        ...base,
        primaryRpcUrl: 'ftp://rpc-one.example',
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(() =>
      createPrivateKeySponsorTransferAdapter({
        ...base,
        fallbackRpcUrl: 'https://rpc-one.example/another-path',
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(() =>
      createPrivateKeySponsorTransferAdapter({
        ...base,
        config: config({ environment: 'test', requestTimeoutMs: 100 }),
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    for (const environment of ['preview', 'staging', 'demo-mainnet', 'production']) {
      expect(() =>
        createPrivateKeySponsorTransferAdapter({
          ...base,
          config: config({ environment }),
        }),
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    }
  });
});
