import { describe, expect, it } from 'vitest';
import {
  recordedPublicJudgeProof,
  unrecordedRoutePublicJudgeProof,
} from '../components/judge/public-judge-proof.test-fixture';
import {
  CheckoutSnapshotResponseSchema,
  PaymentWorkflowResponseSchema,
  PublicProductRecordSchema,
} from './browser-api-client';
import {
  mapCheckoutResponseToView,
  mapPublicJudgeProofToView,
  mapPublicProductToView,
} from './live-view-mappers';

const record = PublicProductRecordSchema.parse({
  merchant: {
    id: 'mer_00000000000000000000000000',
    ownerUserId: 'usr_00000000000000000000000000',
    slug: 'daylight-room',
    displayName: 'Daylight Room',
    supportContact: 'hello@daylight.example',
    payoutAddress: '0x1111111111111111111111111111111111111111',
    status: 'active',
    createdAt: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-10T10:00:00.000Z',
  },
  product: {
    id: 'prd_00000000000000000000000000',
    merchantId: 'mer_00000000000000000000000000',
    onchainProductId: '7',
    version: '1',
    slug: 'sunday-table',
    title: 'Sunday Table',
    description: 'A long table gathering.',
    imageUrl: 'https://merchant.example/private-image.png',
    unitPriceBaseUnits: '18000000',
    maxSupply: '24',
    sold: '2',
    maxPerOrder: '4',
    startsAt: '2026-08-02T11:00:00.000Z',
    refundWindowSeconds: '172800',
    loyaltyPoints: '180',
    metadataHash: `0x${'1'.repeat(64)}`,
    status: 'active',
    createdAt: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-10T10:00:00.000Z',
  },
  availabilityObservedAt: '2026-07-14T01:00:00.000Z',
  projectionStale: false,
  requestId: 'req_product_test',
});

