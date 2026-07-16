import { describe, expect, it } from 'vitest';
import {
  evaluateRefundProjection,
  expectedFinalizationCredits,
  findOrderPaidMismatches,
  findSplitReimbursementMismatches,
  parseCanonicalEventProof,
  planWithdrawalDebits,
  type StoredDecodedEvent,
  type StoredEventPosition,
  selectOperationForCanonicalTransaction,
} from '../src/projectors.js';

const address = (digit: string) => `0x${digit.repeat(40)}`;
const bytes32 = (digit: string) => `0x${digit.repeat(64)}`;
const position: StoredEventPosition = {
  chainId: '42161',
  contractAddress: address('1'),
  transactionHash: bytes32('2'),
  blockNumber: 100n,
  blockHash: bytes32('3'),
  logIndex: 4,
  confirmations: 3n,
  observedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function orderPaidEvent(overrides: Readonly<Record<string, string>> = {}): StoredDecodedEvent {
  return {
    eventName: 'OrderPaid',
    decoderVersion: 'test-v3',
    fields: {
      orderKey: bytes32('4'),
      merchantId: '1',
      productId: '2',
      payer: address('5'),
      recipient: address('6'),
      token: address('7'),
      quantity: '2',
      amount: '1000',
      platformFee: '50',
      passTokenId: '2',
      refundDeadline: '1800000000',
      intentDigest: bytes32('8'),
      ...overrides,
    },
  };
}

describe('canonical projector validation', () => {
  it('parses a versioned canonical proof and rejects missing critical fields', () => {
    const proof = parseCanonicalEventProof(orderPaidEvent(), position);
    expect(proof?.eventName).toBe('OrderPaid');
    expect(proof?.canonical).toBe(true);

    const missingToken = orderPaidEvent();
    const { token: _token, ...fields } = missingToken.fields;
    expect(parseCanonicalEventProof({ ...missingToken, fields }, position)).toBeUndefined();
  });

  it('binds every OrderPaid financial and identity field while normalizing addresses', () => {
    const proof = parseCanonicalEventProof(orderPaidEvent(), position);
    if (proof?.eventName !== 'OrderPaid') throw new Error('Expected OrderPaid proof');
    const expected = {
      merchantOnchainId: '1',
      productOnchainId: '2',
      payer: address('5').toUpperCase().replace('0X', '0x'),
      recipient: address('6'),
      token: address('7'),
      quantity: '2',
      amountBaseUnits: '1000',
      platformFeeBaseUnits: '50',
      intentDigest: bytes32('8'),
      refundDeadline: '1800000000',
    };
    expect(findOrderPaidMismatches(expected, proof)).toEqual([]);
    expect(
      findOrderPaidMismatches(
        { ...expected, amountBaseUnits: '999', platformFeeBaseUnits: undefined },
        proof,
      ),
    ).toEqual(['amount', 'platformFee']);
  });

  it('enforces cumulative floor-rounded refund accounting', () => {
    expect(
      evaluateRefundProjection({
        paidAmountBaseUnits: '1000',
        previouslyRefundedBaseUnits: '200',
        refundAmountBaseUnits: '333',
        cumulativeRefundedBaseUnits: '533',
        signedPlatformFeeBaseUnits: '51',
        platformFeeRefundedBaseUnits: '17',
        merchantCreditBaseUnits: '759',
      }),
    ).toEqual({
      kind: 'apply',
      merchantRefundBaseUnits: '316',
      remainingMerchantCreditBaseUnits: '443',
    });
    expect(
      evaluateRefundProjection({
        paidAmountBaseUnits: '1000',
        previouslyRefundedBaseUnits: '200',
        refundAmountBaseUnits: '333',
        cumulativeRefundedBaseUnits: '534',
        signedPlatformFeeBaseUnits: '51',
        platformFeeRefundedBaseUnits: '16',
        merchantCreditBaseUnits: '759',
      }),
    ).toMatchObject({ kind: 'mismatch' });
  });

  it('derives exact merchant/platform finalization credit after partial refunds', () => {
    expect(
      expectedFinalizationCredits({
        paidAmountBaseUnits: '1000',
        refundedAmountBaseUnits: '333',
        signedPlatformFeeBaseUnits: '51',
      }),
    ).toEqual({ merchantBaseUnits: '632', platformBaseUnits: '35' });
  });

  it('preflights withdrawal capacity before returning FIFO debits', () => {
    const credits = [
      { id: 'first', amountBaseUnits: '100', withdrawnBaseUnits: '25' },
      { id: 'second', amountBaseUnits: '200', withdrawnBaseUnits: '0' },
    ];
    expect(planWithdrawalDebits(credits, '250')).toEqual([
      {
        creditId: 'first',
        debitBaseUnits: '75',
        withdrawnBaseUnits: '100',
        fullyWithdrawn: true,
      },
      {
        creditId: 'second',
        debitBaseUnits: '175',
        withdrawnBaseUnits: '175',
        fullyWithdrawn: false,
      },
    ]);
    expect(planWithdrawalDebits(credits, '276')).toBeUndefined();
  });

  it('requires stored split binding evidence to match every emitted field', () => {
    const proof = parseCanonicalEventProof(
      {
        eventName: 'SplitReimbursed',
        decoderVersion: 'test-v3',
        fields: {
          paymentKey: bytes32('1'),
          splitDigest: bytes32('2'),
          originalOrderKey: bytes32('3'),
          payer: address('4'),
          beneficiary: address('5'),
          token: address('6'),
          amount: '100',
          intentDigest: bytes32('7'),
        },
      },
      position,
    );
    if (proof?.eventName !== 'SplitReimbursed') {
      throw new Error('Expected SplitReimbursed proof');
    }
    const expected = {
      paymentKey: bytes32('1'),
      splitDigest: bytes32('2'),
      originalOrderKey: bytes32('3'),
      orderKey: bytes32('3'),
      payer: address('4'),
      beneficiary: address('5'),
      token: address('6'),
      amountBaseUnits: '100',
      intentDigest: bytes32('7'),
    };
    expect(findSplitReimbursementMismatches(expected, proof)).toEqual([]);
    expect(
      findSplitReimbursementMismatches({ ...expected, originalOrderKey: null, token: null }, proof),
    ).toEqual(['storedOriginalOrderKey', 'token']);
  });

  it('updates exactly one transaction-bound workflow and quarantines unbound ambiguity', () => {
    const exactHash = bytes32('8');
    const concurrent = [
      { id: 'refund-a', transactionHash: null },
      { id: 'refund-b', transactionHash: exactHash },
      { id: 'refund-c', transactionHash: bytes32('9') },
    ];
    expect(selectOperationForCanonicalTransaction(concurrent, exactHash)?.id).toBe('refund-b');
    expect(
      selectOperationForCanonicalTransaction(
        [
          { id: 'withdrawal-a', transactionHash: null },
          { id: 'withdrawal-b', transactionHash: null },
        ],
        exactHash,
      ),
    ).toBeUndefined();
    expect(
      selectOperationForCanonicalTransaction(
        [{ id: 'single-prepared', transactionHash: null }],
        exactHash,
      )?.id,
    ).toBe('single-prepared');
  });
});
