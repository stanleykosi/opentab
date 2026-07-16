import { Buffer } from 'node:buffer';
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import {
  EvmAddressSchema,
  ORDER_INTENT_EIP712_FIELDS,
  OrderIntentSchema,
  SplitReimbursementIntentSchema,
} from '@opentab/shared';
import {
  type Hex,
  parseSignature,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type TransactionSerialized,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  type AwsKmsClientLike,
  AwsKmsSecp256k1Signer,
  createAwsKmsClient,
  createVercelOidcAwsKmsClient,
  parseAwsKmsDerSignature,
} from '../src/aws-kms.js';
import { createAwsKmsIntentSigners, createAwsKmsOrderIntentSigner } from '../src/eip712-signers.js';
import { AwsKmsNativeTransferSigner } from '../src/sponsor.js';
import fixture from './fixtures/aws-kms/secp256k1-signing-v1.json';
import { createFakeAwsKms } from './helpers/aws-kms.js';

const CURVE_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const checkout = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const payer = EvmAddressSchema.parse(`0x${'5'.repeat(40)}`);
const recipient = EvmAddressSchema.parse(`0x${'6'.repeat(40)}`);
const token = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const transactionHash = `0x${'a'.repeat(64)}` as const;

function fixedClient(derBase64: string): AwsKmsClientLike {
  return {
    async send(command: GetPublicKeyCommand | SignCommand) {
      if (command instanceof GetPublicKeyCommand) {
        return {
          $metadata: {},
          KeyId: fixture.resolvedKeyId,
          PublicKey: Buffer.from(fixture.spkiBase64, 'base64'),
          KeySpec: 'ECC_SECG_P256K1' as const,
          KeyUsage: 'SIGN_VERIFY' as const,
          SigningAlgorithms: ['ECDSA_SHA_256' as const],
        };
      }
      return {
        $metadata: {},
        KeyId: fixture.resolvedKeyId,
        Signature: Buffer.from(derBase64, 'base64'),
        SigningAlgorithm: 'ECDSA_SHA_256' as const,
      };
    },
  } as AwsKmsClientLike;
}

function orderIntent() {
  return OrderIntentSchema.parse({
    orderKey: `0x${'7'.repeat(64)}`,
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
    metadataHash: `0x${'8'.repeat(64)}`,
  });
}

