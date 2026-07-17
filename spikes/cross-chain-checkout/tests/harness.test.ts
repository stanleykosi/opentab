import { EvmAddressSchema, type ProviderOperationId } from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  assessLiveAcceptanceGate,
  LIVE_TRANSACTION_CONFIRMATION,
  type LiveAcceptanceDependencies,
  runLiveAcceptance,
} from '../src/index.js';

const owner = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const implementation = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const checkout = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const pass = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const token = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const orderSigner = EvmAddressSchema.parse(`0x${'5'.repeat(40)}`);
const sourceToken = EvmAddressSchema.parse(`0x${'6'.repeat(40)}`);
const bytes32 = (character: string) => `0x${character.repeat(64)}` as `0x${string}`;
const operationId = 'particle-live-operation-id' as ProviderOperationId;

function authorizedEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ENV: 'demo-mainnet',
    NEXT_PUBLIC_APP_ENV: 'demo-mainnet',
    NEXT_PUBLIC_APP_ORIGIN: 'https://opentab.example',
    PROVIDER_MODE: 'live',
    PAYMENTS_ENABLED: 'true',
    PARTICLE_LIVE_ENABLED: 'true',
    RUN_TINY_LIVE_TESTS: 'true',
    LIVE_TRANSACTION_CONFIRMATION,
    NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: 'pk_live_test_value',
    MAGIC_SECRET_KEY: 'sk_live_test_value',
    NEXT_PUBLIC_PARTICLE_PROJECT_ID: 'particle-project-id',
    NEXT_PUBLIC_PARTICLE_CLIENT_KEY: 'particle-client-key',
    NEXT_PUBLIC_PARTICLE_APP_UUID: 'particle-app-uuid',
    PARTICLE_RPC_URL: 'https://universal-rpc-proxy.particle.network',
    PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: implementation,
    PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: bytes32('6'),
    PARTICLE_RESPONSE_PROFILE_ID: 'particle-2.0.3-recorded-profile',
    PARTICLE_RESPONSE_PROFILE_PROVENANCE: 'recorded_live',
    PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: bytes32('7'),
    PARTICLE_AUTH_FIXTURE_DIGEST: bytes32('8'),
    PARTICLE_SUBMISSION_FIXTURE_DIGEST: bytes32('9'),
    PARTICLE_STATUS_FIXTURE_DIGEST: bytes32('a'),
    PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET: '1',
    PARTICLE_DELEGATION_PLAN_TTL_SECONDS: '300',
    PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: '42161,8453',
    PARTICLE_ALLOWED_SOURCE_ASSETS: 'USDC',
    PARTICLE_ALLOWED_SOURCE_TOKENS: `8453:USDC:${sourceToken}`,
    PARTICLE_SOURCE_CALL_PROFILES_JSON: JSON.stringify([
      {
        profileId: 'base-usdc-recorded-v1',
        chainId: '8453',
        asset: 'USDC',
        tokenAddress: sourceToken,
        sourceAmount: '0.01',
        fixtureDigest: bytes32('b'),
        calls: [{ uaType: 'evm', to: sourceToken, data: '0x1234', valueWei: '0' }],
      },
    ]),
    ARBITRUM_RPC_URL: 'https://arb-primary.example',
    ARBITRUM_FALLBACK_RPC_URL: 'https://arb-secondary.example',
    NEXT_PUBLIC_USDC_ADDRESS: token,
    NEXT_PUBLIC_CHECKOUT_ADDRESS: checkout,
    NEXT_PUBLIC_PASS_ADDRESS: pass,
    DATABASE_URL: 'postgresql://opentab:test@db.example/opentab',
    DATABASE_URL_EVIDENCE_WRITER: 'postgresql://opentab_evidence:test@db.example/opentab',
    LIVE_ACCEPTANCE_ATTESTATION_SECRET: 'acceptance-attestation-secret-over-32-bytes',
    LIVE_ACCEPTANCE_RELEASE_ID: 'b'.repeat(40),
    LIVE_ACCEPTANCE_DEPLOYMENT_CONFIG_DIGEST: bytes32('d'),
    REDIS_URL: 'rediss://redis.example',
    SESSION_HASH_PEPPER: 'session-hash-pepper-value-over-32-bytes',
    CSRF_SECRET: 'csrf-secret-value-over-thirty-two-bytes',
    CAPABILITY_TOKEN_PEPPER: 'capability-pepper-value-over-32-bytes',
    PRIVACY_SUBJECT_HASH_SECRET: 'privacy-subject-value-over-thirty-two-bytes',
    ORDER_SIGNER_MODE: 'kms',
    ORDER_SIGNER_KMS_KEY_ID: 'arn:aws:kms:us-east-1:111111111111:key/order',
    ORDER_SIGNER_ADDRESS: orderSigner,
    AWS_KMS_REGION: 'us-east-1',
    VERCEL_AWS_ROLE_ARN: 'arn:aws:iam::111111111111:role/opentab-vercel-order',
    PLATFORM_FEE_BPS: '100',
    PARTICLE_MAX_SLIPPAGE_BPS: '100',
    INDEXER_DEPLOYMENT_BLOCK: '100',
    LIVE_ACCEPTANCE_PRODUCT_ID: 'prd_01J00000000000000000000000',
    LIVE_ACCEPTANCE_AUTH_METHOD: 'google',
    LIVE_ACCEPTANCE_SOURCE_CHAIN_ID: '8453',
    LIVE_ACCEPTANCE_MAX_USDC_BASE_UNITS: '10000',
    CONFIRMATION_DEPTH: '2',
    ...overrides,
  };
}

