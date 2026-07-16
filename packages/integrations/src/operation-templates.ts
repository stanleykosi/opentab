import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  type BoundOperationTemplate,
  BoundOperationTemplateSchema,
  Bytes32Schema,
  EvmAddressSchema,
  OperationCallSchema,
  OrderIdSchema,
  OrderKeySchema,
  RefundIdSchema,
  SplitInvitationIdSchema,
  Uint64StringSchema,
  UnsignedIntegerStringSchema,
  WithdrawalIdSchema,
} from '@opentab/shared';
import { recoverAddress } from 'ethers';
import {
  encodeFunctionData,
  getAddress,
  type Hex,
  hashTypedData,
  isAddressEqual,
  parseAbi,
} from 'viem';
import { z } from 'zod';
import { digestUnknown } from './evidence.js';
import {
  openTabCheckoutOperationAbi,
  openTabSplitOperationAbi,
} from './generated/operation-abis.js';

const UINT32_MAX = (1n << 32n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const ZERO_VALUE_WEI = BaseUnitAmountSchema.parse('0');

const NonZeroAddressSchema = EvmAddressSchema.refine(
  (value) => !isAddressEqual(getAddress(value), ZERO_ADDRESS),
  'Address must not be zero',
);
const NonZeroBytes32Schema = Bytes32Schema.refine(
  (value) => value.toLowerCase() !== ZERO_BYTES32,
  'Digest must not be zero',
);
const PositiveUint256Schema = UnsignedIntegerStringSchema.refine(
  (value) => BigInt(value) > 0n,
  'Value must be positive',
);
const Uint128StringSchema = UnsignedIntegerStringSchema.refine(
  (value) => BigInt(value) <= UINT128_MAX,
  'Value must fit uint128',
);
const PositiveUint128StringSchema = Uint128StringSchema.refine(
  (value) => BigInt(value) > 0n,
  'Value must be positive',
);
const Uint32StringSchema = UnsignedIntegerStringSchema.refine(
  (value) => BigInt(value) <= UINT32_MAX,
  'Value must fit uint32',
);
const OnchainIdSchema = PositiveUint256Schema;
const SignatureSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/);
const PassUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => value.startsWith('https://') || value.startsWith('ipfs://'));

const CommonBindingSchema = z
  .object({
    ownerAddress: NonZeroAddressSchema,
    chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
    checkoutAddress: NonZeroAddressSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

const ProductConfigurationSchema = z
  .object({
    unitPriceBaseUnits: PositiveUint128StringSchema,
    startsAt: Uint64StringSchema,
    endsAt: Uint64StringSchema,
    maxSupply: Uint64StringSchema,
    maxPerWallet: Uint64StringSchema,
    loyaltyPoints: Uint32StringSchema,
    refundWindowSeconds: Uint32StringSchema,
    metadataHash: NonZeroBytes32Schema,
    passUri: PassUriSchema,
  })
  .strict()
  .superRefine((value, context) => {
    // The contract uses zero as the explicit sentinel for an open-ended sale.
    if (BigInt(value.endsAt) !== 0n && BigInt(value.endsAt) <= BigInt(value.startsAt)) {
      context.addIssue({ code: 'custom', path: ['endsAt'], message: 'End must follow start' });
    }
    if (BigInt(value.maxSupply) !== 0n && BigInt(value.maxPerWallet) > BigInt(value.maxSupply)) {
      context.addIssue({
        code: 'custom',
        path: ['maxPerWallet'],
        message: 'Wallet limit exceeds supply',
      });
    }
  });

const MerchantProductMutationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create_merchant'),
      payoutAddress: NonZeroAddressSchema,
      metadataHash: NonZeroBytes32Schema,
    })
    .strict(),
  z
    .object({
      action: z.literal('update_merchant_payout'),
      merchantOnchainId: OnchainIdSchema,
      payoutAddress: NonZeroAddressSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('update_merchant_metadata'),
      merchantOnchainId: OnchainIdSchema,
      metadataHash: NonZeroBytes32Schema,
    })
    .strict(),
  z
    .object({
      action: z.literal('set_merchant_active'),
      merchantOnchainId: OnchainIdSchema,
      active: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('create_product'),
      merchantOnchainId: OnchainIdSchema,
      product: ProductConfigurationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('update_product'),
      merchantOnchainId: OnchainIdSchema,
      productOnchainId: OnchainIdSchema,
      product: ProductConfigurationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('set_product_active'),
      merchantOnchainId: OnchainIdSchema,
      productOnchainId: OnchainIdSchema,
      active: z.boolean(),
    })
    .strict(),
]);

