import type { OrderIntentSignerPort } from '@opentab/application';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type EvmAddress,
  EvmAddressSchema,
  ORDER_INTENT_EIP712_FIELDS,
  type OrderIntent,
  OrderIntentSchema,
  SPLIT_INTENT_EIP712_FIELDS,
  type SplitReimbursementIntent,
  SplitReimbursementIntentSchema,
  sameEvmAddress,
} from '@opentab/shared';
import {
  getAddress,
  type Hex,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type AwsKmsClientLike, AwsKmsSecp256k1Signer, createAwsKmsClient } from './aws-kms.js';

const CHAIN_ID = Number(ARBITRUM_ONE_CHAIN_ID);
type IntentDomain = {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: `0x${string}`;
};

function orderMessage(intent: OrderIntent) {
  return {
    orderKey: intent.orderKey as Hex,
    payer: getAddress(intent.payer),
    recipient: getAddress(intent.recipient),
    merchantId: BigInt(intent.merchantOnchainId),
    productId: BigInt(intent.productOnchainId),
    productVersion: BigInt(intent.productVersion),
    token: getAddress(intent.token),
    amount: BigInt(intent.amountBaseUnits),
    platformFeeBps: Number(intent.platformFeeBps),
    platformFee: BigInt(intent.platformFeeBaseUnits),
    quantity: BigInt(intent.quantity),
    validAfter: BigInt(intent.validAfter),
    validUntil: BigInt(intent.validUntil),
    refundDeadline: BigInt(intent.refundDeadline),
    metadataHash: intent.metadataHash as Hex,
  } as const;
}

function splitMessage(intent: SplitReimbursementIntent) {
  return {
    paymentKey: intent.paymentKey as Hex,
    splitDigest: intent.splitDigest as Hex,
    originalOrderKey: intent.originalOrderKey as Hex,
    payer: getAddress(intent.payer),
    beneficiary: getAddress(intent.beneficiary),
    token: getAddress(intent.token),
    amount: BigInt(intent.amountBaseUnits),
    validAfter: BigInt(intent.validAfter),
    validUntil: BigInt(intent.validUntil),
    metadataHash: intent.metadataHash as Hex,
  } as const;
}

export interface OrderSigningBackend {
  readonly address: EvmAddress;
  signOrder(input: {
    domain: IntentDomain;
    message: ReturnType<typeof orderMessage>;
  }): Promise<Hex>;
}

export interface SplitSigningBackend {
  readonly address: EvmAddress;
  signSplit(input: {
    domain: IntentDomain;
    message: ReturnType<typeof splitMessage>;
  }): Promise<Hex>;
}

export interface IntentSignerConfig {
  readonly environment: string;
  readonly signerKeyId: string;
  readonly verifyingContract: EvmAddress;
  readonly expectedSignerAddress: EvmAddress;
}

export class ViemOrderIntentSigner implements OrderIntentSignerPort<OrderIntent> {
  constructor(
    private readonly backend: OrderSigningBackend,
    private readonly config: IntentSignerConfig,
  ) {
    if (!sameEvmAddress(backend.address, config.expectedSignerAddress)) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Order signer address does not match configuration.',
      );
    }
    if (!/^[A-Za-z0-9_.:/-]{3,80}$/.test(config.signerKeyId)) {
      throw new AppError('CONFIGURATION_INVALID', 'Order signer key ID is invalid.');
    }
  }

  async signIntent(intentInput: OrderIntent) {
    const intent = OrderIntentSchema.parse(intentInput);
    const domain = {
      name: 'OpenTab Order Intent',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: getAddress(this.config.verifyingContract),
    } as const;
    const message = orderMessage(intent);
    const digest = hashTypedData({
      domain,
      types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
      primaryType: 'OrderIntent',
      message,
    });
    const signature = await this.backend.signOrder({ domain, message });
    const recovered = EvmAddressSchema.parse(
      await recoverTypedDataAddress({
        domain,
        types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
        primaryType: 'OrderIntent',
        message,
        signature,
      }),
    );
    if (!sameEvmAddress(recovered, this.config.expectedSignerAddress)) {
      throw new AppError('OPERATION_PLAN_INVALID', 'Order intent signature recovery failed.');
    }
    return {
      digest,
      signature,
      signerAddress: recovered,
      signerKeyId: this.config.signerKeyId,
    };
  }
}

