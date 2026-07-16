import {
  AppError,
  BaseUnitAmountSchema,
  CheckoutSessionIdSchema,
  type CurrentUser,
  CurrentUserSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  MerchantSchema,
  OrderIdSchema,
  PaymentAttemptIdSchema,
  ProductIdSchema,
  ProductSchema,
  UserIdSchema,
} from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import type {
  ClockPort,
  IdempotencyRepositoryPort,
  IdempotencyResult,
  MerchantRepositoryPort,
  RandomPort,
  UserRepositoryPort,
} from '../src/ports/index.js';
import {
  AttachSubmissionUseCase,
  CreateCheckoutSessionUseCase,
  CreateRefundUseCase,
  CreateSplitUseCase,
  CreateWithdrawalUseCase,
  StartSubmissionUseCase,
} from '../src/use-cases/commerce.js';
import type {
  CheckoutSessionRecord,
  CheckoutWorkflowStorePort,
  FinancialWorkflowStorePort,
  OrderRecord,
  PaymentAttemptRecord,
  SplitCapabilityIssuerPort,
} from '../src/use-cases/contracts.js';

const timestamp = '2026-07-14T00:00:00.000Z';
const later = '2026-07-15T00:00:00.000Z';
const merchantId = MerchantIdSchema.parse('mer_01J00000000000000000000000');
const productId = ProductIdSchema.parse('prd_01J00000000000000000000001');
const sessionId = CheckoutSessionIdSchema.parse('chk_01J00000000000000000000002');
const orderId = OrderIdSchema.parse('ord_01J00000000000000000000003');
const attemptId = PaymentAttemptIdSchema.parse('pay_01J00000000000000000000004');
const wallet = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const otherWallet = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const digest = EvidenceDigestSchema.parse(`0x${'3'.repeat(64)}`);
const amount = (value: string) => BaseUnitAmountSchema.parse(value);

const merchant = MerchantSchema.parse({
  id: merchantId,
  ownerUserId: UserIdSchema.parse('usr_01J00000000000000000000010'),
  slug: 'sunday-table',
  displayName: 'Sunday Table',
  payoutAddress: wallet,
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
});
const product = ProductSchema.parse({
  id: productId,
  merchantId,
  onchainProductId: '7',
  version: '1',
  slug: 'jollof-table',
  title: 'Jollof Table',
  description: 'A Sunday table pass.',
  unitPriceBaseUnits: amount('1000000'),
  maxSupply: '100',
  sold: '1',
  maxPerOrder: '5',
  startsAt: '2026-07-01T00:00:00.000Z',
  endsAt: '2026-08-01T00:00:00.000Z',
  refundWindowSeconds: '86400',
  loyaltyPoints: amount('10'),
  metadataHash: digest,
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
});

function currentUser(
  role: 'owner' | 'admin' | 'operator' | 'viewer' | undefined = undefined,
): CurrentUser {
  const ids = {
    customer: 'usr_01J00000000000000000000011',
    owner: 'usr_01J00000000000000000000010',
    admin: 'usr_01J00000000000000000000012',
    operator: 'usr_01J00000000000000000000013',
    viewer: 'usr_01J00000000000000000000014',
  } as const;
  return CurrentUserSchema.parse({
    id: UserIdSchema.parse(role === undefined ? ids.customer : ids[role]),
    walletAddress: role === undefined ? otherWallet : wallet,
    authMethod: 'email_otp',
    status: 'active',
    merchantMemberships: role === undefined ? [] : [{ merchantId, role }],
  });
}

class MemoryIdempotency implements IdempotencyRepositoryPort {
  readonly records = new Map<string, { requestHash: string; value: unknown }>();

  async execute<T>(input: {
    scope: string;
    keyHash: string;
    requestHash: string;
    expiresAt: Date;
    operation: () => Promise<T>;
  }): Promise<IdempotencyResult<T>> {
    const key = `${input.scope}:${input.keyHash}`;
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The key was reused for a different request.');
      }
      return { state: 'replayed', value: existing.value as T };
    }
    const value = await input.operation();
    this.records.set(key, { requestHash: input.requestHash, value });
    return { state: 'created', value };
  }
}

const clock: ClockPort = { now: () => new Date(timestamp) };
let randomCounter = 0;
const random: RandomPort = {
  opaqueId(prefix) {
    randomCounter += 1;
    const suffix = randomCounter.toString().padStart(2, '0');
    return `${prefix}_01J000000000000000000000${suffix}`;
  },
  bytes32: () => `0x${'4'.repeat(64)}`,
  secret: () => 'secret',
};

