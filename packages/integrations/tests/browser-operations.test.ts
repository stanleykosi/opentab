import { ARBITRUM_ONE_CHAIN_ID, EvmAddressSchema } from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { validateBrowserContractOperation } from '../src/browser-operations.js';
import {
  createMerchantProductOperationTemplate,
  createRefundOperationTemplate,
  MerchantProductOperationBindingSchema,
  RefundOperationBindingSchema,
} from '../src/operation-templates.js';

const owner = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const checkout = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const token = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');

describe('browser contract-operation boundary', () => {
  it('re-derives a supported exact template and rejects managed revocation kinds', () => {
    const binding = RefundOperationBindingSchema.parse({
      ownerAddress: owner,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      checkoutAddress: checkout,
      refundId: 'rfd_01J00000000000000000000000',
      orderId: 'ord_01J00000000000000000000000',
      orderKey: `0x${'b'.repeat(64)}`,
      merchantOnchainId: '7',
      productOnchainId: '8',
      tokenAddress: token,
      amountBaseUnits: '1500000',
      expiresAt: '2099-07-14T12:05:00.000Z',
    });
    const template = createRefundOperationTemplate(binding);
    expect(validateBrowserContractOperation({ kind: 'refund', binding, template })).toEqual(
      template,
    );
    expect(() =>
      validateBrowserContractOperation({
        kind: 'split_revocation',
        binding,
        template,
      } as never),
    ).toThrow();
  });

  it('accepts the explicit merchant-mutation record kind without discriminator translation', () => {
    const binding = MerchantProductOperationBindingSchema.parse({
      ownerAddress: owner,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      checkoutAddress: checkout,
      mutation: {
        action: 'create_merchant',
        payoutAddress: owner,
        metadataHash: `0x${'c'.repeat(64)}`,
      },
      expiresAt: '2099-07-14T12:05:00.000Z',
    });
    const template = createMerchantProductOperationTemplate(binding);
    expect(
      validateBrowserContractOperation({ kind: 'merchant_mutation', binding, template }),
    ).toEqual(template);
  });
});