export class ViemSplitIntentSigner implements OrderIntentSignerPort<SplitReimbursementIntent> {
  constructor(
    private readonly backend: SplitSigningBackend,
    private readonly config: IntentSignerConfig,
  ) {
    if (!sameEvmAddress(backend.address, config.expectedSignerAddress)) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Split signer address does not match configuration.',
      );
    }
    if (!/^[A-Za-z0-9_.:/-]{3,80}$/.test(config.signerKeyId)) {
      throw new AppError('CONFIGURATION_INVALID', 'Split signer key ID is invalid.');
    }
  }

  async signIntent(intentInput: SplitReimbursementIntent) {
    const intent = SplitReimbursementIntentSchema.parse(intentInput);
    const domain = {
      name: 'OpenTab Split Reimbursement',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: getAddress(this.config.verifyingContract),
    } as const;
    const message = splitMessage(intent);
    const digest = hashTypedData({
      domain,
      types: { SplitIntent: SPLIT_INTENT_EIP712_FIELDS },
      primaryType: 'SplitIntent',
      message,
    });
    const signature = await this.backend.signSplit({ domain, message });
    const recovered = EvmAddressSchema.parse(
      await recoverTypedDataAddress({
        domain,
        types: { SplitIntent: SPLIT_INTENT_EIP712_FIELDS },
        primaryType: 'SplitIntent',
        message,
        signature,
      }),
    );
    if (!sameEvmAddress(recovered, this.config.expectedSignerAddress)) {
      throw new AppError('OPERATION_PLAN_INVALID', 'Split intent signature recovery failed.');
    }
    return {
      digest,
      signature,
      signerAddress: recovered,
      signerKeyId: this.config.signerKeyId,
    };
  }
}

export function createManagedIntentSigners(input: {
  environment: string;
  orderBackend: OrderSigningBackend;
  splitBackend: SplitSigningBackend;
  order: Omit<IntentSignerConfig, 'environment'>;
  split: Omit<IntentSignerConfig, 'environment'>;
}): { order: ViemOrderIntentSigner; split: ViemSplitIntentSigner } {
  if (sameEvmAddress(input.orderBackend.address, input.splitBackend.address)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Order and split intents require separate signing roles.',
    );
  }
  return {
    order: new ViemOrderIntentSigner(input.orderBackend, {
      ...input.order,
      environment: input.environment,
    }),
    split: new ViemSplitIntentSigner(input.splitBackend, {
      ...input.split,
      environment: input.environment,
    }),
  };
}

function kmsSignerReference(address: EvmAddress): string {
  return `aws-kms:${address.toLowerCase()}`;
}

export interface AwsKmsIntentSignerConfig {
  readonly environment: string;
  readonly region: string;
  readonly keyId: string;
  readonly expectedSignerAddress: EvmAddress;
  readonly verifyingContract: EvmAddress;
  readonly client?: AwsKmsClientLike;
}

async function awsKmsOrderBackend(input: AwsKmsIntentSignerConfig): Promise<{
  readonly backend: OrderSigningBackend;
  readonly signerKeyId: string;
}> {
  const client = input.client ?? createAwsKmsClient({ region: input.region });
  const kms = await AwsKmsSecp256k1Signer.create({
    client,
    keyId: input.keyId,
    expectedAddress: input.expectedSignerAddress,
  });
  return {
    backend: {
      address: kms.address,
      signOrder(args) {
        return kms.signDigest(
          hashTypedData({
            domain: args.domain,
            types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
            primaryType: 'OrderIntent',
            message: args.message,
          }),
        );
      },
    },
    signerKeyId: kmsSignerReference(kms.address),
  };
}

async function awsKmsSplitBackend(input: AwsKmsIntentSignerConfig): Promise<{
  readonly backend: SplitSigningBackend;
  readonly signerKeyId: string;
}> {
  const client = input.client ?? createAwsKmsClient({ region: input.region });
  const kms = await AwsKmsSecp256k1Signer.create({
    client,
    keyId: input.keyId,
    expectedAddress: input.expectedSignerAddress,
  });
  return {
    backend: {
      address: kms.address,
      signSplit(args) {
        return kms.signDigest(
          hashTypedData({
            domain: args.domain,
            types: { SplitIntent: SPLIT_INTENT_EIP712_FIELDS },
            primaryType: 'SplitIntent',
            message: args.message,
          }),
        );
      },
    },
    signerKeyId: kmsSignerReference(kms.address),
  };
}

/** Production AWS KMS order-intent signer with startup public-key verification. */
export async function createAwsKmsOrderIntentSigner(input: AwsKmsIntentSignerConfig): Promise<{
  readonly order: ViemOrderIntentSigner;
  readonly orderSignerAddress: EvmAddress;
  readonly signerKeyId: string;
}> {
  const managed = await awsKmsOrderBackend(input);
  return {
    order: new ViemOrderIntentSigner(managed.backend, {
      environment: input.environment,
      signerKeyId: managed.signerKeyId,
      verifyingContract: input.verifyingContract,
      expectedSignerAddress: input.expectedSignerAddress,
    }),
    orderSignerAddress: managed.backend.address,
    signerKeyId: managed.signerKeyId,
  };
}

