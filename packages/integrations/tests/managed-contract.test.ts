import { EvmAddressSchema } from '@opentab/shared';
import {
  decodeFunctionData,
  type Hex,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { AwsKmsSecp256k1Signer } from '../src/aws-kms.js';
import { openTabSplitOperationAbi } from '../src/generated/operation-abis.js';
import { AwsKmsSplitRevocationSender } from '../src/managed-contract.js';
import {
  createSplitRevocationOperation,
  SplitRevocationOperationBindingSchema,
} from '../src/operation-templates.js';
import { createFakeAwsKms } from './helpers/aws-kms.js';

const splitContract = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const other = EvmAddressSchema.parse(`0x${'5'.repeat(40)}`);
const hash = `0x${'a'.repeat(64)}` as const;
const bytes32 = (character: string) => `0x${character.repeat(64)}` as const;

async function setup(input: { sendFails?: boolean; now?: Date } = {}) {
  const fake = createFakeAwsKms({ highS: true });
  const kms = await AwsKmsSecp256k1Signer.create({
    client: fake.client,
    keyId: 'alias/opentab-split',
    expectedAddress: fake.address,
  });
  let serialized: Hex | undefined;
  const chain = {
    getTransactionCount: vi.fn(async () => 7),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 100_000n,
    })),
    estimateGas: vi.fn(async () => 50_000n),
    sendRawTransaction: vi.fn(async (request: { serializedTransaction: Hex }) => {
      serialized = request.serializedTransaction;
      if (input.sendFails) throw new Error('transport closed after raw send');
      return hash;
    }),
  };
  const binding = SplitRevocationOperationBindingSchema.parse({
    invitationId: 'spi_01J00000000000000000000000',
    signerAddress: fake.address,
    chainId: '42161',
    splitContractAddress: splitContract,
    paymentKey: bytes32('c'),
    splitDigest: bytes32('d'),
    expiresAt: '2099-07-14T12:05:00.000Z',
  });
  const operation = createSplitRevocationOperation(binding);
  const sender = new AwsKmsSplitRevocationSender(chain, kms, {
    splitContractAddress: splitContract,
    maxFeePerGasWei: 3_000_000n,
    maxGasLimit: 100_000n,
    now: () => input.now ?? new Date('2026-07-14T12:00:00.000Z'),
  });
  return { fake, chain, binding, operation, sender, serialized: () => serialized };
}

describe('KMS split-revocation sender', () => {
  it('revalidates and signs only the exact zero-value Arbitrum revocation', async () => {
    const test = await setup();
    await expect(
      test.sender.submit({ binding: test.binding, operation: test.operation }),
    ).resolves.toEqual({ status: 'submitted', transactionHash: hash, signerNonce: '7' });

    const serialized = test.serialized();
    expect(serialized).toBeDefined();
    const transaction = parseTransaction(serialized as Hex);
    expect(transaction).toMatchObject({
      type: 'eip1559',
      chainId: 42_161,
      nonce: 7,
      to: splitContract,
      gas: 60_000n,
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 100_000n,
    });
    expect(transaction.value ?? 0n).toBe(0n);
    expect(
      decodeFunctionData({
        abi: openTabSplitOperationAbi,
        data: transaction.data as Hex,
      }),
    ).toMatchObject({
      functionName: 'revokePaymentKey',
      args: [test.binding.paymentKey, test.binding.splitDigest],
    });
    await expect(
      recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized }),
    ).resolves.toBe(test.fake.address);
  });

  it('returns submitted_unknown after an ambiguous raw-send failure', async () => {
    const test = await setup({ sendFails: true });
    await expect(
      test.sender.submit({ binding: test.binding, operation: test.operation }),
    ).resolves.toEqual({ status: 'submitted_unknown', signerNonce: '7' });
  });

  it('rejects target/call mutation and expiry before nonce, signing, or broadcast', async () => {
    const test = await setup();
    await expect(
      test.sender.submit({
        binding: test.binding,
        operation: { ...test.operation, call: { ...test.operation.call, to: other } },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_PLAN_INVALID' });
    expect(test.chain.getTransactionCount).not.toHaveBeenCalled();

    const expired = await setup({ now: new Date('2100-01-01T00:00:00.000Z') });
    await expect(
      expired.sender.submit({ binding: expired.binding, operation: expired.operation }),
    ).rejects.toMatchObject({ code: 'OPERATION_PLAN_INVALID' });
    expect(expired.chain.getTransactionCount).not.toHaveBeenCalled();
  });
});
