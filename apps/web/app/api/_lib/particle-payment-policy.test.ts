import type { BackendApiQueryPort, OrderSnapshotRecord } from '@opentab/application';
import type { LoadedParticleCompatibilityProfile } from '@opentab/db';
import {
  ARBITRUM_ONE_CHAIN_ID,
  type CurrentUser,
  CurrentUserSchema,
  digestParticleCompatibilityProfile,
  EvidenceDigestSchema,
  OrderIdSchema,
  ParticleCompatibilityProfileSchema,
  ParticleProfileReleaseBindingSchema,
  type Product,
} from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { ParticleReleasePaymentPolicy } from './particle-payment-policy.js';

const digest = (value: string) => EvidenceDigestSchema.parse(`0x${value.repeat(64)}`);
const address = (value: string) => `0x${value.repeat(40)}`;
const OPERATOR_HASH = digest('1');
const CANARY_PRODUCT_ID = '2';
const ORDER_ID = OrderIdSchema.parse('ord_01J00000000000000000000000');

const operator = CurrentUserSchema.parse({
  id: 'usr_01J00000000000000000000001',
  walletAddress: '0x1111111111111111111111111111111111111111',
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});

const otherUser = CurrentUserSchema.parse({
  ...operator,
  id: 'usr_01J00000000000000000000002',
  walletAddress: '0x2222222222222222222222222222222222222222',
});

const sourceTokenProfile = {
  allowedSourceChainIds: [ARBITRUM_ONE_CHAIN_ID, '8453'],
  allowedSourceAssets: ['USDC'],
  allowedSourceTokens: [{ chainId: '8453', asset: 'USDC', address: address('4') }],
  sourceCallPolicies: [
    {
      policyId: 'base-usdc-approve-v1',
      chainId: '8453',
      asset: 'USDC',
      tokenAddress: address('4'),
      uaType: 'evm',
      target: address('5'),
      functionSelector: '0x095ea7b3',
      nativeValueAllowed: false,
      maxCalls: 1,
      capturedFixtureDigest: digest('6'),
    },
  ],
} as const;

function callableProxy<T extends object>(overrides: Partial<T>): T {
  return new Proxy(overrides, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (property === 'then') return undefined;
      throw new Error(`Unexpected test dependency access: ${String(property)}`);
    },
  }) as T;
}

function loaded(
  stage: 'bootstrap' | 'canary_ready' | 'certified',
): LoadedParticleCompatibilityProfile {
  const profile = ParticleCompatibilityProfileSchema.parse({
    schemaVersion: 1,
    profileId: `particle-payment-policy-${stage}`,
    stage,
    environment: 'demo-mainnet',
    chainId: ARBITRUM_ONE_CHAIN_ID,
    particleSdkVersion: '2.0.3',
    particleProtocolVersion: '2.0.1',
    particleProjectConfigDigest: digest('7'),
    useEIP7702: true,
    delegateAddress: address('8'),
    delegateCodeHash: digest('9'),
    responseDigests: {
      deployments: digest('a'),
      auth: digest('b'),
      ...(stage === 'certified' ? { submission: digest('c'), status: digest('d') } : {}),
    },
    nonceConvention: { magicAuthorizationNonceOffset: 1, delegationPlanTtlSeconds: 300 },
    ...(stage === 'bootstrap' ? {} : { sourceTokenProfile }),
    ...(stage === 'certified'
      ? {
          canonicalCanaryEvidence: {
            paymentAttemptId: 'pay_01J00000000000000000000000',
            orderKey: digest('e'),
            transactionHash: digest('f'),
            blockHash: digest('0'),
            acceptanceEvidenceDigest: digest('2'),
          },
        }
      : {}),
    capturedAt: '2026-07-18T10:00:00.000Z',
  });
  return {
    profile,
    binding: ParticleProfileReleaseBindingSchema.parse({
      schemaVersion: 1,
      environment: 'demo-mainnet',
      applicationReleaseId: 'a'.repeat(40),
      chainId: ARBITRUM_ONE_CHAIN_ID,
      stage,
      profileId: profile.profileId,
      profileDigest: digestParticleCompatibilityProfile(profile),
      certifiedSubjectHash: OPERATOR_HASH,
      canaryProductId: CANARY_PRODUCT_ID,
      canaryMaxBaseUnits: '1000000',
      boundAt: '2026-07-18T10:01:00.000Z',
    }),
  };
}

