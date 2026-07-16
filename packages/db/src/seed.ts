import { PublicJudgeProofSchema } from '@opentab/shared';
import { eq } from 'drizzle-orm';
import type { OpenTabDatabase } from './client.js';
import { hashOpaqueSecret, hashSplitInvitationCapability } from './crypto.js';
import {
  canonicalLogs,
  checkoutLinks,
  checkoutSessions,
  judgeEvidence,
  loyaltyAwards,
  loyaltyBalances,
  loyaltyPrograms,
  merchantMembers,
  merchants,
  orders,
  paymentAttempts,
  products,
  receipts,
  serverSessions,
  signedOrderIntents,
  splitInvitations,
  splitParticipants,
  splits,
  userIdentities,
  users,
} from './schema/index.js';

const DEMO = {
  userId: 'usr_00000000000000000000000001',
  merchantUserId: 'usr_00000000000000000000000002',
  sessionId: 'ses_00000000000000000000000001',
  merchantId: 'mer_00000000000000000000000001',
  productId: 'prd_00000000000000000000000001',
  checkoutSessionId: 'chk_00000000000000000000000001',
  orderId: 'ord_00000000000000000000000001',
  attemptId: 'pay_00000000000000000000000001',
  receiptId: 'rcp_00000000000000000000000001',
  splitId: 'spl_00000000000000000000000001',
  invitationId: 'spi_00000000000000000000000001',
  evidenceId: 'evd_00000000000000000000000001',
  customerIdentityId: '00000000-0000-4000-8000-000000000001',
  merchantIdentityId: '00000000-0000-4000-8000-000000000002',
  checkoutLinkId: '00000000-0000-4000-8000-000000000003',
  canonicalLogId: '00000000-0000-4000-8000-000000000004',
  loyaltyProgramId: '00000000-0000-4000-8000-000000000005',
  loyaltyAwardId: '00000000-0000-4000-8000-000000000006',
  splitParticipantId: '00000000-0000-4000-8000-000000000007',
  customerAddress: '0x1111111111111111111111111111111111111111',
  merchantAddress: '0x2222222222222222222222222222222222222222',
  checkoutAddress: '0x3333333333333333333333333333333333333333',
  passAddress: '0x4444444444444444444444444444444444444444',
  universalAddress: '0x5555555555555555555555555555555555555555',
  delegateAddress: '0x6666666666666666666666666666666666666666',
  usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  orderKey: `0x${'11'.repeat(32)}`,
  transactionHash: `0x${'22'.repeat(32)}`,
  blockHash: `0x${'33'.repeat(32)}`,
  metadataHash: `0x${'44'.repeat(32)}`,
  intentDigest: `0x${'55'.repeat(32)}`,
  bindingDigest: `0x${'66'.repeat(32)}`,
  eventPayloadDigest: `0x${'77'.repeat(32)}`,
  evidenceDigest: `0x${'88'.repeat(32)}`,
  providerOperationId: 'demo-particle-operation-0001',
} as const;

export const DETERMINISTIC_DEMO_IDS = DEMO;