export const MerchantProductOperationBindingSchema = CommonBindingSchema.extend({
  mutation: MerchantProductMutationSchema,
}).strict();

export const RefundOperationBindingSchema = CommonBindingSchema.extend({
  refundId: RefundIdSchema,
  orderId: OrderIdSchema,
  orderKey: OrderKeySchema,
  merchantOnchainId: OnchainIdSchema,
  productOnchainId: OnchainIdSchema,
  tokenAddress: NonZeroAddressSchema,
  amountBaseUnits: BaseUnitAmountSchema.refine((value) => BigInt(value) > 0n),
}).strict();

export const WithdrawalOperationBindingSchema = CommonBindingSchema.extend({
  withdrawalId: WithdrawalIdSchema,
  merchantOnchainId: OnchainIdSchema,
  payoutAddress: NonZeroAddressSchema,
  tokenAddress: NonZeroAddressSchema,
  amountBaseUnits: BaseUnitAmountSchema.refine((value) => BigInt(value) > 0n),
}).strict();

const SplitIntentSchema = z
  .object({
    paymentKey: NonZeroBytes32Schema,
    splitDigest: NonZeroBytes32Schema,
    originalOrderKey: OrderKeySchema.refine((value) => value.toLowerCase() !== ZERO_BYTES32),
    payer: NonZeroAddressSchema,
    beneficiary: NonZeroAddressSchema,
    token: NonZeroAddressSchema,
    amountBaseUnits: BaseUnitAmountSchema.refine((value) => BigInt(value) > 0n),
    validAfter: Uint64StringSchema,
    validUntil: Uint64StringSchema.refine((value) => BigInt(value) > 0n),
    metadataHash: NonZeroBytes32Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const duration = BigInt(value.validUntil) - BigInt(value.validAfter);
    if (duration < 0n || duration > 86_400n) {
      context.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Split validity must be ordered and at most one day',
      });
    }
  });

export const SplitReimbursementOperationBindingSchema = z
  .object({
    invitationId: SplitInvitationIdSchema,
    ownerAddress: NonZeroAddressSchema,
    chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
    splitContractAddress: NonZeroAddressSchema,
    tokenAddress: NonZeroAddressSchema,
    authorizedSignerAddress: NonZeroAddressSchema,
    intent: SplitIntentSchema,
    intentDigest: NonZeroBytes32Schema,
    signature: SignatureSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const SplitRevocationOperationBindingSchema = z
  .object({
    invitationId: SplitInvitationIdSchema,
    signerAddress: NonZeroAddressSchema,
    chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
    splitContractAddress: NonZeroAddressSchema,
    paymentKey: NonZeroBytes32Schema,
    splitDigest: NonZeroBytes32Schema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const ManagedContractOperationSchema = z
  .object({
    kind: z.literal('split_revocation'),
    signerAddress: NonZeroAddressSchema,
    chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
    call: OperationCallSchema,
    bindingDigest: NonZeroBytes32Schema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export type MerchantProductOperationBinding = z.infer<typeof MerchantProductOperationBindingSchema>;
export type RefundOperationBinding = z.infer<typeof RefundOperationBindingSchema>;
export type WithdrawalOperationBinding = z.infer<typeof WithdrawalOperationBindingSchema>;
export type SplitReimbursementOperationBinding = z.infer<
  typeof SplitReimbursementOperationBindingSchema
>;
export type SplitRevocationOperationBinding = z.infer<typeof SplitRevocationOperationBindingSchema>;
export type ManagedContractOperation = z.infer<typeof ManagedContractOperationSchema>;

const erc20ApproveAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const splitIntentTypes = {
  SplitIntent: [
    { name: 'paymentKey', type: 'bytes32' },
    { name: 'splitDigest', type: 'bytes32' },
    { name: 'originalOrderKey', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'beneficiary', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
} as const;

function operationTemplate(input: {
  kind: BoundOperationTemplate['kind'];
  ownerAddress: string;
  calls: BoundOperationTemplate['calls'];
  expiresAt: string;
  binding: unknown;
}): BoundOperationTemplate {
  if (input.calls.length > 3 || input.calls.some((call) => call.valueWei !== '0')) {
    throw new AppError('OPERATION_PLAN_INVALID', 'Operation calls violate the hard call policy.');
  }
  return BoundOperationTemplateSchema.parse({
    kind: input.kind,
    ownerAddress: input.ownerAddress,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    calls: input.calls,
    bindingDigest: digestUnknown({
      schema: `opentab-${input.kind}-operation-binding-v1`,
      binding: input.binding,
    }),
    expiresAt: input.expiresAt,
  });
}

function productTuple(product: z.infer<typeof ProductConfigurationSchema>) {
  return {
    unitPrice: BigInt(product.unitPriceBaseUnits),
    startsAt: BigInt(product.startsAt),
    endsAt: BigInt(product.endsAt),
    maxSupply: BigInt(product.maxSupply),
    maxPerWallet: BigInt(product.maxPerWallet),
    loyaltyPoints: Number(product.loyaltyPoints),
    refundWindow: Number(product.refundWindowSeconds),
    metadataHash: product.metadataHash as Hex,
    passUri: product.passUri,
  };
}

export function createMerchantProductOperationTemplate(
  input: MerchantProductOperationBinding,
): BoundOperationTemplate {
  const binding = MerchantProductOperationBindingSchema.parse(input);
  const mutation = binding.mutation;
  let data: Hex;
  switch (mutation.action) {
    case 'create_merchant':
      data = encodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        functionName: 'createMerchant',
        args: [getAddress(mutation.payoutAddress), mutation.metadataHash as Hex],
      });
      break;
    case 'update_merchant_payout':
      data = encodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        functionName: 'updateMerchantPayout',
        args: [BigInt(mutation.merchantOnchainId), getAddress(mutation.payoutAddress)],
      });
      break;
    case 'update_merchant_metadata':
      data = encodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        functionName: 'updateMerchantMetadata',
        args: [BigInt(mutation.merchantOnchainId), mutation.metadataHash as Hex],
      });
      break;
    case 'set_merchant_active':
      data = encodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        functionName: 'setMerchantActive',
        args: [BigInt(mutation.merchantOnchainId), mutation.active],
      });
      break;
    case 'create_product':
      data = encodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        functionName: 'createProduct',
        args: [
          {
            merchantId: BigInt(mutation.merchantOnchainId),
            ...productTuple(mutation.product),
          },
        ],
      });
      break;
    case 'update_product':
      data = encodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        functionName: 'updateProduct',
        args: [BigInt(mutation.productOnchainId), productTuple(mutation.product)],
      });
      break;
    case 'set_product_active':
      data = encodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        functionName: 'setProductActive',
        args: [BigInt(mutation.productOnchainId), mutation.active],
      });
      break;
  }
  return operationTemplate({
    kind: 'product_mutation',
    ownerAddress: binding.ownerAddress,
    calls: [{ to: binding.checkoutAddress, data, valueWei: ZERO_VALUE_WEI }],
    expiresAt: binding.expiresAt,
    binding,
  });
}