/** Production AWS KMS split-intent signer with startup public-key verification. */
export async function createAwsKmsSplitIntentSigner(input: AwsKmsIntentSignerConfig): Promise<{
  readonly split: ViemSplitIntentSigner;
  readonly splitSignerAddress: EvmAddress;
  readonly signerKeyId: string;
}> {
  const managed = await awsKmsSplitBackend(input);
  return {
    split: new ViemSplitIntentSigner(managed.backend, {
      environment: input.environment,
      signerKeyId: managed.signerKeyId,
      verifyingContract: input.verifyingContract,
      expectedSignerAddress: input.expectedSignerAddress,
    }),
    splitSignerAddress: managed.backend.address,
    signerKeyId: managed.signerKeyId,
  };
}

/** Production AWS KMS order/split roles; distinct signer addresses are mandatory. */
export async function createAwsKmsIntentSigners(input: {
  readonly environment: string;
  readonly region: string;
  readonly order: Omit<AwsKmsIntentSignerConfig, 'environment' | 'region' | 'client'>;
  readonly split: Omit<AwsKmsIntentSignerConfig, 'environment' | 'region' | 'client'>;
  readonly client?: AwsKmsClientLike;
}): Promise<{
  readonly order: ViemOrderIntentSigner;
  readonly split: ViemSplitIntentSigner;
  readonly orderSignerAddress: EvmAddress;
  readonly splitSignerAddress: EvmAddress;
  readonly orderSignerKeyId: string;
  readonly splitSignerKeyId: string;
}> {
  const client = input.client ?? createAwsKmsClient({ region: input.region });
  const [order, split] = await Promise.all([
    awsKmsOrderBackend({
      ...input.order,
      environment: input.environment,
      region: input.region,
      client,
    }),
    awsKmsSplitBackend({
      ...input.split,
      environment: input.environment,
      region: input.region,
      client,
    }),
  ]);
  const managed = createManagedIntentSigners({
    environment: input.environment,
    orderBackend: order.backend,
    splitBackend: split.backend,
    order: {
      signerKeyId: order.signerKeyId,
      verifyingContract: input.order.verifyingContract,
      expectedSignerAddress: input.order.expectedSignerAddress,
    },
    split: {
      signerKeyId: split.signerKeyId,
      verifyingContract: input.split.verifyingContract,
      expectedSignerAddress: input.split.expectedSignerAddress,
    },
  });
  return {
    ...managed,
    orderSignerAddress: order.backend.address,
    splitSignerAddress: split.backend.address,
    orderSignerKeyId: order.signerKeyId,
    splitSignerKeyId: split.signerKeyId,
  };
}

/** Local/demo-only order signer for deployments where split payments are disabled. */
export function createPrivateKeyOrderIntentSigner(input: {
  environment: string;
  orderPrivateKey: `0x${string}`;
  order: Omit<IntentSignerConfig, 'environment' | 'expectedSignerAddress'>;
}): { order: ViemOrderIntentSigner; orderSignerAddress: EvmAddress } {
  if (!['local', 'test'].includes(input.environment)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Private-key intent signing is restricted to local and test environments.',
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.orderPrivateKey)) {
    throw new AppError('CONFIGURATION_INVALID', 'Intent signer private key is invalid.');
  }
  const account = privateKeyToAccount(input.orderPrivateKey);
  const orderSignerAddress = EvmAddressSchema.parse(account.address);
  const backend: OrderSigningBackend = {
    address: orderSignerAddress,
    signOrder(args) {
      return account.signTypedData({
        domain: args.domain,
        types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
        primaryType: 'OrderIntent',
        message: args.message,
      });
    },
  };
  return {
    order: new ViemOrderIntentSigner(backend, {
      ...input.order,
      environment: input.environment,
      expectedSignerAddress: orderSignerAddress,
    }),
    orderSignerAddress,
  };
}