export async function seedDeterministicDemo(input: {
  db: OpenTabDatabase;
  environment: 'local' | 'test';
  deterministicDemoEnabled: true;
  secretPepper: string;
}): Promise<typeof DEMO> {
  if (!input.deterministicDemoEnabled || !['local', 'test'].includes(input.environment)) {
    throw new Error('Deterministic demo seed is restricted to explicit local/test mode');
  }
  const issuedAt = new Date('2026-07-10T12:00:00.000Z');
  const expiresAt = new Date('2030-07-10T12:00:00.000Z');
  const sessionToken = 'deterministic-demo-session-token-never-production';
  const csrfToken = 'deterministic-demo-csrf-token-never-production';
  const eventFields = {
    orderKey: DEMO.orderKey,
    merchantOnchainId: '1',
    productOnchainId: '1',
    payer: DEMO.customerAddress,
    recipient: DEMO.customerAddress,
    token: DEMO.usdcAddress,
    quantity: '1',
    amountBaseUnits: '25000000',
    platformFeeBaseUnits: '0',
    intentDigest: DEMO.intentDigest,
    passTokenId: '1',
    refundDeadline: '1783771200',
  };
  const decodedEventFields = {
    orderKey: DEMO.orderKey,
    merchantId: '1',
    productId: '1',
    payer: DEMO.customerAddress,
    recipient: DEMO.customerAddress,
    token: DEMO.usdcAddress,
    quantity: '1',
    amount: '25000000',
    platformFee: '0',
    intentDigest: DEMO.intentDigest,
    passTokenId: '1',
    refundDeadline: '1783771200',
  };
  const orderIntentFields = {
    orderKey: DEMO.orderKey,
    payer: DEMO.customerAddress,
    recipient: DEMO.customerAddress,
    merchantOnchainId: '1',
    productOnchainId: '1',
    productVersion: '1',
    token: DEMO.usdcAddress,
    amountBaseUnits: '25000000',
    platformFeeBps: '0',
    platformFeeBaseUnits: '0',
    quantity: '1',
    validAfter: '1783684800',
    validUntil: '1783685700',
    refundDeadline: '1783771200',
    metadataHash: DEMO.metadataHash,
  };

  await input.db.transaction(async (db) => {
    await db
      .insert(users)
      .values([
        {
          id: DEMO.userId,
          magicIssuerHash: 'a'.repeat(64),
          walletAddressChecksum: DEMO.customerAddress,
          walletAddressLower: DEMO.customerAddress.toLowerCase(),
          status: 'active',
          lastLoginAt: issuedAt,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        },
        {
          id: DEMO.merchantUserId,
          magicIssuerHash: 'b'.repeat(64),
          walletAddressChecksum: DEMO.merchantAddress,
          walletAddressLower: DEMO.merchantAddress.toLowerCase(),
          status: 'active',
          lastLoginAt: issuedAt,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        },
      ])
      .onConflictDoNothing();
    await db
      .insert(userIdentities)
      .values([
        {
          id: DEMO.customerIdentityId,
          userId: DEMO.userId,
          provider: 'magic',
          providerSubjectHash: 'a'.repeat(64),
          authMethod: 'email_otp',
          evidenceDigest: DEMO.evidenceDigest,
          lastVerifiedAt: issuedAt,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        },
        {
          id: DEMO.merchantIdentityId,
          userId: DEMO.merchantUserId,
          provider: 'magic',
          providerSubjectHash: 'b'.repeat(64),
          authMethod: 'google',
          evidenceDigest: DEMO.evidenceDigest,
          lastVerifiedAt: issuedAt,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        },
      ])
      .onConflictDoNothing();
    await db
      .insert(serverSessions)
      .values({
        id: DEMO.sessionId,
        userId: DEMO.userId,
        tokenHash: hashOpaqueSecret({
          domain: 'session-token',
          pepper: input.secretPepper,
          value: sessionToken,
        }),
        csrfTokenHash: hashOpaqueSecret({
          domain: 'csrf-token',
          pepper: input.secretPepper,
          value: csrfToken,
        }),
        expiresAt,
        lastSeenAt: issuedAt,
        createdAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(merchants)
      .values({
        id: DEMO.merchantId,
        onchainMerchantId: '1',
        ownerUserId: DEMO.merchantUserId,
        slug: 'lagos-after-dark',
        displayName: 'Lagos After Dark',
        supportContact: 'Support available from the event page',
        payoutAddress: DEMO.merchantAddress,
        payoutAddressLower: DEMO.merchantAddress.toLowerCase(),
        status: 'active',
        chainSyncStatus: 'confirmed',
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(merchantMembers)
      .values({
        merchantId: DEMO.merchantId,
        userId: DEMO.merchantUserId,
        role: 'owner',
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(products)
      .values({
        id: DEMO.productId,
        merchantId: DEMO.merchantId,
        onchainProductId: '1',
        slug: 'rooftop-pass',
        title: 'Rooftop Night Pass',
        description: 'A premium all-night rooftop event pass with instant digital receipt.',
        unitPriceBaseUnits: '25000000',
        maxSupply: '200',
        sold: '1',
        maxPerOrder: '4',
        startsAt: issuedAt,
        refundWindowSeconds: '86400',
        loyaltyPoints: '250',
        metadataHash: DEMO.metadataHash,
        status: 'active',
        chainSyncStatus: 'confirmed',
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(checkoutLinks)
      .values({
        id: DEMO.checkoutLinkId,
        productId: DEMO.productId,
        capabilityHash: 'c'.repeat(64),
        campaign: 'deterministic-demo',
        createdByUserId: DEMO.merchantUserId,
        createdAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(checkoutSessions)
      .values({
        id: DEMO.checkoutSessionId,
        userId: DEMO.userId,
        productId: DEMO.productId,
        productVersion: 1,
        quantity: '1',
        receiptRecipient: DEMO.customerAddress,
        amountBaseUnits: '25000000',
        orderKey: DEMO.orderKey,
        status: 'consumed',
        expiresAt,
        bindingDigest: DEMO.bindingDigest,
        boundAt: issuedAt,
        consumedAt: issuedAt,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(signedOrderIntents)
      .values({
        checkoutSessionId: DEMO.checkoutSessionId,
        orderKey: DEMO.orderKey,
        digest: DEMO.intentDigest,
        signerAddress: DEMO.merchantAddress,
        signerKeyId: 'deterministic-test-key',
        intent: orderIntentFields,
        signature: `0x${'99'.repeat(65)}`,
        validAfter: issuedAt,
        validUntil: expiresAt,
        refundableUntil: new Date('2026-07-11T12:00:00.000Z'),
        createdAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(orders)
      .values({
        id: DEMO.orderId,
        checkoutSessionId: DEMO.checkoutSessionId,
        orderKey: DEMO.orderKey,
        userId: DEMO.userId,
        merchantId: DEMO.merchantId,
        productId: DEMO.productId,
        payer: DEMO.customerAddress,
        recipient: DEMO.customerAddress,
        tokenAddress: DEMO.usdcAddress,
        quantity: '1',
        amountBaseUnits: '25000000',
        paidAmountBaseUnits: '25000000',
        status: 'paid',
        chainId: '42161',
        transactionHash: DEMO.transactionHash,
        blockNumber: 123456789n,
        blockHash: DEMO.blockHash,
        logIndex: 1,
        providerOperationId: DEMO.providerOperationId,
        intentDigest: DEMO.intentDigest,
        refundableUntil: new Date('2026-07-11T12:00:00.000Z'),
        confirmedAt: issuedAt,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(paymentAttempts)
      .values({
        id: DEMO.attemptId,
        orderId: DEMO.orderId,
        checkoutSessionId: DEMO.checkoutSessionId,
        attemptNumber: 1,
        status: 'paid',
        bindingDigest: DEMO.bindingDigest,
        providerOperationId: DEMO.providerOperationId,
        destinationTransactionHash: DEMO.transactionHash,
        submissionStartedAt: issuedAt,
        submittedAt: issuedAt,
        terminalAt: issuedAt,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(canonicalLogs)
      .values({
        id: DEMO.canonicalLogId,
        chainId: '42161',
        stream: 'checkout-v1',
        contractAddress: DEMO.checkoutAddress,
        eventName: 'OrderPaid',
        transactionHash: DEMO.transactionHash,
        blockNumber: 123456789n,
        blockHash: DEMO.blockHash,
        logIndex: 1,
        canonical: true,
        decodedPayload: {
          decoderVersion: 'deterministic-seed-v1',
          fields: decodedEventFields,
          confirmations: '12',
        },
        payloadDigest: DEMO.eventPayloadDigest,
        projectionStatus: 'applied',
        observedAt: issuedAt,
        projectedAt: issuedAt,
        createdAt: issuedAt,
      })
      .onConflictDoNothing();
    const [event] = await db
      .select({ id: canonicalLogs.id })
      .from(canonicalLogs)
      .where(eq(canonicalLogs.transactionHash, DEMO.transactionHash))
      .limit(1);
    if (event === undefined) throw new Error('Failed to load deterministic canonical event');
    await db
      .insert(receipts)
      .values({
        id: DEMO.receiptId,
        orderId: DEMO.orderId,
        tokenId: '1',
        metadataUri: 'https://example.invalid/opentab/demo/receipt/1',
        metadataHash: DEMO.metadataHash,
        status: 'issued',
        chainEventId: event.id,
        issuedAt,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(loyaltyPrograms)
      .values({
        id: DEMO.loyaltyProgramId,
        merchantId: DEMO.merchantId,
        name: 'After Dark Regulars',
        pointsPerBaseUnitNumerator: '1',
        pointsPerBaseUnitDenominator: '100000',
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    const [program] = await db
      .select({ id: loyaltyPrograms.id })
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.merchantId, DEMO.merchantId))
      .limit(1);
    if (program === undefined) throw new Error('Failed to load deterministic loyalty program');
    await db
      .insert(loyaltyAwards)
      .values({
        id: DEMO.loyaltyAwardId,
        programId: program.id,
        userId: DEMO.userId,
        orderId: DEMO.orderId,
        points: '250',
        canonicalEventId: event.id,
        createdAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(loyaltyBalances)
      .values({
        programId: program.id,
        userId: DEMO.userId,
        points: '250',
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    await db
      .insert(splits)
      .values({
        id: DEMO.splitId,
        orderId: DEMO.orderId,
        creatorUserId: DEMO.userId,
        beneficiary: DEMO.customerAddress,
        totalBaseUnits: '12500000',
        status: 'active',
        expiresAt,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
    let [participant] = await db
      .select({ id: splitParticipants.id })
      .from(splitParticipants)
      .where(eq(splitParticipants.splitId, DEMO.splitId))
      .limit(1);
    if (participant === undefined) {
      [participant] = await db
        .insert(splitParticipants)
        .values({
          id: DEMO.splitParticipantId,
          splitId: DEMO.splitId,
          label: 'Guest 1',
          amountBaseUnits: '12500000',
          createdAt: issuedAt,
          updatedAt: issuedAt,
        })
        .returning({ id: splitParticipants.id });
    }
    if (participant === undefined)
      throw new Error('Failed to create deterministic split participant');
    await db
      .insert(splitInvitations)
      .values({
        id: DEMO.invitationId,
        splitId: DEMO.splitId,
        participantId: participant.id,
        capabilityHash: hashSplitInvitationCapability({
          invitationId: DEMO.invitationId,
          pepper: input.secretPepper,
          capabilityToken: 'deterministic-demo-split-capability-never-production',
        }),
        status: 'unpaid',
        expiresAt,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();

    const eventProof = {
      eventName: 'OrderPaid' as const,
      chainId: '42161',
      contractAddress: DEMO.checkoutAddress,
      transactionHash: DEMO.transactionHash,
      blockNumber: '123456789',
      blockHash: DEMO.blockHash,
      logIndex: '1',
      confirmations: '12',
      canonical: true,
      observedAt: issuedAt.toISOString(),
      fields: eventFields,
    };
    const proof = PublicJudgeProofSchema.parse({
      evidenceId: DEMO.evidenceId,
      orderId: DEMO.orderId,
      provenance: 'deterministic',
      environment: 'local',
      capturedAt: issuedAt.toISOString(),
      refreshedAt: issuedAt.toISOString(),
      versions: {
        application: 'deterministic-demo',
        particleSdk: '2.0.3',
        magicSdk: '33.9.0',
        contracts: 'local-fixture',
      },
      account: {
        magicEoaBefore: DEMO.customerAddress,
        magicEoaAfter: DEMO.customerAddress,
        addressContinuous: true,
        continuityEvidence: 'deterministic_fixture',
        authMethod: 'email_otp',
        delegationTarget: DEMO.delegateAddress,
      },
      particle: {
        eip7702Enabled: true,
        eip7702Evidence: 'deterministic_fixture',
        universalAccountAddress: DEMO.universalAddress,
        routeEvidence: 'deterministic_fixture',
        totalUsd: '37.50',
        sourceSummary: [{ chainId: '8453', symbol: 'USDC', amount: '25.00', amountUsd: '25.00' }],
        estimatedFeeUsd: '0.04',
        slippageBps: '50',
        quoteObservedAt: issuedAt.toISOString(),
        previewDigest: DEMO.evidenceDigest,
        operationId: DEMO.providerOperationId,
      },
      settlement: {
        chainId: '42161',
        checkoutAddress: DEMO.checkoutAddress,
        passAddress: DEMO.passAddress,
        tokenAddress: DEMO.usdcAddress,
        amountBaseUnits: '25000000',
        receiptId: DEMO.receiptId,
        passTokenId: eventFields.passTokenId,
        event: eventProof,
      },
      recovery: {
        submissionPersistedBeforeWait: true,
        submissionPersistenceEvidence: 'deterministic_fixture',
        reloadRecovered: true,
        reloadRecoveryEvidence: 'deterministic_fixture',
        duplicatePrevented: true,
        duplicatePreventionEvidence: 'deterministic_fixture',
        timing: {
          authenticationMs: '1200',
          delegationMs: '2100',
          routePreparationMs: '2450',
          submissionToCanonicalMs: '6100',
          recoveryVerificationMs: '900',
          totalDurationMs: '12750',
        },
      },
    });
    await db
      .insert(judgeEvidence)
      .values({
        evidenceId: DEMO.evidenceId,
        orderId: DEMO.orderId,
        publicProof: proof,
        publicProofDigest: DEMO.evidenceDigest,
        published: true,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .onConflictDoNothing();
  });

  return DEMO;
}
