import { AppError, CurrentUserSchema, MerchantIdSchema } from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { LiveBackendApiCommands } from '../app/api/_lib/live-commands.js';

const ULID = '01J00000000000000000000000';
const actor = CurrentUserSchema.parse({
  id: `usr_${ULID}`,
  walletAddress: '0x1111111111111111111111111111111111111111',
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [{ merchantId: MerchantIdSchema.parse(`mer_${ULID}`), role: 'owner' }],
});
const CHECKOUT_ID = `chk_${ULID}`;
const PAYMENT_ID = `pay_${ULID}`;
const REFUND_ID = `rfd_${ULID}`;
const WITHDRAWAL_ID = `wdr_${ULID}`;
const SPLIT_PAYMENT_ID = `spa_${ULID}`;
const PROVIDER_OPERATION_ID = 'particle-operation-started-0001';
const TRANSACTION_HASH = `0x${'12'.repeat(32)}`;

type MutableRegistration = {
  status: string;
  providerOperationId?: string;
  transactionHash?: string;
};

function context(body: Readonly<Record<string, unknown>>, suffix: string) {
  return {
    actor,
    body,
    idempotencyKeyHash: `idempotency-${suffix}`.padEnd(64, 'a'),
    requestHash: `request-${suffix}`.padEnd(64, 'b'),
    requestId: `request-id-${suffix}`,
  };
}

