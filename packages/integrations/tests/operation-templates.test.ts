import {
  ARBITRUM_ONE_CHAIN_ID,
  BoundOperationTemplateSchema,
  EvmAddressSchema,
} from '@opentab/shared';
import { Wallet } from 'ethers';
import { decodeFunctionData, getAddress, hashTypedData, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  openTabCheckoutOperationAbi,
  openTabSplitOperationAbi,
} from '../src/generated/operation-abis.js';
import {
  createMerchantProductOperationTemplate,
  createRefundOperationTemplate,
  createSplitReimbursementOperationTemplate,
  createSplitRevocationOperation,
  createWithdrawalOperationTemplate,
  MerchantProductOperationBindingSchema,
  RefundOperationBindingSchema,
  SplitReimbursementOperationBindingSchema,
  SplitRevocationOperationBindingSchema,
  validateMerchantProductOperationTemplate,
  validateRefundOperationTemplate,
  validateSplitReimbursementOperationTemplate,
  validateSplitRevocationOperation,
  validateWithdrawalOperationTemplate,
  WithdrawalOperationBindingSchema,
} from '../src/operation-templates.js';

const merchant = new Wallet(`0x${'11'.repeat(32)}`);
const splitSigner = new Wallet(`0x${'22'.repeat(32)}`);
const owner = EvmAddressSchema.parse(merchant.address);
const checkout = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const splitContract = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const token = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const beneficiary = EvmAddressSchema.parse(`0x${'5'.repeat(40)}`);
const other = EvmAddressSchema.parse(`0x${'6'.repeat(40)}`);
const expiry = '2099-07-14T12:05:00.000Z';
const bytes32 = (character: string) => `0x${character.repeat(64)}` as `0x${string}`;

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

function product() {
  return {
    unitPriceBaseUnits: '2500000',
    startsAt: '1784030400',
    endsAt: '1784116800',
    maxSupply: '100',
    maxPerWallet: '4',
    loyaltyPoints: '25',
    refundWindowSeconds: '3600',
    metadataHash: bytes32('a'),
    passUri: 'ipfs://opentab-product-metadata',
  } as const;
}

function refundBinding() {
  return RefundOperationBindingSchema.parse({
    ownerAddress: owner,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    checkoutAddress: checkout,
    refundId: 'rfd_01J00000000000000000000000',
    orderId: 'ord_01J00000000000000000000000',
    orderKey: bytes32('b'),
    merchantOnchainId: '7',
    productOnchainId: '8',
    tokenAddress: token,
    amountBaseUnits: '1500000',
    expiresAt: expiry,
  });
}

function withdrawalBinding() {
  return WithdrawalOperationBindingSchema.parse({
    ownerAddress: owner,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    checkoutAddress: checkout,
    withdrawalId: 'wdr_01J00000000000000000000000',
    merchantOnchainId: '7',
    payoutAddress: beneficiary,
    tokenAddress: token,
    amountBaseUnits: '900000',
    expiresAt: expiry,
  });
}

async function splitBinding() {
  const intent = {
    paymentKey: bytes32('c'),
    splitDigest: bytes32('d'),
    originalOrderKey: bytes32('e'),
    payer: owner,
    beneficiary,
    token,
    amountBaseUnits: '700000',
    validAfter: '1784030400',
    validUntil: '1784116800',
    metadataHash: bytes32('f'),
  } as const;
  const domain = {
    name: 'OpenTab Split Reimbursement',
    version: '1',
    chainId: Number(ARBITRUM_ONE_CHAIN_ID),
    verifyingContract: getAddress(splitContract),
  } as const;
  const message = {
    paymentKey: intent.paymentKey,
    splitDigest: intent.splitDigest,
    originalOrderKey: intent.originalOrderKey,
    payer: getAddress(intent.payer),
    beneficiary: getAddress(intent.beneficiary),
    token: getAddress(intent.token),
    amount: BigInt(intent.amountBaseUnits),
    validAfter: BigInt(intent.validAfter),
    validUntil: BigInt(intent.validUntil),
    metadataHash: intent.metadataHash,
  } as const;
  const signature = await splitSigner.signTypedData(
    domain,
    splitIntentTypes as unknown as Record<string, Array<{ name: string; type: string }>>,
    message,
  );
  return SplitReimbursementOperationBindingSchema.parse({
    invitationId: 'spi_01J00000000000000000000000',
    ownerAddress: owner,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    splitContractAddress: splitContract,
    tokenAddress: token,
    authorizedSignerAddress: splitSigner.address,
    intent,
    intentDigest: hashTypedData({
      domain,
      types: splitIntentTypes,
      primaryType: 'SplitIntent',
      message,
    }),
    signature,
    expiresAt: expiry,
  });
}

