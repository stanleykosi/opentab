import type { BackendApiQueryPort } from '@opentab/application';
import type { LoadedParticleCompatibilityProfile } from '@opentab/db';
import type { CurrentUser } from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { ParticleReleasePaymentPolicy } from './particle-payment-policy.js';

const OPERATOR_HASH = `0x${'1'.repeat(64)}`;
const CANARY_PRODUCT_ID = `0x${'2'.repeat(64)}`;
const ORDER_ID = '01J00000000000000000000000' as Parameters<
  BackendApiQueryPort['getOrderForActor']
>[0];

const operator = {
  id: '01J00000000000000000000001',
  walletAddress: '0x1111111111111111111111111111111111111111',
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
} as CurrentUser;

const otherUser = {
  ...operator,
  id: '01J00000000000000000000002',
  walletAddress: '0x2222222222222222222222222222222222222222',
} as CurrentUser;

function loaded(
  stage: 'bootstrap' | 'canary_ready' | 'certified',
): LoadedParticleCompatibilityProfile {
  return {
    profile: { stage },
    binding: {
      certifiedSubjectHash: OPERATOR_HASH,
      canaryProductId: CANARY_PRODUCT_ID,
      canaryMaxBaseUnits: '1000000',
    },
  } as LoadedParticleCompatibilityProfile;
}

function setup(input: {
  readonly stage?: 'bootstrap' | 'canary_ready' | 'certified';
  readonly orderProductId?: string;
}) {
  const getOrderForActor = vi.fn<BackendApiQueryPort['getOrderForActor']>();
  getOrderForActor.mockResolvedValue(
    input.orderProductId === undefined
      ? undefined
      : ({ product: { onchainProductId: input.orderProductId } } as Awaited<
          ReturnType<BackendApiQueryPort['getOrderForActor']>
        >),
  );
  const policy = new ParticleReleasePaymentPolicy({
    loaded: input.stage === undefined ? undefined : loaded(input.stage),
    queries: { getOrderForActor } as unknown as BackendApiQueryPort,
    subjectHash: (actor) => (actor.id === operator.id ? OPERATOR_HASH : `0x${'3'.repeat(64)}`),
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