function dependencies(sequence: string[] = []): LiveAcceptanceDependencies {
  const record = <T>(name: string, value: T) =>
    vi.fn(async () => {
      sequence.push(name);
      return value;
    });
  return {
    authenticateAndExchangeMagicProof: record('authenticate', {
      ownerAddress: owner,
      serverVerifiedAddress: owner,
      authMethod: 'google',
      restored: true,
      evidenceDigest: bytes32('b'),
    }),
    signMagicAddressChallenge: record('challenge', {
      recoveredOwner: owner,
      evidenceDigest: bytes32('c'),
    }),
    inspectEip7702Readiness: record('readiness', {
      ownerAddress: owner,
      chainId: '42161',
      delegated: false,
      expectedImplementation: implementation,
      implementationCodeHash: bytes32('6'),
      activationPath: 'self_funded_type4',
    }),
    activateDelegation: record('activate', {
      ownerAddress: owner,
      transactionHash: bytes32('d'),
    }),
    verifyDelegationOnchain: record('verifyDelegation', {
      ownerAddress: owner,
      delegated: true,
      implementationAddress: implementation,
      implementationCodeHash: bytes32('6'),
      transactionHash: bytes32('d'),
    }),
    initializeParticleEip7702: record('particle', {
      ownerAddress: owner,
      evmAddress: owner,
      useEIP7702: true,
      protocolVersion: '2.0.1',
      safeAccountIdentifiers: [owner],
    }),
    readPreflightBalances: record('balances', {
      arbitrumUsdcBaseUnitsBefore: '0',
      sources: [{ chainId: '8453', symbol: 'USDC', rawAmount: '10000', amountUsd: '0.01' }],
      evidenceDigest: bytes32('e'),
    }),
    assertDelegatedPassReceiver: record('receiver', undefined),
    createServerBoundCheckout: record('checkout', {
      orderId: 'ord_01J00000000000000000000000',
      attemptId: 'pay_01J00000000000000000000000',
      orderKey: bytes32('f'),
      ownerAddress: owner,
      recipientAddress: owner,
      checkoutAddress: checkout,
      tokenAddress: token,
      merchantOnchainId: '1',
      productOnchainId: '2',
      amountBaseUnits: '10000',
      platformFeeBaseUnits: '100',
      quantity: '1',
      intentDigest: bytes32('7'),
      refundDeadline: '1784034300',
      bindingDigest: bytes32('1'),
    }),
    prepareAndValidateParticleOperation: record('prepare', {
      providerOperationId: operationId,
      ownerAddress: owner,
      chainId: '42161',
      checkoutAddress: checkout,
      tokenAddress: token,
      amountBaseUnits: '10000',
      rootHash: bytes32('2'),
      exactCallTemplateVerified: true,
      sources: [{ chainId: '8453', symbol: 'USDC', amount: '0.01', amountUsd: '0.01' }],
      totalUsd: '0.011',
      estimatedFeeUsd: '0.001',
      slippageBps: '100',
      quotedAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2099-07-14T12:05:00.000Z',
      activityUrl: 'https://universalx.app/activity/details?id=particle-live-operation-id',
      previewDigest: bytes32('3'),
      preparedEvidenceDigest: bytes32('4'),
    }),
    signParticleRoot: record('signRoot', {
      recoveredOwner: owner,
      signatureDigest: bytes32('4'),
    }),
    persistProviderOperationBeforeSubmission: record('persist', undefined),
    submitParticleOperationOnce: record('submit', {
      providerOperationId: operationId,
      status: 'executing',
      activityUrl: 'https://universalx.app/activity/details?id=particle-live-operation-id',
    }),
    awaitCanonicalArbitrumPayment: record('canonicalPayment', {
      providerOperationId: operationId,
      receiptId: 'rcp_01J00000000000000000000000',
      passTokenId: '42',
      event: {
        eventName: 'OrderPaid',
        chainId: '42161',
        contractAddress: checkout,
        transactionHash: bytes32('5'),
        blockNumber: '100',
        blockHash: bytes32('6'),
        logIndex: '1',
        confirmations: '2',
        canonical: true,
        observedAt: '2026-07-14T12:00:00.000Z',
        fields: {
          orderKey: bytes32('f'),
          merchantOnchainId: '1',
          productOnchainId: '2',
          payer: owner,
          recipient: owner,
          token,
          quantity: '1',
          amountBaseUnits: '10000',
          platformFeeBaseUnits: '100',
          intentDigest: bytes32('7'),
          passTokenId: '42',
          refundDeadline: '1784034300',
        },
      },
    }),
    readFinalProviderOperation: record('finalProviderOperation', {
      id: operationId,
      status: 'succeeded',
      submissionPossible: true,
      destinationTransactionHash: bytes32('5'),
      activityUrl: 'https://universalx.app/activity/details?id=particle-live-operation-id',
      updatedAt: '2026-07-14T12:01:00.000Z',
      evidence: {
        adapter: 'particle-universal-accounts',
        packageVersion: '2.0.3',
        schemaVersion: 1,
        environment: 'demo-mainnet',
        observedAt: '2026-07-14T12:01:00.000Z',
        evidenceDigest: bytes32('a'),
        provenance: 'recorded_live',
      },
    }),
    reloadAndReconcile: record('recover', {
      providerOperationId: operationId,
      finalOrderStatus: 'paid',
      sponsorGrantCount: 0,
      delegationCount: 1,
      orderCount: 1,
      paymentAttemptCount: 1,
      providerOperationCount: 1,
      submissionCount: 1,
      receiptCount: 1,
    }),
    persistSanitizedEvidence: record('persistEvidence', undefined),
  };
}