const session: CheckoutSessionRecord = {
  id: sessionId,
  productId,
  productVersion: '1',
  quantity: '2' as never,
  amountBaseUnits: amount('2000000'),
  orderKey: `0x${'5'.repeat(64)}` as never,
  status: 'active',
  expiresAt: later,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const order: OrderRecord = {
  id: orderId,
  checkoutSessionId: sessionId,
  orderKey: session.orderKey,
  userId: UserIdSchema.parse('usr_01J00000000000000000000011'),
  merchantId,
  productId,
  payer: otherWallet,
  recipient: otherWallet,
  quantity: '1' as never,
  amountBaseUnits: amount('1000000'),
  paidAmountBaseUnits: amount('1000000'),
  refundedAmountBaseUnits: amount('100000'),
  status: 'partially_refunded',
  transactionHash: `0x${'6'.repeat(64)}` as never,
  confirmedAt: timestamp,
  refundableUntil: later,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const attempt: PaymentAttemptRecord = {
  id: attemptId,
  orderId,
  checkoutSessionId: sessionId,
  attemptNumber: '1',
  status: 'prepared',
  bindingDigest: digest,
  preparedExpiresAt: later,
  reconciliationRequired: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function workflowStore(
  overrides: Partial<CheckoutWorkflowStorePort> = {},
): CheckoutWorkflowStorePort {
  const notUsed = async (): Promise<never> => {
    throw new Error('Unexpected store call');
  };
  return {
    findAuthoritativeProduct: async () => ({
      product,
      merchant,
      merchantOnchainId: '9',
      productOnchainId: '7',
      active: true,
      observedAt: timestamp,
    }),
    createCheckoutSession: async () => session,
    findCheckoutSessionForUpdate: async () => session,
    bindCheckoutSession: notUsed,
    createOrderAttempt: notUsed,
    recordPreparedAttempt: notUsed,
    startSubmission: async () => attempt,
    attachSubmission: async () => attempt,
    findOrder: async () => order,
    findAttempt: async () => attempt,
    ...overrides,
  };
}

describe('checkout idempotency and irreversible submission boundary', () => {
  it('returns one checkout session for duplicate delivery and rejects a changed request', async () => {
    randomCounter = 0;
    const idempotency = new MemoryIdempotency();
    let creates = 0;
    const store = workflowStore({
      createCheckoutSession: async () => {
        creates += 1;
        return session;
      },
    });
    const useCase = new CreateCheckoutSessionUseCase({
      store,
      idempotency,
      random,
      clock,
      ttlSeconds: 900,
    });
    const input = {
      productId,
      quantity: '2',
      idempotencyKeyHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
    };

    expect(await useCase.execute(input)).toEqual({ sessionId, expiresAt: later });
    expect(await useCase.execute(input)).toEqual({ sessionId, expiresAt: later });
    expect(creates).toBe(1);
    await expect(useCase.execute({ ...input, requestHash: 'c'.repeat(64) })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('records submitted_unknown and never opens a second submission boundary', async () => {
    let state: PaymentAttemptRecord = attempt;
    let starts = 0;
    const store = workflowStore({
      startSubmission: async () => {
        starts += 1;
        if (state.status === 'submission_started') return state;
        if (state.status !== 'prepared') {
          throw new AppError(
            'PAYMENT_ALREADY_SUBMITTED',
            'The payment cannot be submitted again.',
            {
              submissionPossible: true,
            },
          );
        }
        state = { ...state, status: 'submission_started', reconciliationRequired: true };
        return state;
      },
      attachSubmission: async (input) => {
        if (state.status === input.status) return state;
        if (state.status !== 'submission_started') {
          throw new AppError('PAYMENT_ALREADY_SUBMITTED', 'The payment state is irreversible.', {
            submissionPossible: true,
          });
        }
        state = { ...state, status: input.status, reconciliationRequired: true };
        return state;
      },
    });
    const start = new StartSubmissionUseCase({ store, clock });
    const attach = new AttachSubmissionUseCase({ store, clock });
    const actor = currentUser();

    expect((await start.execute({ attemptId, bindingDigest: digest, actor })).status).toBe(
      'submission_started',
    );
    expect((await start.execute({ attemptId, bindingDigest: digest, actor })).status).toBe(
      'submission_started',
    );
    expect((await attach.execute({ attemptId, actor, status: 'submitted_unknown' })).status).toBe(
      'submitted_unknown',
    );
    expect((await attach.execute({ attemptId, actor, status: 'submitted_unknown' })).status).toBe(
      'submitted_unknown',
    );
    await expect(start.execute({ attemptId, bindingDigest: digest, actor })).rejects.toMatchObject({
      code: 'PAYMENT_ALREADY_SUBMITTED',
      submissionPossible: true,
    });
    expect(starts).toBe(3);
  });
});

describe('refund and withdrawal authorization and bounds', () => {
  const users = (user: CurrentUser): UserRepositoryPort => ({
    findCurrentUserById: async () => user,
  });
  const merchants: MerchantRepositoryPort = {
    findById: async () => merchant,
    save: async () => undefined,
  };

  it('rejects a refund by a non-member and an amount above the canonical remainder', async () => {
    const financial: FinancialWorkflowStorePort = {
      createRefund: async () => ({
        id: 'rfd_created' as never,
        status: 'created',
        amountBaseUnits: amount('1'),
      }),
      createWithdrawal: async () => ({
        id: 'wdr_created' as never,
        status: 'created',
        amountBaseUnits: amount('1'),
      }),
    };
    const base = {
      store: Object.assign(workflowStore(), financial),
      idempotency: new MemoryIdempotency(),
      random,
      clock,
    };
    await expect(
      new CreateRefundUseCase({ ...base, users: users(currentUser()) }).execute({
        actorUserId: 'usr_customer',
        orderId,
        amountBaseUnits: amount('1'),
        idempotencyKeyHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(
      new CreateRefundUseCase({ ...base, users: users(currentUser('operator')) }).execute({
        actorUserId: 'usr_operator',
        orderId,
        amountBaseUnits: amount('900001'),
        idempotencyKeyHash: 'c'.repeat(64),
        requestHash: 'd'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });

  it('allows only the contract owner to withdraw and propagates the matured-credit bound', async () => {
    const financial: FinancialWorkflowStorePort = {
      createRefund: async () => ({
        id: 'rfd_created' as never,
        status: 'created',
        amountBaseUnits: amount('1'),
      }),
      createWithdrawal: async () => {
        throw new AppError('WITHDRAWAL_NOT_ALLOWED', 'The withdrawal exceeds matured credit.');
      },
    };
    const base = {
      merchants,
      store: financial,
      idempotency: new MemoryIdempotency(),
      random,
      clock,
    };
    await expect(
      new CreateWithdrawalUseCase({ ...base, users: users(currentUser('operator')) }).execute({
        actorUserId: 'usr_operator',
        merchantId,
        amountBaseUnits: amount('1'),
        idempotencyKeyHash: 'e'.repeat(64),
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(
      new CreateWithdrawalUseCase({ ...base, users: users(currentUser('admin')) }).execute({
        actorUserId: 'usr_admin',
        merchantId,
        amountBaseUnits: amount('1'),
        idempotencyKeyHash: '0'.repeat(64),
        requestHash: '9'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(
      new CreateWithdrawalUseCase({ ...base, users: users(currentUser('owner')) }).execute({
        actorUserId: 'usr_owner',
        merchantId,
        amountBaseUnits: amount('1000001'),
        idempotencyKeyHash: '1'.repeat(64),
        requestHash: '2'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'WITHDRAWAL_NOT_ALLOWED' });
  });
});

describe('split exact accounting', () => {
  const user = currentUser();
  const users: UserRepositoryPort = { findCurrentUserById: async () => user };
  const capabilities: SplitCapabilityIssuerPort = {
    create: async () => ({
      splitId: 'spl_01J00000000000000000000020' as never,
      invitations: [
        {
          invitationId: 'spi_one',
          participantLabel: 'Ada',
          amountBaseUnits: '450000',
          capabilityToken: 'capability',
          expiresAt: later,
        },
      ],
    }),
  };

  it('requires participant amounts to equal the requested total exactly', async () => {
    const useCase = new CreateSplitUseCase({
      users,
      orders: workflowStore(),
      capabilities,
      idempotency: new MemoryIdempotency(),
      clock,
    });
    const base = {
      actorUserId: user.id,
      orderId,
      beneficiary: user.walletAddress,
      totalBaseUnits: amount('450000'),
      expiresAt: later,
      idempotencyKeyHash: '3'.repeat(64),
      requestHash: '4'.repeat(64),
    };

    await expect(
      useCase.execute({
        ...base,
        participants: [
          { label: 'Ada', amountBaseUnits: amount('200000') },
          { label: 'Tobi', amountBaseUnits: amount('249999') },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const created = await useCase.execute({
      ...base,
      participants: [
        { label: 'Ada', amountBaseUnits: amount('200000') },
        { label: 'Tobi', amountBaseUnits: amount('250000') },
      ],
    });
    expect(created.splitId).toBe('spl_01J00000000000000000000020');
  });

  it('never allocates more than net canonical paid value', async () => {
    const useCase = new CreateSplitUseCase({
      users,
      orders: workflowStore(),
      capabilities,
      idempotency: new MemoryIdempotency(),
      clock,
    });
    await expect(
      useCase.execute({
        actorUserId: user.id,
        orderId,
        beneficiary: user.walletAddress,
        totalBaseUnits: amount('900001'),
        expiresAt: later,
        participants: [{ label: 'Ada', amountBaseUnits: amount('900001') }],
        idempotencyKeyHash: '5'.repeat(64),
        requestHash: '6'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