describe('AWS KMS secp256k1 boundary', () => {
  it.each([
    fixture.derLowBase64,
    fixture.derHighBase64,
  ])('derives the reviewed address and returns a canonical recoverable signature', async (der) => {
    const signer = await AwsKmsSecp256k1Signer.create({
      client: fixedClient(der),
      keyId: 'alias/opentab-fixture',
      expectedAddress: EvmAddressSchema.parse(fixture.address),
    });
    const signature = await signer.signDigest(fixture.digest as Hex);
    expect(await recoverAddress({ hash: fixture.digest as Hex, signature })).toEqual(
      fixture.address,
    );
    expect(BigInt(parseSignature(signature).s)).toBeLessThanOrEqual(CURVE_HALF_ORDER);
  });

  it('rejects malformed DER and mismatched public-key or response identities', async () => {
    expect(() => parseAwsKmsDerSignature(Uint8Array.from([0x30, 0x01, 0x00]))).toThrow(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
    await expect(
      AwsKmsSecp256k1Signer.create({
        client: fixedClient(fixture.derLowBase64),
        keyId: 'alias/opentab-fixture',
        expectedAddress: EvmAddressSchema.parse(`0x${'1'.repeat(40)}`),
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });

    const signer = await AwsKmsSecp256k1Signer.create({
      client: fixedClient(fixture.derLowBase64),
      keyId: 'alias/opentab-fixture',
      expectedAddress: EvmAddressSchema.parse(fixture.address),
    });
    await expect(signer.signDigest('0x01')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const base = fixedClient(fixture.derLowBase64);
    const switchedKeyClient = {
      async send(command: GetPublicKeyCommand | SignCommand) {
        const response = await base.send(command as never);
        return command instanceof SignCommand
          ? { ...response, KeyId: `${fixture.resolvedKeyId}-retargeted` }
          : response;
      },
    } as unknown as AwsKmsClientLike;
    const switched = await AwsKmsSecp256k1Signer.create({
      client: switchedKeyClient,
      keyId: 'alias/opentab-fixture',
      expectedAddress: EvmAddressSchema.parse(fixture.address),
    });
    await expect(switched.signDigest(fixture.digest as Hex)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });

    const wrongSpecClient = {
      async send(command: GetPublicKeyCommand | SignCommand) {
        const response = await base.send(command as never);
        return command instanceof GetPublicKeyCommand
          ? { ...response, KeySpec: 'ECC_NIST_P256' as const }
          : response;
      },
    } as unknown as AwsKmsClientLike;
    await expect(
      AwsKmsSecp256k1Signer.create({
        client: wrongSpecClient,
        keyId: 'alias/opentab-fixture',
        expectedAddress: EvmAddressSchema.parse(fixture.address),
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
  });

  it('maps rate limits safely and validates the AWS retry/region policy', async () => {
    const client = {
      async send() {
        throw Object.assign(new Error('redacted'), { name: 'ThrottlingException' });
      },
    } as unknown as AwsKmsClientLike;
    await expect(
      AwsKmsSecp256k1Signer.create({
        client,
        keyId: 'alias/rate-limited',
        expectedAddress: EvmAddressSchema.parse(fixture.address),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(() => createAwsKmsClient({ region: 'not-a-region' })).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
    );
    expect(() => createAwsKmsClient({ region: 'eu-west-1', maxAttempts: 9 })).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
    );
  });

  it('lazily injects short-lived Vercel OIDC credentials into AWS KMS', async () => {
    let loaded = false;
    let receivedRoleArn: string | undefined;
    const credentials = {
      accessKeyId: 'ASIAOIDCFIXTURE',
      secretAccessKey: 'fixture-secret-not-a-real-credential',
      sessionToken: 'fixture-session-token',
      expiration: new Date('2030-01-01T00:00:00.000Z'),
    };
    const client = await createVercelOidcAwsKmsClient({
      region: 'eu-west-1',
      roleArn: 'arn:aws:iam::123456789012:role/opentab/vercel-web',
      loadCredentialProvider: async () => {
        loaded = true;
        return {
          awsCredentialsProvider(init) {
            receivedRoleArn = init.roleArn;
            return async () => credentials;
          },
        };
      },
    });

    expect(loaded).toBe(true);
    expect(receivedRoleArn).toBe('arn:aws:iam::123456789012:role/opentab/vercel-web');
    await expect(client.config.credentials()).resolves.toEqual(credentials);
    await expect(
      createVercelOidcAwsKmsClient({
        region: 'eu-west-1',
        roleArn: 'arn:aws:iam::123456789012:user/not-a-role',
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
  });

  it('signs the exact EIP-712 order digest through the managed backend', async () => {
    const fake = createFakeAwsKms({ highS: true });
    const managed = await createAwsKmsOrderIntentSigner({
      environment: 'production',
      region: 'eu-west-1',
      keyId: 'alias/opentab-order',
      expectedSignerAddress: fake.address,
      verifyingContract: checkout,
      client: fake.client,
    });
    const signed = await managed.order.signIntent(orderIntent());
    expect(signed.signerAddress).toBe(fake.address);
    expect(signed.signerKeyId).toBe(`aws-kms:${fake.address.toLowerCase()}`);
    expect(
      await recoverTypedDataAddress({
        domain: {
          name: 'OpenTab Order Intent',
          version: '1',
          chainId: 42_161,
          verifyingContract: checkout as `0x${string}`,
        },
        types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
        primaryType: 'OrderIntent',
        message: {
          orderKey: orderIntent().orderKey as Hex,
          payer: payer as `0x${string}`,
          recipient: payer as `0x${string}`,
          merchantId: 1n,
          productId: 2n,
          productVersion: 1n,
          token: token as `0x${string}`,
          amount: 1_000_000n,
          platformFeeBps: 100,
          platformFee: 10_000n,
          quantity: 1n,
          validAfter: 0n,
          validUntil: 1_784_030_700n,
          refundDeadline: 1_784_034_300n,
          metadataHash: orderIntent().metadataHash as Hex,
        },
        signature: signed.signature,
      }),
    ).toBe(fake.address);
  });

  it('keeps AWS KMS order and split intent roles cryptographically separate', async () => {
    const orderKms = createFakeAwsKms();
    const splitKms = createFakeAwsKms({ highS: true });
    const client = {
      async send(command: GetPublicKeyCommand | SignCommand) {
        const keyId = command.input.KeyId;
        if (keyId === 'alias/order' || keyId === orderKms.resolvedKeyId) {
          return orderKms.client.send(command as never);
        }
        if (keyId === 'alias/split' || keyId === splitKms.resolvedKeyId) {
          return splitKms.client.send(command as never);
        }
        throw new Error('Unknown test KMS role');
      },
    } as unknown as AwsKmsClientLike;
    const signers = await createAwsKmsIntentSigners({
      environment: 'production',
      region: 'eu-west-1',
      client,
      order: {
        keyId: 'alias/order',
        expectedSignerAddress: orderKms.address,
        verifyingContract: checkout,
      },
      split: {
        keyId: 'alias/split',
        expectedSignerAddress: splitKms.address,
        verifyingContract: EvmAddressSchema.parse(`0x${'4'.repeat(40)}`),
      },
    });
    const splitIntent = SplitReimbursementIntentSchema.parse({
      paymentKey: `0x${'9'.repeat(64)}`,
      splitDigest: `0x${'a'.repeat(64)}`,
      originalOrderKey: `0x${'7'.repeat(64)}`,
      payer,
      beneficiary: recipient,
      token,
      amountBaseUnits: '500000',
      validAfter: '0',
      validUntil: '1784030700',
      metadataHash: `0x${'b'.repeat(64)}`,
    });
    await expect(signers.order.signIntent(orderIntent())).resolves.toMatchObject({
      signerAddress: orderKms.address,
      signerKeyId: `aws-kms:${orderKms.address.toLowerCase()}`,
    });
    await expect(signers.split.signIntent(splitIntent)).resolves.toMatchObject({
      signerAddress: splitKms.address,
      signerKeyId: `aws-kms:${splitKms.address.toLowerCase()}`,
    });
  });

  it('signs and broadcasts only an exact plain Arbitrum native transfer', async () => {
    const fake = createFakeAwsKms();
    const kms = await AwsKmsSecp256k1Signer.create({
      client: fake.client,
      keyId: 'alias/opentab-sponsor',
      expectedAddress: fake.address,
    });
    let serialized: Hex | undefined;
    const chain = {
      getBalance: async () => 1_000_000_000n,
      getCode: async () => '0x' as const,
      getTransactionCount: async () => 3,
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 2_000_000n,
        maxPriorityFeePerGas: 100_000n,
      }),
      sendRawTransaction: async (input: { serializedTransaction: Hex }) => {
        serialized = input.serializedTransaction;
        return transactionHash;
      },
    };
    const signer = new AwsKmsNativeTransferSigner(chain, kms, 3_000_000n);
    const prepared = await signer.prepareNativeTransfer({
      recipient,
      amountWei: 50_000n,
      nonce: 3,
    });
    expect(prepared.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(prepared.broadcast()).resolves.toBe(transactionHash);
    expect(serialized).toBeDefined();
    const transaction = parseTransaction(serialized as Hex);
    expect(transaction).toMatchObject({
      type: 'eip1559',
      chainId: 42_161,
      nonce: 3,
      to: recipient,
      value: 50_000n,
      gas: 21_000n,
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 100_000n,
    });
    expect(transaction.data).toBeUndefined();
    await expect(
      recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized }),
    ).resolves.toBe(fake.address);
  });

  it('fails before signing or broadcast when the sponsor fee quote exceeds policy', async () => {
    const fake = createFakeAwsKms();
    const kms = await AwsKmsSecp256k1Signer.create({
      client: fake.client,
      keyId: 'alias/opentab-sponsor',
      expectedAddress: fake.address,
    });
    const sendCountBefore = fake.commands.filter((entry) => entry instanceof SignCommand).length;
    const chain = {
      getBalance: async () => 1_000_000_000n,
      getCode: async () => '0x' as const,
      getTransactionCount: async () => 3,
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 4_000_000n,
        maxPriorityFeePerGas: 100_000n,
      }),
      sendRawTransaction: async () => transactionHash,
    };
    const signer = new AwsKmsNativeTransferSigner(chain, kms, 3_000_000n);
    await expect(
      signer.prepareNativeTransfer({ recipient, amountWei: 50_000n, nonce: 3 }),
    ).rejects.toMatchObject({ code: 'SPONSOR_BUDGET_EXHAUSTED' });
    expect(fake.commands.filter((entry) => entry instanceof SignCommand)).toHaveLength(
      sendCountBefore,
    );
  });
});