describe('bounded generated-ABI operation templates', () => {
  it('builds exact merchant and product mutations with no native value', () => {
    const mutations = [
      { action: 'create_merchant', payoutAddress: beneficiary, metadataHash: bytes32('1') },
      { action: 'update_merchant_payout', merchantOnchainId: '7', payoutAddress: beneficiary },
      { action: 'update_merchant_metadata', merchantOnchainId: '7', metadataHash: bytes32('2') },
      { action: 'set_merchant_active', merchantOnchainId: '7', active: false },
      { action: 'create_product', merchantOnchainId: '7', product: product() },
      {
        action: 'update_product',
        merchantOnchainId: '7',
        productOnchainId: '8',
        product: product(),
      },
      { action: 'set_product_active', merchantOnchainId: '7', productOnchainId: '8', active: true },
    ] as const;

    for (const mutation of mutations) {
      const binding = MerchantProductOperationBindingSchema.parse({
        ownerAddress: owner,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        checkoutAddress: checkout,
        mutation,
        expiresAt: expiry,
      });
      const template = createMerchantProductOperationTemplate(binding);
      const expectedKind = mutation.action.includes('merchant')
        ? 'merchant_mutation'
        : 'product_mutation';
      expect(template).toMatchObject({ kind: expectedKind, ownerAddress: owner });
      expect(template.calls).toHaveLength(1);
      expect(template.calls[0]).toMatchObject({ to: checkout, valueWei: '0' });
      const decoded = decodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        data: template.calls[0]?.data as `0x${string}`,
      });
      const expectedName = {
        create_merchant: 'createMerchant',
        update_merchant_payout: 'updateMerchantPayout',
        update_merchant_metadata: 'updateMerchantMetadata',
        set_merchant_active: 'setMerchantActive',
        create_product: 'createProduct',
        update_product: 'updateProduct',
        set_product_active: 'setProductActive',
      }[mutation.action];
      expect(decoded.functionName).toBe(expectedName);
      expect(validateMerchantProductOperationTemplate({ binding, template }).bindingDigest).toBe(
        template.bindingDigest,
      );
    }
  });

  it('preserves the contract zero sentinel for an open-ended product sale', () => {
    const binding = MerchantProductOperationBindingSchema.parse({
      ownerAddress: owner,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      checkoutAddress: checkout,
      mutation: {
        action: 'create_product',
        merchantOnchainId: '7',
        product: { ...product(), endsAt: '0' },
      },
      expiresAt: expiry,
    });
    const template = createMerchantProductOperationTemplate(binding);
    const decoded = decodeFunctionData({
      abi: openTabCheckoutOperationAbi,
      data: template.calls[0]?.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe('createProduct');
    expect(decoded.args?.[0]).toMatchObject({ endsAt: 0n });

    expect(() =>
      MerchantProductOperationBindingSchema.parse({
        ...binding,
        mutation: {
          action: 'create_product',
          merchantOnchainId: '7',
          product: { ...product(), endsAt: '1' },
        },
      }),
    ).toThrow();
    const bounded = product();
    expect(() =>
      MerchantProductOperationBindingSchema.parse({
        ...binding,
        mutation: {
          action: 'create_product',
          merchantOnchainId: '7',
          product: { ...bounded, endsAt: bounded.startsAt },
        },
      }),
    ).toThrow();
  });

  it('binds refund and withdrawal IDs, accounting fields, targets, and exact calldata', () => {
    const refund = refundBinding();
    const refundTemplate = createRefundOperationTemplate(refund);
    expect(
      decodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        data: refundTemplate.calls[0]?.data as `0x${string}`,
      }),
    ).toMatchObject({ functionName: 'refund', args: [refund.orderKey, 1_500_000n] });

    const withdrawal = withdrawalBinding();
    const withdrawalTemplate = createWithdrawalOperationTemplate(withdrawal);
    expect(
      decodeFunctionData({
        abi: openTabCheckoutOperationAbi,
        data: withdrawalTemplate.calls[0]?.data as `0x${string}`,
      }),
    ).toMatchObject({
      functionName: 'withdrawMerchant',
      args: [7n, 900_000n, withdrawal.payoutAddress],
    });
    expect(validateRefundOperationTemplate({ binding: refund, template: refundTemplate })).toEqual(
      refundTemplate,
    );
    expect(
      validateWithdrawalOperationTemplate({ binding: withdrawal, template: withdrawalTemplate }),
    ).toEqual(withdrawalTemplate);
  });

  it('verifies the split EIP-712 signer and creates only exact approve + reimburse calls', async () => {
    const binding = await splitBinding();
    const template = createSplitReimbursementOperationTemplate(binding);
    expect(template.calls).toHaveLength(2);
    expect(template.calls.every((call) => call.valueWei === '0')).toBe(true);
    expect(
      decodeFunctionData({
        abi: parseAbi(['function approve(address spender,uint256 amount) returns (bool)']),
        data: template.calls[0]?.data as `0x${string}`,
      }),
    ).toMatchObject({ functionName: 'approve', args: [splitContract, 700_000n] });
    expect(
      decodeFunctionData({
        abi: openTabSplitOperationAbi,
        data: template.calls[1]?.data as `0x${string}`,
      }),
    ).toMatchObject({ functionName: 'reimburse' });
    expect(validateSplitReimbursementOperationTemplate({ binding, template })).toEqual(template);
  });

  it('builds an exact managed-signer onchain revocation for an issued payment key', () => {
    const binding = SplitRevocationOperationBindingSchema.parse({
      invitationId: 'spi_01J00000000000000000000000',
      signerAddress: splitSigner.address,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      splitContractAddress: splitContract,
      paymentKey: bytes32('c'),
      splitDigest: bytes32('d'),
      expiresAt: expiry,
    });
    const operation = createSplitRevocationOperation(binding);
    expect(operation.call).toMatchObject({ to: splitContract, valueWei: '0' });
    expect(
      decodeFunctionData({
        abi: openTabSplitOperationAbi,
        data: operation.call.data as `0x${string}`,
      }),
    ).toMatchObject({
      functionName: 'revokePaymentKey',
      args: [binding.paymentKey, binding.splitDigest],
    });
    expect(validateSplitRevocationOperation({ binding, operation })).toEqual(operation);
    expect(() =>
      validateSplitRevocationOperation({
        binding,
        operation: { ...operation, call: { ...operation.call, to: other } },
      }),
    ).toThrow();
  });

  it('rejects call injection, target/calldata/value changes, and stale authoritative fields', async () => {
    const refund = refundBinding();
    const template = createRefundOperationTemplate(refund);
    const firstCall = template.calls[0];
    if (firstCall === undefined) throw new Error('Refund fixture call is missing');
    const alteredTemplates = [
      { ...template, chainId: '1' },
      { ...template, ownerAddress: other },
      { ...template, calls: [{ ...firstCall, to: other }] },
      { ...template, calls: [{ ...firstCall, data: '0x' }] },
      { ...template, calls: [{ ...firstCall, valueWei: '1' }] },
      {
        ...template,
        calls: [...template.calls, { to: other, data: '0x', valueWei: '0' }],
      },
    ];
    for (const altered of alteredTemplates) {
      await expect(async () =>
        validateRefundOperationTemplate({
          binding: refund,
          template: BoundOperationTemplateSchema.parse(altered),
        }),
      ).rejects.toThrow();
    }

    for (const changedBinding of [
      { ...refund, amountBaseUnits: '1500001' },
      { ...refund, orderKey: bytes32('9') },
      { ...refund, productOnchainId: '9' },
      { ...refund, tokenAddress: other },
    ]) {
      expect(() =>
        validateRefundOperationTemplate({
          binding: RefundOperationBindingSchema.parse(changedBinding),
          template,
        }),
      ).toThrow();
    }

    const split = await splitBinding();
    expect(() =>
      createSplitReimbursementOperationTemplate(
        SplitReimbursementOperationBindingSchema.parse({
          ...split,
          authorizedSignerAddress: other,
        }),
      ),
    ).toThrow();
  });
});