function commands(input: {
  readonly payment: MutableRegistration;
  readonly refund: MutableRegistration;
  readonly withdrawal: MutableRegistration;
  readonly splitPayment: MutableRegistration;
  readonly operation?: MutableRegistration & {
    id: string;
    kind:
      | 'merchant_mutation'
      | 'product_mutation'
      | 'refund'
      | 'withdrawal'
      | 'split_reimbursement'
      | 'split_revocation';
  };
  readonly submissionPolicy?: {
    merchantMutations: boolean;
    refunds: boolean;
    withdrawals: boolean;
    splits: boolean;
  };
}) {
  const transition = (
    state: MutableRegistration,
    requested: { status: 'submitted' | 'submitted_unknown'; providerOperationId?: string },
    submittedStatus = 'submitted',
  ) => {
    state.status = requested.status === 'submitted' ? submittedStatus : 'submitted_unknown';
    if (requested.providerOperationId !== undefined) {
      state.providerOperationId = requested.providerOperationId;
    }
    return { ...state };
  };
  const attachSubmission = vi.fn(
    async (request: { status: 'submitted' | 'submitted_unknown'; providerOperationId?: string }) =>
      transition(input.payment, request),
  );
  const registerRefundSubmission = vi.fn(
    async (request: { status: 'submitted' | 'submitted_unknown'; providerOperationId?: string }) =>
      transition(input.refund, request),
  );
  const registerWithdrawalSubmission = vi.fn(
    async (request: { status: 'submitted' | 'submitted_unknown'; providerOperationId?: string }) =>
      transition(input.withdrawal, request),
  );
  const registerSplitPaymentSubmission = vi.fn(
    async (request: { status: 'submitted' | 'submitted_unknown'; providerOperationId?: string }) =>
      transition(input.splitPayment, request, 'confirming'),
  );
  const registerContractOperationSubmission = vi.fn(
    async (request: {
      status: 'submission_started' | 'submitted' | 'submitted_unknown';
      providerOperationId: string;
      transactionHash?: string;
    }) => {
      const operation = input.operation;
      if (operation === undefined) throw new AppError('NOT_FOUND', 'Operation not found.');
      operation.status = request.status;
      operation.providerOperationId = request.providerOperationId;
      if (request.transactionHash !== undefined) {
        operation.transactionHash = request.transactionHash;
      }
      return { ...operation };
    },
  );
  const backend = {
    getRefund: async () => ({ ...input.refund }),
    getWithdrawal: async () => ({ ...input.withdrawal }),
    getSplitPayment: async () => ({ ...input.splitPayment }),
    registerRefundSubmission,
    registerWithdrawalSubmission,
    registerSplitPaymentSubmission,
    getContractOperation: async () =>
      input.operation === undefined
        ? undefined
        : {
            ...input.operation,
            aggregateType: input.operation.kind === 'refund' ? 'refund' : 'merchant',
            aggregateId: REFUND_ID,
            binding: {},
            template: {},
            bindingDigest: `0x${'aa'.repeat(32)}`,
            expiresAt: '2027-01-01T00:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
    registerContractOperationSubmission,
  };
  const instance = new LiveBackendApiCommands({
    queries: {
      getAttemptForActor: async () => ({ ...input.payment }),
    },
    backend,
    attachSubmission: { execute: attachSubmission },
    idempotency: {
      execute: async (request: { operation: () => Promise<unknown> }) => ({
        value: await request.operation(),
      }),
    },
    workflow: {
      findCheckoutSessionForUpdate: async () => ({
        id: CHECKOUT_ID,
        userId: actor.id,
        productId: `prd_${ULID}`,
        expiresAt: '2027-01-01T00:00:00.000Z',
      }),
    },
    checkoutAddress: '0x2222222222222222222222222222222222222222',
    splitAddress: '0x3333333333333333333333333333333333333333',
    tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    checkoutPreviewPolicy: {
      providerMode: 'live',
      particleLiveEnabled: true,
      submissionEnabled: false,
      maxSlippageBps: 100,
      maxFeeUsdMicros: '5000000',
      allowedSourceChainIds: ['1', '8453', '42161'],
      allowedSourceAssets: ['USDC', 'USDT', 'ETH'],
    },
    submissionPolicy: input.submissionPolicy ?? {
      merchantMutations: false,
      refunds: false,
      withdrawals: false,
      splits: false,
    },
    now: () => new Date('2026-07-14T00:00:00.000Z'),
  } as never);
  return {
    instance,
    spies: {
      attachSubmission,
      registerRefundSubmission,
      registerWithdrawalSubmission,
      registerSplitPaymentSubmission,
      registerContractOperationSubmission,
    },
  };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

describe('live command submission-result boundaries', () => {
  it('rejects pre-start registration and accepts only matching, idempotent post-start results', async () => {
    const payment: MutableRegistration = {
      status: 'prepared',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const refund: MutableRegistration = {
      status: 'prepared',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const withdrawal: MutableRegistration = {
      status: 'created',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const splitPayment: MutableRegistration = {
      status: 'unpaid',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const { instance, spies } = commands({ payment, refund, withdrawal, splitPayment });
    const submitted = { status: 'submitted' as const, providerOperationId: PROVIDER_OPERATION_ID };

    await expectCode(
      instance.registerPaymentSubmission({
        ...context(submitted, 'payment-before-start'),
        paymentAttemptId: PAYMENT_ID,
      }),
      'PAYMENT_ALREADY_SUBMITTED',
    );
    await expectCode(
      instance.registerRefundSubmission({
        ...context(submitted, 'refund-before-start'),
        refundId: REFUND_ID,
      }),
      'PAYMENT_ALREADY_SUBMITTED',
    );
    await expectCode(
      instance.registerWithdrawalSubmission({
        ...context(submitted, 'withdrawal-before-start'),
        withdrawalId: WITHDRAWAL_ID,
      }),
      'PAYMENT_ALREADY_SUBMITTED',
    );
    await expectCode(
      instance.registerSplitPaymentSubmission({
        ...context(submitted, 'split-before-start'),
        splitPaymentAttemptId: SPLIT_PAYMENT_ID,
      }),
      'PAYMENT_ALREADY_SUBMITTED',
    );
    expect(spies.attachSubmission).not.toHaveBeenCalled();
    expect(spies.registerRefundSubmission).not.toHaveBeenCalled();
    expect(spies.registerWithdrawalSubmission).not.toHaveBeenCalled();
    expect(spies.registerSplitPaymentSubmission).not.toHaveBeenCalled();

    for (const state of [payment, refund, withdrawal, splitPayment]) {
      state.status = 'submission_started';
    }
    await instance.registerPaymentSubmission({
      ...context(submitted, 'payment-after-start'),
      paymentAttemptId: PAYMENT_ID,
    });
    await instance.registerRefundSubmission({
      ...context(submitted, 'refund-after-start'),
      refundId: REFUND_ID,
    });
    await instance.registerWithdrawalSubmission({
      ...context(submitted, 'withdrawal-after-start'),
      withdrawalId: WITHDRAWAL_ID,
    });
    await instance.registerSplitPaymentSubmission({
      ...context(submitted, 'split-after-start'),
      splitPaymentAttemptId: SPLIT_PAYMENT_ID,
    });
    expect(spies.attachSubmission).toHaveBeenCalledTimes(1);
    expect(spies.registerRefundSubmission).toHaveBeenCalledTimes(1);
    expect(spies.registerWithdrawalSubmission).toHaveBeenCalledTimes(1);
    expect(spies.registerSplitPaymentSubmission).toHaveBeenCalledTimes(1);

    await instance.registerPaymentSubmission({
      ...context(submitted, 'payment-idempotent'),
      paymentAttemptId: PAYMENT_ID,
    });
    await instance.registerRefundSubmission({
      ...context(submitted, 'refund-idempotent'),
      refundId: REFUND_ID,
    });
    await instance.registerWithdrawalSubmission({
      ...context(submitted, 'withdrawal-idempotent'),
      withdrawalId: WITHDRAWAL_ID,
    });
    await instance.registerSplitPaymentSubmission({
      ...context(submitted, 'split-idempotent'),
      splitPaymentAttemptId: SPLIT_PAYMENT_ID,
    });
    expect(spies.attachSubmission).toHaveBeenCalledTimes(1);
    expect(spies.registerRefundSubmission).toHaveBeenCalledTimes(1);
    expect(spies.registerWithdrawalSubmission).toHaveBeenCalledTimes(1);
    expect(spies.registerSplitPaymentSubmission).toHaveBeenCalledTimes(1);

    const mismatch = { status: 'submitted' as const, providerOperationId: 'different-operation' };
    await expectCode(
      instance.registerPaymentSubmission({
        ...context(mismatch, 'payment-mismatch'),
        paymentAttemptId: PAYMENT_ID,
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectCode(
      instance.registerRefundSubmission({
        ...context(mismatch, 'refund-mismatch'),
        refundId: REFUND_ID,
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectCode(
      instance.registerWithdrawalSubmission({
        ...context(mismatch, 'withdrawal-mismatch'),
        withdrawalId: WITHDRAWAL_ID,
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectCode(
      instance.registerSplitPaymentSubmission({
        ...context(mismatch, 'split-mismatch'),
        splitPaymentAttemptId: SPLIT_PAYMENT_ID,
      }),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('persists the pre-provider authorization ID and permits result registration after a flag flip', async () => {
    const policy = {
      merchantMutations: false,
      refunds: true,
      withdrawals: false,
      splits: false,
    };
    const operation: MutableRegistration & { id: string; kind: 'refund' } = {
      id: `cop_${ULID}`,
      kind: 'refund',
      status: 'prepared',
    };
    const magicProviderOperationId = `magic-direct:${operation.id}`;
    const { instance, spies } = commands({
      payment: { status: 'prepared' },
      refund: { status: 'prepared' },
      withdrawal: { status: 'prepared' },
      splitPayment: { status: 'unpaid' },
      operation,
      submissionPolicy: policy,
    });

    await instance.registerContractOperationSubmission({
      ...context(
        { status: 'submission_started', providerOperationId: magicProviderOperationId },
        'contract-start',
      ),
      operationId: operation.id,
    });
    expect(operation).toMatchObject({
      status: 'submission_started',
      providerOperationId: magicProviderOperationId,
    });

    policy.refunds = false;
    await expectCode(
      instance.registerContractOperationSubmission({
        ...context(
          { status: 'submitted', providerOperationId: magicProviderOperationId },
          'contract-magic-result-without-hash',
        ),
        operationId: operation.id,
      }),
      'OPERATION_PLAN_INVALID',
    );
    await instance.registerContractOperationSubmission({
      ...context(
        {
          status: 'submitted',
          providerOperationId: magicProviderOperationId,
          transactionHash: TRANSACTION_HASH,
        },
        'contract-provider-result-after-kill-switch',
      ),
      operationId: operation.id,
    });
    expect(operation).toMatchObject({ status: 'submitted', transactionHash: TRANSACTION_HASH });
    expect(spies.registerContractOperationSubmission).toHaveBeenCalledTimes(2);

    await instance.registerContractOperationSubmission({
      ...context(
        {
          status: 'submitted',
          providerOperationId: magicProviderOperationId,
          transactionHash: TRANSACTION_HASH,
        },
        'contract-provider-result-idempotent',
      ),
      operationId: operation.id,
    });
    expect(spies.registerContractOperationSubmission).toHaveBeenCalledTimes(2);
    await expectCode(
      instance.registerContractOperationSubmission({
        ...context(
          { status: 'submitted', providerOperationId: 'different-operation' },
          'contract-provider-result-mismatch',
        ),
        operationId: operation.id,
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectCode(
      instance.registerContractOperationSubmission({
        ...context(
          {
            status: 'submitted',
            providerOperationId: magicProviderOperationId,
            transactionHash: `0x${'34'.repeat(32)}`,
          },
          'contract-transaction-mismatch',
        ),
        operationId: operation.id,
      }),
      'IDEMPOTENCY_CONFLICT',
    );

    operation.status = 'prepared';
    delete operation.providerOperationId;
    await expectCode(
      instance.registerContractOperationSubmission({
        ...context(
          { status: 'submission_started', providerOperationId: 'new-provider-operation' },
          'contract-new-start-after-kill-switch',
        ),
        operationId: operation.id,
      }),
      'FEATURE_DISABLED',
    );
  });

  it('returns a policy-only live preview that cannot authorize a plan or submission', async () => {
    const { instance } = commands({
      payment: { status: 'created' },
      refund: { status: 'created' },
      withdrawal: { status: 'created' },
      splitPayment: { status: 'unpaid' },
    });
    const result = await instance.refreshCheckoutQuote({
      ...context({ reason: 'user_requested' }, 'protected-preview'),
      checkoutSessionId: CHECKOUT_ID,
    });

    expect(result.protectedPreview).toMatchObject({
      kind: 'non_spending_policy_preview',
      providerMode: 'live',
      particleLiveEnabled: true,
      eip7702: true,
      signedOrderIntentIssued: false,
      operationPlanAuthorized: false,
      submissionAuthorized: false,
      submissionEndpointEnabled: false,
    });
    const serialized = JSON.stringify(result.protectedPreview);
    expect(serialized).not.toContain('signature');
    expect(serialized).not.toContain('calldata');
    expect(serialized).not.toContain('orderIntent');
    expect(serialized).not.toContain('calls');
  });
});