export function createRefundOperationTemplate(
  input: RefundOperationBinding,
): BoundOperationTemplate {
  const binding = RefundOperationBindingSchema.parse(input);
  const data = encodeFunctionData({
    abi: openTabCheckoutOperationAbi,
    functionName: 'refund',
    args: [binding.orderKey as Hex, BigInt(binding.amountBaseUnits)],
  });
  return operationTemplate({
    kind: 'refund',
    ownerAddress: binding.ownerAddress,
    calls: [{ to: binding.checkoutAddress, data, valueWei: ZERO_VALUE_WEI }],
    expiresAt: binding.expiresAt,
    binding,
  });
}

export function createWithdrawalOperationTemplate(
  input: WithdrawalOperationBinding,
): BoundOperationTemplate {
  const binding = WithdrawalOperationBindingSchema.parse(input);
  const data = encodeFunctionData({
    abi: openTabCheckoutOperationAbi,
    functionName: 'withdrawMerchant',
    args: [
      BigInt(binding.merchantOnchainId),
      BigInt(binding.amountBaseUnits),
      getAddress(binding.payoutAddress),
    ],
  });
  return operationTemplate({
    kind: 'withdrawal',
    ownerAddress: binding.ownerAddress,
    calls: [{ to: binding.checkoutAddress, data, valueWei: ZERO_VALUE_WEI }],
    expiresAt: binding.expiresAt,
    binding,
  });
}

