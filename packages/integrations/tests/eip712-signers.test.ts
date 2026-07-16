import {
  EvmAddressSchema,
  ORDER_INTENT_EIP712_FIELDS,
  OrderIntentSchema,
  SPLIT_INTENT_EIP712_FIELDS,
  SplitReimbursementIntentSchema,
} from '@opentab/shared';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  createDeterministicIntentSigners,
  createManagedIntentSigners,
  createPrivateKeyIntentSigners,
  createPrivateKeyOrderIntentSigner,
} from '../src/eip712-signers.js';

const orderPrivateKey = `0x${'21'.repeat(32)}` as const;
const splitPrivateKey = `0x${'22'.repeat(32)}` as const;
const checkout = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const splitContract = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const payer = EvmAddressSchema.parse(`0x${'5'.repeat(40)}`);
const beneficiary = EvmAddressSchema.parse(`0x${'6'.repeat(40)}`);
const token = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const bytes32 = (character: string) => `0x${character.repeat(64)}` as `0x${string}`;

function orderIntent() {
  return OrderIntentSchema.parse({
    orderKey: bytes32('7'),
    payer,
    recipient: payer,
    merchantOnchainId: '1',
    productOnchainId: '2',
    productVersion: '1',
    token,
    amountBaseUnits: '1000000',
    platformFeeBps: '100',
    platformFeeBaseUnits: '10000',
    quantity: '1',
    validAfter: '0',
    validUntil: '1784030700',
    refundDeadline: '1784034300',
    metadataHash: bytes32('8'),
  });
}

function splitIntent() {
  return SplitReimbursementIntentSchema.parse({
    paymentKey: bytes32('9'),
    splitDigest: bytes32('a'),
    originalOrderKey: bytes32('7'),
    payer,
    beneficiary,
    token,
    amountBaseUnits: '500000',
    validAfter: '0',
    validUntil: '1784030700',
    metadataHash: bytes32('b'),
  });
}

function privateSigners(overrides: Record<string, unknown> = {}) {
  return createPrivateKeyIntentSigners({
    environment: 'test',
    orderPrivateKey,
    splitPrivateKey,
    order: { signerKeyId: 'order-role-key', verifyingContract: checkout },
    split: { signerKeyId: 'split-role-key', verifyingContract: splitContract },
    ...overrides,
  });
}