describe('live product view mapping', () => {
  it('preserves exact base units and computes inventory with bigint', () => {
    const view = mapPublicProductToView(record, { origin: 'https://opentab.example' });
    expect(view.unitPriceBaseUnits).toBe('18000000');
    expect(view.availability).toEqual({ state: 'available', remaining: '22' });
    expect(view.refundTerms).toContain('2 days');
    expect(view.merchant.supportContact).toBe('hello@daylight.example');
    expect(view.category).toBeUndefined();
    expect(view.location).toBeUndefined();
  });

  it('does not invent merchant support details when none were supplied', () => {
    const withoutSupport = PublicProductRecordSchema.parse({
      ...record,
      merchant: { ...record.merchant, supportContact: undefined },
    });

    expect(
      mapPublicProductToView(withoutSupport, { origin: 'https://opentab.example' }).merchant
        .supportContact,
    ).toBeUndefined();
  });

  it('does not proxy an unapproved remote image URL', () => {
    expect(mapPublicProductToView(record, { origin: 'https://opentab.example' }).imagePath).toBe(
      '/images/offer-fallback.svg',
    );
  });

  it('preserves an exact backend-approved media origin without proxying it', () => {
    expect(
      mapPublicProductToView(record, {
        origin: 'https://opentab.example',
        allowedMediaOrigins: ['https://opentab.example', 'https://merchant.example'],
      }).imagePath,
    ).toBe('https://merchant.example/private-image.png');
  });

  it('never maps provider/order success to confirmed before canonical finality', () => {
    const checkoutSessionId = 'chk_00000000000000000000000000';
    const orderId = 'ord_00000000000000000000000000';
    const paymentAttemptId = 'pay_00000000000000000000000000';
    const orderKey = `0x${'2'.repeat(64)}`;
    const checkout = CheckoutSnapshotResponseSchema.parse({
      session: {
        id: checkoutSessionId,
        userId: record.merchant.ownerUserId,
        productId: record.product.id,
        productVersion: '1',
        quantity: '1',
        receiptRecipient: record.merchant.payoutAddress,
        amountBaseUnits: '18000000',
        orderKey,
        status: 'consumed',
        expiresAt: '2027-07-14T02:00:00.000Z',
        bindingDigest: orderKey,
        createdAt: '2026-07-14T01:00:00.000Z',
        updatedAt: '2026-07-14T01:04:00.000Z',
      },
      order: {
        id: orderId,
        checkoutSessionId,
        orderKey,
        userId: record.merchant.ownerUserId,
        merchantId: record.merchant.id,
        productId: record.product.id,
        payer: record.merchant.payoutAddress,
        recipient: record.merchant.payoutAddress,
        quantity: '1',
        amountBaseUnits: '18000000',
        paidAmountBaseUnits: '18000000',
        refundedAmountBaseUnits: '0',
        status: 'paid',
        providerOperationId: 'particle-live-operation',
        transactionHash: orderKey,
        confirmedAt: '2026-07-14T01:04:00.000Z',
        refundableUntil: '2026-07-15T01:04:00.000Z',
        createdAt: '2026-07-14T01:00:00.000Z',
        updatedAt: '2026-07-14T01:04:00.000Z',
      },
      attempt: {
        id: paymentAttemptId,
        orderId,
        checkoutSessionId,
        attemptNumber: '1',
        status: 'paid',
        bindingDigest: orderKey,
        providerOperationId: 'particle-live-operation',
        destinationTransactionHash: orderKey,
        reconciliationRequired: false,
        createdAt: '2026-07-14T01:00:00.000Z',
        updatedAt: '2026-07-14T01:04:00.000Z',
      },
      product: record.product,
      merchant: record.merchant,
      requestId: 'req_checkout_mapper_test',
    });
    if (checkout.attempt === undefined || checkout.order === undefined) {
      throw new Error('The checkout fixture is incomplete.');
    }
    const workflowBase = {
      attempt: checkout.attempt,
      order: checkout.order,
      requestId: 'req_workflow_mapper_test',
    };
    const shallowProof = PaymentWorkflowResponseSchema.parse({
      ...workflowBase,
      canonicalOrderPaid: {
        eventName: 'OrderPaid',
        canonical: true,
        transactionHash: orderKey,
        blockNumber: '351204118',
        blockHash: `0x${'3'.repeat(64)}`,
        logIndex: '1',
        confirmations: '1',
        requiredConfirmations: '2',
        observedAt: '2026-07-14T01:04:00.000Z',
      },
    });
    const waiting = mapCheckoutResponseToView(checkout, {
      origin: 'https://opentab.example',
      workflow: shallowProof,
    });
    expect(waiting.state).toBe('waiting_for_arbitrum');
    expect(waiting.canonicalConfirmation).toBeUndefined();

    const finalProof = PaymentWorkflowResponseSchema.parse({
      ...workflowBase,
      canonicalOrderPaid: {
        ...shallowProof.canonicalOrderPaid,
        confirmations: '2',
      },
    });
    const confirmed = mapCheckoutResponseToView(checkout, {
      origin: 'https://opentab.example',
      workflow: finalProof,
    });
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.canonicalConfirmation?.eventName).toBe('OrderPaid');
  });
});

describe('public Judge proof view mapping', () => {
  it('preserves runtime chain, canonical decoded fields, route evidence, and timing phases', () => {
    const view = mapPublicJudgeProofToView(recordedPublicJudgeProof);

    expect(view.orderId).toBe(recordedPublicJudgeProof.orderId);
    expect(view.settlement.chainId).toBe('42161');
    expect(view.settlement.receiptId).toBe(recordedPublicJudgeProof.settlement.receiptId);
    expect(view.settlement.passTokenId).toBe('17');
    expect(view.settlement.event?.fields).toEqual(recordedPublicJudgeProof.settlement.event.fields);
    expect(view.route).toMatchObject({
      routeEvidence: 'evidenced',
      totalUsd: '20.00',
      estimatedFeeUsd: '0.04',
      slippageBps: '75',
      previewDigest: recordedPublicJudgeProof.particle.previewDigest,
      activityUrl: recordedPublicJudgeProof.particle.activityUrl,
    });
    expect(view.route.sources?.[0]).toMatchObject({
      chainId: '8453',
      amount: '20.00',
      amountUsd: '19.98',
    });
    expect(view.recovery.timing).toEqual(recordedPublicJudgeProof.recovery.timing);
  });

  it('keeps unevidenced route values absent instead of manufacturing display money', () => {
    const view = mapPublicJudgeProofToView(unrecordedRoutePublicJudgeProof);

    expect(view.route.routeEvidence).toBe('not_evidenced');
    expect(view.route.totalUsd).toBeUndefined();
    expect(view.route.estimatedFeeUsd).toBeUndefined();
    expect(view.route.slippageBps).toBeUndefined();
    expect(view.route.previewDigest).toBeUndefined();
    expect(view.route.sources).toBeUndefined();
  });
});