export function createPrivateKeyIntentSigners(input: {
  environment: string;
  orderPrivateKey: `0x${string}`;
  splitPrivateKey: `0x${string}`;
  order: Omit<IntentSignerConfig, 'environment' | 'expectedSignerAddress'>;
  split: Omit<IntentSignerConfig, 'environment' | 'expectedSignerAddress'>;
}): {
  order: ViemOrderIntentSigner;
  split: ViemSplitIntentSigner;
  orderSignerAddress: EvmAddress;
  splitSignerAddress: EvmAddress;
} {
  if (!['local', 'test'].includes(input.environment)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Private-key intent signing is restricted to local and test environments.',
    );
  }
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(input.orderPrivateKey) ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.splitPrivateKey)
  ) {
    throw new AppError('CONFIGURATION_INVALID', 'Intent signer private key is invalid.');
  }
  const orderAccount = privateKeyToAccount(input.orderPrivateKey);
  const splitAccount = privateKeyToAccount(input.splitPrivateKey);
  const orderSignerAddress = EvmAddressSchema.parse(orderAccount.address);
  const splitSignerAddress = EvmAddressSchema.parse(splitAccount.address);
  if (sameEvmAddress(orderSignerAddress, splitSignerAddress)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Order and split intents require separate signing roles.',
    );
  }
  const orderBackend: OrderSigningBackend = {
    address: orderSignerAddress,
    signOrder(args) {
      return orderAccount.signTypedData({
        domain: args.domain,
        types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
        primaryType: 'OrderIntent',
        message: args.message,
      });
    },
  };
  const splitBackend: SplitSigningBackend = {
    address: splitSignerAddress,
    signSplit(args) {
      return splitAccount.signTypedData({
        domain: args.domain,
        types: { SplitIntent: SPLIT_INTENT_EIP712_FIELDS },
        primaryType: 'SplitIntent',
        message: args.message,
      });
    },
  };
  return {
    order: new ViemOrderIntentSigner(orderBackend, {
      ...input.order,
      environment: input.environment,
      expectedSignerAddress: orderSignerAddress,
    }),
    split: new ViemSplitIntentSigner(splitBackend, {
      ...input.split,
      environment: input.environment,
      expectedSignerAddress: splitSignerAddress,
    }),
    orderSignerAddress,
    splitSignerAddress,
  };
}

/**
 * Explicit non-live fake for local/test/preview product demonstrations. Signing
 * material is derived internally and cannot be supplied through environment or
 * request input. It must never be represented as provider/onchain evidence.
 */
export function createDeterministicIntentSigners(input: {
  readonly environment: string;
  readonly providerMode: 'deterministic';
  readonly deterministicDemoEnabled: boolean;
  readonly orderVerifyingContract: EvmAddress;
  readonly splitVerifyingContract: EvmAddress;
}): {
  readonly order: ViemOrderIntentSigner;
  readonly split: ViemSplitIntentSigner;
  readonly orderSignerAddress: EvmAddress;
  readonly splitSignerAddress: EvmAddress;
  readonly orderSignerKeyId: 'deterministic-order-intent-v1';
  readonly splitSignerKeyId: 'deterministic-split-intent-v1';
} {
  if (
    !input.deterministicDemoEnabled ||
    input.providerMode !== 'deterministic' ||
    !['local', 'test', 'preview'].includes(input.environment)
  ) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Deterministic intent signing requires an explicit local/test/preview fake mode.',
    );
  }
  const orderSignerKeyId = 'deterministic-order-intent-v1' as const;
  const splitSignerKeyId = 'deterministic-split-intent-v1' as const;
  const orderAccount = privateKeyToAccount(
    keccak256(stringToHex('opentab/deterministic/order-intent/v1')),
  );
  const splitAccount = privateKeyToAccount(
    keccak256(stringToHex('opentab/deterministic/split-intent/v1')),
  );
  const orderSignerAddress = EvmAddressSchema.parse(orderAccount.address);
  const splitSignerAddress = EvmAddressSchema.parse(splitAccount.address);
  const managed = createManagedIntentSigners({
    environment: input.environment,
    orderBackend: {
      address: orderSignerAddress,
      signOrder(args) {
        return orderAccount.signTypedData({
          domain: args.domain,
          types: { OrderIntent: ORDER_INTENT_EIP712_FIELDS },
          primaryType: 'OrderIntent',
          message: args.message,
        });
      },
    },
    splitBackend: {
      address: splitSignerAddress,
      signSplit(args) {
        return splitAccount.signTypedData({
          domain: args.domain,
          types: { SplitIntent: SPLIT_INTENT_EIP712_FIELDS },
          primaryType: 'SplitIntent',
          message: args.message,
        });
      },
    },
    order: {
      signerKeyId: orderSignerKeyId,
      verifyingContract: input.orderVerifyingContract,
      expectedSignerAddress: orderSignerAddress,
    },
    split: {
      signerKeyId: splitSignerKeyId,
      verifyingContract: input.splitVerifyingContract,
      expectedSignerAddress: splitSignerAddress,
    },
  });
  return {
    ...managed,
    orderSignerAddress,
    splitSignerAddress,
    orderSignerKeyId,
    splitSignerKeyId,
  };
}