export function createSplitReimbursementOperationTemplate(
  input: SplitReimbursementOperationBinding,
): BoundOperationTemplate {
  const binding = SplitReimbursementOperationBindingSchema.parse(input);
  if (
    !isAddressEqual(getAddress(binding.ownerAddress), getAddress(binding.intent.payer)) ||
    !isAddressEqual(getAddress(binding.tokenAddress), getAddress(binding.intent.token))
  ) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'Split owner or token does not match the signed intent.',
    );
  }
  const message = {
    paymentKey: binding.intent.paymentKey as Hex,
    splitDigest: binding.intent.splitDigest as Hex,
    originalOrderKey: binding.intent.originalOrderKey as Hex,
    payer: getAddress(binding.intent.payer),
    beneficiary: getAddress(binding.intent.beneficiary),
    token: getAddress(binding.intent.token),
    amount: BigInt(binding.intent.amountBaseUnits),
    validAfter: BigInt(binding.intent.validAfter),
    validUntil: BigInt(binding.intent.validUntil),
    metadataHash: binding.intent.metadataHash as Hex,
  } as const;
  const calculatedDigest = hashTypedData({
    domain: {
      name: 'OpenTab Split Reimbursement',
      version: '1',
      chainId: Number(ARBITRUM_ONE_CHAIN_ID),
      verifyingContract: getAddress(binding.splitContractAddress),
    },
    types: splitIntentTypes,
    primaryType: 'SplitIntent',
    message,
  });
  let recovered: string;
  try {
    recovered = recoverAddress(calculatedDigest, binding.signature);
  } catch (error) {
    throw new AppError('OPERATION_PLAN_INVALID', 'Split signature is malformed.', {
      cause: error,
    });
  }
  if (
    calculatedDigest.toLowerCase() !== binding.intentDigest.toLowerCase() ||
    !isAddressEqual(getAddress(recovered), getAddress(binding.authorizedSignerAddress))
  ) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'Split digest or authorized signer does not match the binding.',
    );
  }
  const approval = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [getAddress(binding.splitContractAddress), BigInt(binding.intent.amountBaseUnits)],
  });
  const reimbursement = encodeFunctionData({
    abi: openTabSplitOperationAbi,
    functionName: 'reimburse',
    args: [message, binding.signature as Hex],
  });
  return operationTemplate({
    kind: 'split_reimbursement',
    ownerAddress: binding.ownerAddress,
    calls: [
      { to: binding.tokenAddress, data: approval, valueWei: ZERO_VALUE_WEI },
      {
        to: binding.splitContractAddress,
        data: reimbursement,
        valueWei: ZERO_VALUE_WEI,
      },
    ],
    expiresAt: binding.expiresAt,
    binding,
  });
}

export function createSplitRevocationOperation(
  input: SplitRevocationOperationBinding,
): ManagedContractOperation {
  const binding = SplitRevocationOperationBindingSchema.parse(input);
  const data = encodeFunctionData({
    abi: openTabSplitOperationAbi,
    functionName: 'revokePaymentKey',
    args: [binding.paymentKey as Hex, binding.splitDigest as Hex],
  });
  return ManagedContractOperationSchema.parse({
    kind: 'split_revocation',
    signerAddress: binding.signerAddress,
    chainId: binding.chainId,
    call: {
      to: binding.splitContractAddress,
      data,
      valueWei: ZERO_VALUE_WEI,
    },
    bindingDigest: digestUnknown({
      schema: 'opentab-split-revocation-operation-binding-v1',
      binding,
    }),
    expiresAt: binding.expiresAt,
  });
}

function assertExactTemplate(
  suppliedInput: BoundOperationTemplate,
  expected: BoundOperationTemplate,
): BoundOperationTemplate {
  const supplied = BoundOperationTemplateSchema.parse(suppliedInput);
  if (digestUnknown(supplied) !== digestUnknown(expected)) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'The operation template differs from its authoritative binding.',
    );
  }
  return supplied;
}

export function validateMerchantProductOperationTemplate(input: {
  binding: MerchantProductOperationBinding;
  template: BoundOperationTemplate;
}): BoundOperationTemplate {
  return assertExactTemplate(input.template, createMerchantProductOperationTemplate(input.binding));
}

export function validateRefundOperationTemplate(input: {
  binding: RefundOperationBinding;
  template: BoundOperationTemplate;
}): BoundOperationTemplate {
  return assertExactTemplate(input.template, createRefundOperationTemplate(input.binding));
}

export function validateWithdrawalOperationTemplate(input: {
  binding: WithdrawalOperationBinding;
  template: BoundOperationTemplate;
}): BoundOperationTemplate {
  return assertExactTemplate(input.template, createWithdrawalOperationTemplate(input.binding));
}

export function validateSplitReimbursementOperationTemplate(input: {
  binding: SplitReimbursementOperationBinding;
  template: BoundOperationTemplate;
}): BoundOperationTemplate {
  return assertExactTemplate(
    input.template,
    createSplitReimbursementOperationTemplate(input.binding),
  );
}

export function validateSplitRevocationOperation(input: {
  binding: SplitRevocationOperationBinding;
  operation: ManagedContractOperation;
}): ManagedContractOperation {
  const supplied = ManagedContractOperationSchema.parse(input.operation);
  const expected = createSplitRevocationOperation(input.binding);
  if (digestUnknown(supplied) !== digestUnknown(expected)) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'The split revocation operation differs from its authoritative binding.',
    );
  }
  return supplied;
}