describe('EIP-712 intent signer boundaries', () => {
  it('uses distinct roles, domains, addresses, and recovered signatures', async () => {
    const signers = privateSigners();
    const order = await signers.order.signIntent(orderIntent());
    const split = await signers.split.signIntent(splitIntent());

    expect(order.signerKeyId).toBe('order-role-key');
    expect(split.signerKeyId).toBe('split-role-key');
    expect(order.signerAddress).toBe(signers.orderSignerAddress);
    expect(split.signerAddress).toBe(signers.splitSignerAddress);
    expect(order.signerAddress.toLowerCase()).not.toBe(split.signerAddress.toLowerCase());
    expect(order.digest).not.toBe(split.digest);
  });

  it('changes the order digest when the verifying contract changes', async () => {
    const first = privateSigners();
    const second = privateSigners({
      order: {
        signerKeyId: 'order-role-key',
        verifyingContract: EvmAddressSchema.parse(`0x${'c'.repeat(40)}`),
      },
    });
    expect((await first.order.signIntent(orderIntent())).digest).not.toBe(
      (await second.order.signIntent(orderIntent())).digest,
    );
  });

  it('rejects same-key role reuse and private keys outside local/test', () => {
    expect(() => privateSigners({ splitPrivateKey: orderPrivateKey })).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
    );
    for (const environment of ['preview', 'staging', 'demo-mainnet', 'production']) {
      expect(() => privateSigners({ environment })).toThrow(
        expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
      );
    }
  });

  it('composes the order role without requiring a split key when splits are disabled', async () => {
    const signer = createPrivateKeyOrderIntentSigner({
      environment: 'test',
      orderPrivateKey,
      order: { signerKeyId: 'order-only-role', verifyingContract: checkout },
    });
    await expect(signer.order.signIntent(orderIntent())).resolves.toMatchObject({
      signerKeyId: 'order-only-role',
      signerAddress: signer.orderSignerAddress,
    });
    for (const environment of ['preview', 'staging', 'demo-mainnet', 'production']) {
      expect(() =>
        createPrivateKeyOrderIntentSigner({
          environment,
          orderPrivateKey,
          order: { signerKeyId: 'order-only-role', verifyingContract: checkout },
        }),
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    }
  });

  it('offers a narrow managed-backend factory and verifies configured addresses', async () => {
    const orderAccount = privateKeyToAccount(orderPrivateKey);
    const splitAccount = privateKeyToAccount(splitPrivateKey);
    const managed = createManagedIntentSigners({
      environment: 'production',
      orderBackend: {
        address: EvmAddressSchema.parse(orderAccount.address),
        signOrder(input) {
          return orderAccount.signTypedData({
            domain: input.domain,
            types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
            primaryType: 'OrderIntent',
            message: input.message,
          });
        },
      },
      splitBackend: {
        address: EvmAddressSchema.parse(splitAccount.address),
        signSplit(input) {
          return splitAccount.signTypedData({
            domain: input.domain,
            types: { SplitIntent: SPLIT_INTENT_EIP712_FIELDS },
            primaryType: 'SplitIntent',
            message: input.message,
          });
        },
      },
      order: {
        signerKeyId: 'kms/order-role',
        verifyingContract: checkout,
        expectedSignerAddress: EvmAddressSchema.parse(getAddress(orderAccount.address)),
      },
      split: {
        signerKeyId: 'kms/split-role',
        verifyingContract: splitContract,
        expectedSignerAddress: EvmAddressSchema.parse(getAddress(splitAccount.address)),
      },
    });

    await expect(managed.order.signIntent(orderIntent())).resolves.toMatchObject({
      signerKeyId: 'kms/order-role',
    });
    await expect(managed.split.signIntent(splitIntent())).resolves.toMatchObject({
      signerKeyId: 'kms/split-role',
    });

    expect(() =>
      createManagedIntentSigners({
        environment: 'production',
        orderBackend: {
          address: EvmAddressSchema.parse(orderAccount.address),
          signOrder: async () => bytes32('d'),
        },
        splitBackend: {
          address: EvmAddressSchema.parse(orderAccount.address),
          signSplit: async () => bytes32('e'),
        },
        order: {
          signerKeyId: 'kms/order-role',
          verifyingContract: checkout,
          expectedSignerAddress: EvmAddressSchema.parse(orderAccount.address),
        },
        split: {
          signerKeyId: 'kms/split-role',
          verifyingContract: splitContract,
          expectedSignerAddress: EvmAddressSchema.parse(orderAccount.address),
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });

  it('supports an explicit keyless deterministic preview fake and no live environment', async () => {
    const fake = createDeterministicIntentSigners({
      environment: 'preview',
      providerMode: 'deterministic',
      deterministicDemoEnabled: true,
      orderVerifyingContract: checkout,
      splitVerifyingContract: splitContract,
    });
    await expect(fake.order.signIntent(orderIntent())).resolves.toMatchObject({
      signerKeyId: 'deterministic-order-intent-v1',
      signerAddress: fake.orderSignerAddress,
    });
    await expect(fake.split.signIntent(splitIntent())).resolves.toMatchObject({
      signerKeyId: 'deterministic-split-intent-v1',
      signerAddress: fake.splitSignerAddress,
    });
    for (const environment of ['staging', 'demo-mainnet', 'production']) {
      expect(() =>
        createDeterministicIntentSigners({
          environment,
          providerMode: 'deterministic',
          deterministicDemoEnabled: true,
          orderVerifyingContract: checkout,
          splitVerifyingContract: splitContract,
        }),
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    }
    expect(() =>
      createDeterministicIntentSigners({
        environment: 'preview',
        providerMode: 'deterministic',
        deterministicDemoEnabled: false,
        orderVerifyingContract: checkout,
        splitVerifyingContract: splitContract,
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });
});
