import { describe, expect, it } from 'vitest';
import {
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  BoundOperationTemplateSchema,
  EvmAddressSchema,
  LiveAcceptanceActivationPathSchema,
  ORDER_INTENT_EIP712_FIELDS,
  OrderIntentSchema,
  PaymentAttemptStatusSchema,
  PublicJudgeProofSchema,
  SPLIT_INTENT_EIP712_FIELDS,
  SplitInvitationStatusSchema,
  SplitReimbursementIntentSchema,
  toOrderIntentEip712Message,
  validateSplitAllocation,
} from '../src/index.js';

const owner = EvmAddressSchema.parse('0x1111111111111111111111111111111111111111');
const digest = `0x${'ab'.repeat(32)}`;

describe('security boundary schemas', () => {
  it('distinguishes explicit Type-4 activation from provider-atomic activation', () => {
    expect(LiveAcceptanceActivationPathSchema.options).toEqual([
      'already_delegated',
      'provider_atomic',
      'self_funded_type4',
      'bootstrap_sponsor',
    ]);
    expect(LiveAcceptanceActivationPathSchema.parse('self_funded_type4')).toBe('self_funded_type4');
    expect(LiveAcceptanceActivationPathSchema.safeParse('provider_or_self_funded').success).toBe(
      false,
    );
  });

  it('preserves submitted-unknown as a first-class durable state', () => {
    expect(PaymentAttemptStatusSchema.parse('submitted_unknown')).toBe('submitted_unknown');
    expect(SplitInvitationStatusSchema.parse('submitted_unknown')).toBe('submitted_unknown');
  });

  it('bounds operation calls and rejects arbitrary extra fields', () => {
    const result = BoundOperationTemplateSchema.safeParse({
      kind: 'checkout',
      ownerAddress: owner,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      calls: Array.from({ length: 4 }, () => ({ to: owner, data: '0x', valueWei: '0' })),
      bindingDigest: digest,
      expiresAt: '2026-07-10T23:59:59.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('requires exact positive split allocation', () => {
    const values = ['4000000', '6000000'].map((value) => BaseUnitAmountSchema.parse(value));
    expect(validateSplitAllocation(values, BaseUnitAmountSchema.parse('10000000'))).toBe(true);
    expect(validateSplitAllocation(values, BaseUnitAmountSchema.parse('9999999'))).toBe(false);
  });

  it('uses an allowlisted Judge proof instead of accepting internal records', () => {
    const parsed = PublicJudgeProofSchema.safeParse({ email: 'must-not-appear@example.invalid' });
    expect(parsed.success).toBe(false);
  });

  it('binds the complete size-bounded checkout intent and immutable fee cap', () => {
    const intent = {
      orderKey: digest,
      payer: owner,
      recipient: owner,
      merchantOnchainId: '1',
      productOnchainId: '2',
      productVersion: '3',
      token: owner,
      amountBaseUnits: '1000000',
      platformFeeBps: '500',
      platformFeeBaseUnits: '50000',
      quantity: '1',
      validAfter: '1',
      validUntil: '2',
      refundDeadline: '3',
      metadataHash: digest,
    };
    const parsed = OrderIntentSchema.parse(intent);
    expect(parsed.productVersion).toBe('3');
    expect(toOrderIntentEip712Message(parsed).platformFee).toBe(50_000n);
    expect(ORDER_INTENT_EIP712_FIELDS.at(-1)).toEqual({
      name: 'metadataHash',
      type: 'bytes32',
    });
    expect(OrderIntentSchema.safeParse({ ...intent, platformFeeBps: '501' }).success).toBe(false);
    expect(
      OrderIntentSchema.safeParse({ ...intent, quantity: '18446744073709551616' }).success,
    ).toBe(false);
  });

  it('binds split reimbursement to the original order and exact signed interval', () => {
    expect(
      SplitReimbursementIntentSchema.safeParse({
        paymentKey: digest,
        splitDigest: digest,
        originalOrderKey: digest,
        payer: owner,
        beneficiary: owner,
        token: owner,
        amountBaseUnits: '1',
        validAfter: '1',
        validUntil: '2',
        metadataHash: digest,
      }).success,
    ).toBe(true);
    expect(SPLIT_INTENT_EIP712_FIELDS).toHaveLength(10);
  });
});