function setup(input: {
  readonly stage?: 'bootstrap' | 'canary_ready' | 'certified';
  readonly orderProductId?: string;
}) {
  const getOrderForActor = vi.fn<BackendApiQueryPort['getOrderForActor']>();
  getOrderForActor.mockResolvedValue(
    input.orderProductId === undefined
      ? undefined
      : callableProxy<OrderSnapshotRecord>({
          product: callableProxy<Product>({ onchainProductId: input.orderProductId }),
        }),
  );
  const policy = new ParticleReleasePaymentPolicy({
    loaded: input.stage === undefined ? undefined : loaded(input.stage),
    queries: callableProxy<BackendApiQueryPort>({ getOrderForActor }),
    subjectHash: (actor) => (actor.id === operator.id ? OPERATOR_HASH : digest('3')),
  });
  return { getOrderForActor, policy };
}

function creationInput(user: CurrentUser, productOnchainId: string, amountBaseUnits: string) {
  return {
    user,
    session: { amountBaseUnits },
    authoritative: { productOnchainId },
  };
}

function submissionInput(actor: CurrentUser, amountBaseUnits = '1000000') {
  return {
    actor,
    workflow: { order: { id: ORDER_ID, amountBaseUnits } },
  };
}

describe('Particle release payment policy', () => {
  it('fails closed when this release has no compatibility profile', async () => {
    const { policy } = setup({});

    expect(() => policy.authorizeCreation(creationInput(operator, CANARY_PRODUCT_ID, '1'))).toThrow(
      expect.objectContaining({ code: 'FEATURE_DISABLED' }),
    );
    await expect(policy.authorizeSubmission(submissionInput(operator))).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
  });

  it('rejects a wrong canary subject, product, or amount before certification', async () => {
    const { getOrderForActor, policy } = setup({
      stage: 'canary_ready',
      orderProductId: CANARY_PRODUCT_ID,
    });

    expect(() =>
      policy.authorizeCreation(creationInput(otherUser, CANARY_PRODUCT_ID, '1')),
    ).toThrow(expect.objectContaining({ code: 'AUTH_FORBIDDEN' }));
    expect(() =>
      policy.authorizeCreation(creationInput(operator, `0x${'4'.repeat(64)}`, '1')),
    ).toThrow(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    expect(() =>
      policy.authorizeCreation(creationInput(operator, CANARY_PRODUCT_ID, '1000001')),
    ).toThrow(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    await expect(policy.authorizeSubmission(submissionInput(otherUser))).rejects.toMatchObject({
      code: 'AUTH_FORBIDDEN',
    });
    expect(getOrderForActor).not.toHaveBeenCalled();
  });

  it('blocks submission while the bound release remains at bootstrap', async () => {
    const { getOrderForActor, policy } = setup({
      stage: 'bootstrap',
      orderProductId: CANARY_PRODUCT_ID,
    });

    await expect(policy.authorizeSubmission(submissionInput(operator))).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
    expect(getOrderForActor).not.toHaveBeenCalled();
  });

  it('allows the bound operator to submit the bound canary at canary_ready', async () => {
    const { getOrderForActor, policy } = setup({
      stage: 'canary_ready',
      orderProductId: CANARY_PRODUCT_ID,
    });

    await expect(policy.authorizeSubmission(submissionInput(operator))).resolves.toBeUndefined();
    expect(getOrderForActor).toHaveBeenCalledOnce();
    expect(getOrderForActor).toHaveBeenCalledWith(ORDER_ID, operator);
  });

  it('allows normal creation and submission after certification', async () => {
    const { getOrderForActor, policy } = setup({ stage: 'certified' });

    expect(() =>
      policy.authorizeCreation(
        creationInput(otherUser, `0x${'9'.repeat(64)}`, '999999999999999999'),
      ),
    ).not.toThrow();
    await expect(
      policy.authorizeSubmission(submissionInput(otherUser, '999999999999999999')),
    ).resolves.toBeUndefined();
    expect(getOrderForActor).not.toHaveBeenCalled();
  });
});