describe('protected live cross-chain acceptance harness', () => {
  it('returns an external blocker and calls no provider without explicit authorization', async () => {
    const deps = dependencies();
    const result = await runLiveAcceptance({}, deps);
    expect(result).toMatchObject({ status: 'EXTERNAL_BLOCKER' });
    expect(result).toHaveProperty('missing');
    expect(deps.authenticateAndExchangeMagicProof).not.toHaveBeenCalled();
  });

  it('rejects same-provider RPCs, Arbitrum-only source, and excessive spend consent', () => {
    const result = assessLiveAcceptanceGate(
      authorizedEnvironment({
        ARBITRUM_FALLBACK_RPC_URL: 'https://arb-primary.example/other-key',
        LIVE_ACCEPTANCE_SOURCE_CHAIN_ID: '42161',
        LIVE_ACCEPTANCE_MAX_USDC_BASE_UNITS: '1000001',
      }),
    );
    expect(result.status).toBe('EXTERNAL_BLOCKER');
    if (result.status === 'EXTERNAL_BLOCKER') {
      expect(result.missing.join('\n')).toContain('independent HTTPS providers');
      expect(result.missing.join('\n')).toContain('non-Arbitrum');
      expect(result.missing.join('\n')).toContain('1..1000000');
    }
  });

  it('rejects an absent or empty recorded source-call profile before provider access', async () => {
    const deps = dependencies();
    const result = await runLiveAcceptance(
      authorizedEnvironment({ PARTICLE_SOURCE_CALL_PROFILES_JSON: '[]' }),
      deps,
    );
    expect(result).toMatchObject({ status: 'EXTERNAL_BLOCKER' });
    if (result.status === 'EXTERNAL_BLOCKER') {
      expect(result.missing).toContain(
        'PARTICLE_SOURCE_CALL_PROFILES_JSON=reviewed nonempty JSON array',
      );
    }
    expect(deps.authenticateAndExchangeMagicProof).not.toHaveBeenCalled();
  });

  it('persists the provider ID before its only submission and proves canonical recovery', async () => {
    const sequence: string[] = [];
    const result = await runLiveAcceptance(authorizedEnvironment(), dependencies(sequence));
    expect(result).toMatchObject({
      status: 'LIVE_ACCEPTANCE_EVIDENCED',
      ownerAddressBefore: owner,
      ownerAddressAfter: owner,
      activationPath: 'self_funded_type4',
      particle: { providerOperationId: operationId, useEIP7702: true },
      providerOperation: {
        id: operationId,
        status: 'succeeded',
        destinationTransactionHash: bytes32('5'),
      },
      arbitrum: { passTokenId: '42' },
      recovery: { submissionCount: 1, receiptCount: 1 },
    });
    expect(sequence.indexOf('persist')).toBeLessThan(sequence.indexOf('submit'));
    expect(sequence.filter((entry) => entry === 'submit')).toHaveLength(1);
    expect(sequence.at(-1)).toBe('persistEvidence');
  });

  it('does not accept Particle workflow success without matching canonical Arbitrum fields', async () => {
    const deps = dependencies();
    deps.awaitCanonicalArbitrumPayment = vi.fn(async () => ({
      providerOperationId: operationId,
      receiptId: 'rcp_01J00000000000000000000000',
      passTokenId: '42',
      event: {
        eventName: 'OrderPaid',
        chainId: '42161',
        contractAddress: checkout,
        transactionHash: bytes32('5'),
        blockNumber: '100',
        blockHash: bytes32('6'),
        logIndex: '1',
        confirmations: '2',
        canonical: true,
        observedAt: '2026-07-14T12:00:00.000Z',
        fields: {
          orderKey: bytes32('f'),
          merchantOnchainId: '999',
          productOnchainId: '2',
          payer: owner,
          recipient: owner,
          token,
          quantity: '1',
          amountBaseUnits: '10000',
          platformFeeBaseUnits: '100',
          intentDigest: bytes32('8'),
          passTokenId: '42',
          refundDeadline: '1784034300',
        },
      },
    }));
    await expect(runLiveAcceptance(authorizedEnvironment(), deps)).rejects.toMatchObject({
      code: 'PAYMENT_EVENT_MISMATCH',
    });
  });

  it('requires preexisting Arbitrum USDC to be insufficient for the tiny checkout', async () => {
    const deps = dependencies();
    deps.readPreflightBalances = vi.fn(async () => ({
      arbitrumUsdcBaseUnitsBefore: '10000',
      sources: [{ chainId: '8453', symbol: 'USDC', rawAmount: '10000', amountUsd: '0.01' }],
      evidenceDigest: bytes32('e'),
    }));
    await expect(runLiveAcceptance(authorizedEnvironment(), deps)).rejects.toMatchObject({
      code: 'OPERATION_PLAN_INVALID',
    });
    expect(deps.prepareAndValidateParticleOperation).not.toHaveBeenCalled();
  });
});
