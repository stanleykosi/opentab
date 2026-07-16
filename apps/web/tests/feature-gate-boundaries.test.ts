import type {
  BackendApiCommandPort,
  BackendApiQueryPort,
  BackendApiResourceQueryPort,
} from '@opentab/application';
import { AppError, CurrentUserSchema, MerchantIdSchema, ProductIdSchema } from '@opentab/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindCheckoutSession,
  createCheckoutSession,
  createPaymentAttempt,
  getCheckoutSession,
  getPaymentAttempt,
  getPaymentRecovery,
  recordPreparedPayment,
  recoverPaymentAttempt,
  refreshCheckoutQuote,
  registerPaymentSubmission,
  startPaymentSubmission,
} from '../app/api/_lib/endpoints-checkout.js';
import {
  archiveProduct,
  createCheckoutLink,
  createMerchantProfile,
  createProduct,
  getLoyaltyStatus,
  getMerchantMembership,
  getMerchantProduct,
  getMerchantProfile,
  getMerchantSummary,
  getRefund,
  getSettlement,
  getWithdrawal,
  listMerchantOrders,
  listMerchantProducts,
  onboardMerchant,
  pauseProduct,
  publishProduct,
  registerRefundSubmission,
  registerWithdrawalSubmission,
  updateLoyalty,
  updateMerchantProfile,
  updateProduct,
} from '../app/api/_lib/endpoints-merchant.js';
import { getCheckoutLink } from '../app/api/_lib/endpoints-public.js';
import {
  getSplit,
  getSplitPayment,
  registerSplitPaymentSubmission,
} from '../app/api/_lib/endpoints-split.js';
import {
  getBootstrapGrant,
  getWalletBalance,
  getWalletReadiness,
  recordDelegationEvidence,
} from '../app/api/_lib/endpoints-wallet.js';
import type { RouteContext } from '../app/api/_lib/params.js';
import {
  type BackendApiRegistry,
  installBackendApiRegistry,
  resetBackendApiRegistryForTests,
} from '../app/api/_lib/registry.js';

const ORIGIN = 'https://opentab.example';
const ULID = '01J00000000000000000000000';
const USER_ID = `usr_${ULID}`;
const MERCHANT_ID = MerchantIdSchema.parse(`mer_${ULID}`);
const PRODUCT_ID = ProductIdSchema.parse(`prd_${ULID}`);
const CHECKOUT_ID = `chk_${ULID}`;
const PAYMENT_ID = `pay_${ULID}`;
const ORDER_ID = `ord_${ULID}`;
const SPLIT_ID = `spl_${ULID}`;
const REFUND_ID = `rfd_${ULID}`;
const WITHDRAWAL_ID = `wdr_${ULID}`;
const SPLIT_PAYMENT_ID = `spa_${ULID}`;
const GRANT_ID = `spg_${ULID}`;
const PROVIDER_OPERATION_ID = 'particle-operation-canary-0001';
const WALLET = '0x1111111111111111111111111111111111111111';
const DIGEST = `0x${'ab'.repeat(32)}`;
const actor = CurrentUserSchema.parse({
  id: USER_ID,
  walletAddress: WALLET,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [{ merchantId: MERCHANT_ID, role: 'owner' }],
});

function callableProxy<T extends object>(overrides: Partial<Record<keyof T, unknown>> = {}): T {
  return new Proxy(overrides as object, {
    get(target, property) {
      const configured = Reflect.get(target, property);
      return configured ?? (async () => ({}));
    },
  }) as T;
}

function install(input: {
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly commands?: Partial<Record<keyof BackendApiCommandPort, unknown>>;
  readonly queries?: Partial<Record<keyof BackendApiQueryPort, unknown>>;
  readonly resourceQueries?: Partial<Record<keyof BackendApiResourceQueryPort, unknown>>;
}) {
  installBackendApiRegistry({
    sessions: callableProxy<BackendApiRegistry['sessions']>({
      verify: async () => actor,
      verifyCsrf: async () => actor,
    }),
    authContinuations: callableProxy<BackendApiRegistry['authContinuations']>(),
    exchangeSession: callableProxy<BackendApiRegistry['exchangeSession']>(),
    refreshSession: callableProxy<BackendApiRegistry['refreshSession']>(),
    logoutSession: callableProxy<BackendApiRegistry['logoutSession']>(),
    queries: callableProxy<BackendApiQueryPort>(input.queries),
    resourceQueries: callableProxy<BackendApiResourceQueryPort>(input.resourceQueries),
    commands: callableProxy<BackendApiCommandPort>(input.commands),
    featureFlags: {
      enabled: async (flag) => input.flags?.[flag] ?? false,
    },
    rateLimits: { consume: async () => ({ allowed: true as const }) },
    requestLog: { info: vi.fn(), error: vi.fn() },
    allowedOrigin: ORIGIN,
    sessionCookieName: '__Host-opentab_session',
    authContinuationCookieName: '__Host-opentab_auth_state',
    sessionCookieSecure: true,
    digestSecret: () => 'a'.repeat(64),
    networkSubject: () => '198.51.100.24',
  });
}

function route(name: string, value: string): RouteContext {
  return { params: Promise.resolve({ [name]: value }) };
}

function request(
  path: string,
  options: {
    readonly method?: 'GET' | 'POST' | 'PATCH';
    readonly body?: unknown;
    readonly key?: string;
  } = {},
): Request {
  const method = options.method ?? 'GET';
  const mutation = method !== 'GET';
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: '__Host-opentab_session=opaque-test-session',
      ...(mutation
        ? {
            origin: ORIGIN,
            'content-type': 'application/json',
            'x-csrf-token': 'csrf-token-that-is-at-least-thirty-two-characters',
            'idempotency-key': options.key ?? 'feature-boundary-key-0001',
          }
        : {}),
    },
    ...(mutation ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
}

async function expectFeatureDisabled(response: Promise<Response>): Promise<void> {
  const resolved = await response;
  expect(resolved.status).toBe(503);
  await expect(resolved.json()).resolves.toMatchObject({ error: { code: 'FEATURE_DISABLED' } });
}

beforeEach(() => resetBackendApiRegistryForTests());

describe('Particle read/preview canary boundary', () => {
  it('allows provider reads and protected preview while blocking every submit-capable plan step', async () => {
    const createAttempt = vi.fn(async () => ({ impossible: true }));
    install({
      flags: {
        'particle-reads': true,
        'checkout-preview': true,
        'checkout-submit': false,
      },
      commands: {
        createCheckoutSession: async () => ({
          sessionId: CHECKOUT_ID,
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
        bindCheckoutSession: async () => ({ session: { id: CHECKOUT_ID } }),
        refreshCheckoutQuote: async () => ({
          checkoutSessionId: CHECKOUT_ID,
          refreshVersion: 'safe-preview',
          expiresAt: '2027-01-01T00:00:00.000Z',
          protectedPreview: {
            kind: 'non_spending_policy_preview',
            signedOrderIntentIssued: false,
            operationPlanAuthorized: false,
            submissionAuthorized: false,
          },
        }),
        createPaymentAttempt: createAttempt,
      },
      resourceQueries: {
        getWalletReadiness: async () => ({ ready: false, blockers: ['delegation_required'] }),
        getWalletBalance: async () => ({ balance: { totalUsd: '25.00' } }),
      },
    });

    expect((await getWalletReadiness(request('/api/v1/wallet/readiness'))).status).toBe(200);
    expect((await getWalletBalance(request('/api/v1/wallet/balance'))).status).toBe(200);
    expect(
      (
        await createCheckoutSession(
          request('/api/v1/checkout-sessions', {
            method: 'POST',
            body: { productId: PRODUCT_ID, quantity: '1' },
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await bindCheckoutSession(
          request(`/api/v1/checkout-sessions/${CHECKOUT_ID}/bind`, {
            method: 'POST',
            body: {},
          }),
          route('checkoutSessionId', CHECKOUT_ID),
        )
      ).status,
    ).toBe(200);
    const preview = await refreshCheckoutQuote(
      request(`/api/v1/checkout-sessions/${CHECKOUT_ID}/quote-refresh`, {
        method: 'POST',
        body: { reason: 'user_requested' },
      }),
      route('checkoutSessionId', CHECKOUT_ID),
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      protectedPreview: {
        kind: 'non_spending_policy_preview',
        signedOrderIntentIssued: false,
        operationPlanAuthorized: false,
        submissionAuthorized: false,
      },
    });

    await expectFeatureDisabled(
      createPaymentAttempt(
        request(`/api/v1/checkout-sessions/${CHECKOUT_ID}/payment-attempts`, {
          method: 'POST',
          body: {},
        }),
        route('checkoutSessionId', CHECKOUT_ID),
      ),
    );
    await expectFeatureDisabled(
      recordPreparedPayment(
        request(`/api/v1/payment-attempts/${PAYMENT_ID}/prepared`, {
          method: 'POST',
          body: {
            providerOperationId: PROVIDER_OPERATION_ID,
            rootHashDigest: DIGEST,
            previewDigest: DIGEST,
            expiresAt: '2027-01-01T00:00:00.000Z',
            quoteSummary: {
              sourceAmountBaseUnits: '1000000',
              destinationAmountBaseUnits: '990000',
              feeBaseUnits: '10000',
              routeLabel: 'Base USDC to checkout',
            },
          },
        }),
        route('paymentAttemptId', PAYMENT_ID),
      ),
    );
    await expectFeatureDisabled(
      startPaymentSubmission(
        request(`/api/v1/payment-attempts/${PAYMENT_ID}/submission/start`, {
          method: 'POST',
          body: { bindingDigest: DIGEST },
        }),
        route('paymentAttemptId', PAYMENT_ID),
      ),
    );
    expect(createAttempt).not.toHaveBeenCalled();
  });
});

describe('merchant mutation kill switch', () => {
  it('blocks every merchant/product/link/loyalty write and preserves every existing read', async () => {
    install({
      flags: { 'merchant-mutations': false },
      queries: {
        getMerchantSummary: async () => ({ merchantId: MERCHANT_ID }),
        listMerchantOrders: async () => ({ items: [] }),
        listMerchantProducts: async () => ({ items: [] }),
        getMerchantProductForActor: async () => ({ product: { id: PRODUCT_ID } }),
      },
      resourceQueries: {
        getMerchantProfile: async () => ({ id: MERCHANT_ID }),
        getMerchantMembership: async () => ({ memberships: actor.merchantMemberships }),
        getCheckoutLink: async () => ({ id: 'link-existing' }),
        getLoyaltyStatus: async () => ({ points: '25' }),
      },
    });

    const productBody = {
      merchantId: MERCHANT_ID,
      slug: 'night-market',
      title: 'Night Market Pass',
      description: 'One pass',
      unitPriceBaseUnits: '1000000',
      maxPerOrder: '2',
      startsAt: '2027-01-01T00:00:00.000Z',
      refundWindowSeconds: '3600',
      loyaltyPoints: '10',
    };
    const mutations: readonly (() => Promise<Response>)[] = [
      () =>
        createMerchantProfile(
          request('/api/v1/merchant/profile', {
            method: 'POST',
            body: { slug: 'night-market', displayName: 'Night Market', payoutAddress: WALLET },
          }),
        ),
      () =>
        updateMerchantProfile(
          request('/api/v1/merchant/profile', {
            method: 'PATCH',
            body: { expectedVersion: '1', displayName: 'Night Market Two' },
          }),
        ),
      () => onboardMerchant(request('/api/v1/merchant/onboarding', { method: 'POST', body: {} })),
      () =>
        createProduct(request('/api/v1/merchant/products', { method: 'POST', body: productBody })),
      () =>
        updateProduct(
          request(`/api/v1/merchant/products/${PRODUCT_ID}`, {
            method: 'PATCH',
            body: { expectedVersion: '1', title: 'Updated pass' },
          }),
          route('productId', PRODUCT_ID),
        ),
      () =>
        publishProduct(
          request(`/api/v1/merchant/products/${PRODUCT_ID}/publish`, { method: 'POST', body: {} }),
          route('productId', PRODUCT_ID),
        ),
      () =>
        pauseProduct(
          request(`/api/v1/merchant/products/${PRODUCT_ID}/pause`, { method: 'POST', body: {} }),
          route('productId', PRODUCT_ID),
        ),
      () =>
        archiveProduct(
          request(`/api/v1/merchant/products/${PRODUCT_ID}/archive`, { method: 'POST', body: {} }),
          route('productId', PRODUCT_ID),
        ),
      () =>
        createCheckoutLink(
          request('/api/v1/merchant/checkout-links', {
            method: 'POST',
            body: { productId: PRODUCT_ID },
          }),
        ),
      () =>
        updateLoyalty(
          request('/api/v1/merchant/loyalty', {
            method: 'PATCH',
            body: {
              merchantId: MERCHANT_ID,
              name: 'Market Circle',
              thresholdPoints: '100',
              enabled: true,
            },
          }),
        ),
    ];
    for (const mutation of mutations) await expectFeatureDisabled(mutation());

    const reads = [
      getMerchantProfile(request('/api/v1/merchant/profile')),
      getMerchantMembership(request('/api/v1/merchant/membership')),
      getMerchantSummary(request('/api/v1/merchant/summary')),
      listMerchantOrders(request('/api/v1/merchant/orders')),
      listMerchantProducts(request('/api/v1/merchant/products')),
      getMerchantProduct(
        request(`/api/v1/merchant/products/${PRODUCT_ID}`),
        route('productId', PRODUCT_ID),
      ),
      getCheckoutLink(
        request('/api/v1/checkout-links/existing-link-reference-0001'),
        route('reference', 'existing-link-reference-0001'),
      ),
      getLoyaltyStatus(request('/api/v1/loyalty/status')),
    ];
    for (const read of reads) expect((await read).status).toBe(200);
  });
});

describe('kill-switch recovery and registration', () => {
  it('persists matching post-start results, remains idempotent, and exposes status with flags off', async () => {
    type MutableState = { status: string; providerOperationId: string };
    const payment: MutableState = {
      status: 'submission_started',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const refund: MutableState = {
      status: 'submission_started',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const withdrawal: MutableState = {
      status: 'submission_started',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const splitPayment: MutableState = {
      status: 'submission_started',
      providerOperationId: PROVIDER_OPERATION_ID,
    };
    const transition = (
      state: MutableState,
      body: Readonly<Record<string, unknown>>,
      submittedStatus = 'submitted',
    ) => {
      const requested = body.providerOperationId;
      if (requested !== undefined && requested !== state.providerOperationId) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Provider operation mismatch.');
      }
      const next = body.status === 'submitted' ? submittedStatus : 'submitted_unknown';
      if (state.status === next) return state;
      if (state.status !== 'submission_started') {
        throw new AppError('PAYMENT_ALREADY_SUBMITTED', 'Submission already registered.');
      }
      state.status = next;
      return state;
    };
    const workflow = () => ({
      attempt: payment,
      order: { id: ORDER_ID },
      canonicalOrderPaid:
        payment.status === 'submitted' ? { eventName: 'OrderPaid', canonical: true } : undefined,
    });
    install({
      flags: {},
      commands: {
        recordDelegationEvidence: async () => ({
          ready: true,
          ownerAddress: WALLET,
          universalAccountAddress: WALLET,
        }),
        registerPaymentSubmission: async (
          input: Parameters<BackendApiCommandPort['registerPaymentSubmission']>[0],
        ) => ({ attempt: transition(payment, input.body) }),
        recoverPaymentAttempt: async () => workflow(),
        registerRefundSubmission: async (
          input: Parameters<BackendApiCommandPort['registerRefundSubmission']>[0],
        ) => ({ refund: transition(refund, input.body) }),
        registerWithdrawalSubmission: async (
          input: Parameters<BackendApiCommandPort['registerWithdrawalSubmission']>[0],
        ) => ({
          withdrawal: transition(withdrawal, input.body),
        }),
        registerSplitPaymentSubmission: async (
          input: Parameters<BackendApiCommandPort['registerSplitPaymentSubmission']>[0],
        ) => ({
          payment: transition(splitPayment, input.body, 'confirming'),
        }),
      },
      queries: {
        getPaymentWorkflowForActor: async () => workflow(),
        getCheckoutForActor: async () => ({ session: { productId: PRODUCT_ID } }),
        getPublicProductById: async () => ({
          product: { id: PRODUCT_ID },
          merchant: { id: MERCHANT_ID },
        }),
        getSplitByCapability: async () => ({
          split: { id: SPLIT_ID },
          invitation: { id: 'invitation' },
        }),
        getSponsorGrantForActor: async () => ({ id: GRANT_ID, status: 'submitted_unknown' }),
      },
      resourceQueries: {
        getPaymentRecovery: async () => workflow(),
        getRefund: async () => refund,
        getSettlement: async () => ({ availableBaseUnits: '0' }),
        getWithdrawal: async () => withdrawal,
        getSplitPayment: async () => splitPayment,
      },
    });

    const registrations = [
      () =>
        registerPaymentSubmission(
          request(`/api/v1/payment-attempts/${PAYMENT_ID}/submission`, {
            method: 'POST',
            body: { status: 'submitted', providerOperationId: PROVIDER_OPERATION_ID },
          }),
          route('paymentAttemptId', PAYMENT_ID),
        ),
      () =>
        registerRefundSubmission(
          request(`/api/v1/refunds/${REFUND_ID}/submission`, {
            method: 'POST',
            body: { status: 'submitted', providerOperationId: PROVIDER_OPERATION_ID },
          }),
          route('refundId', REFUND_ID),
        ),
      () =>
        registerWithdrawalSubmission(
          request(`/api/v1/withdrawals/${WITHDRAWAL_ID}/submission`, {
            method: 'POST',
            body: { status: 'submitted', providerOperationId: PROVIDER_OPERATION_ID },
          }),
          route('withdrawalId', WITHDRAWAL_ID),
        ),
      () =>
        registerSplitPaymentSubmission(
          request(`/api/v1/split-payment-attempts/${SPLIT_PAYMENT_ID}/submission`, {
            method: 'POST',
            body: { status: 'submitted', providerOperationId: PROVIDER_OPERATION_ID },
          }),
          route('splitPaymentAttemptId', SPLIT_PAYMENT_ID),
        ),
    ];
    for (const register of registrations) {
      expect((await register()).status).toBe(200);
      expect((await register()).status).toBe(200);
    }

    expect(
      (
        await recordDelegationEvidence(
          request('/api/v1/wallet/delegation/evidence', {
            method: 'POST',
            body: { transactionHash: DIGEST, evidenceDigest: DIGEST },
            key: 'delegation-evidence-after-kill-switch',
          }),
        )
      ).status,
    ).toBe(200);

    const mismatch = await registerPaymentSubmission(
      request(`/api/v1/payment-attempts/${PAYMENT_ID}/submission`, {
        method: 'POST',
        body: { status: 'submitted', providerOperationId: 'different-provider-operation' },
        key: 'mismatched-payment-registration',
      }),
      route('paymentAttemptId', PAYMENT_ID),
    );
    expect(mismatch.status).toBe(409);

    const paymentStatus = await getPaymentAttempt(
      request(`/api/v1/payment-attempts/${PAYMENT_ID}`),
      route('paymentAttemptId', PAYMENT_ID),
    );
    expect(paymentStatus.status).toBe(200);
    await expect(paymentStatus.json()).resolves.toMatchObject({
      canonicalOrderPaid: { eventName: 'OrderPaid', canonical: true },
    });
    expect(
      (
        await recoverPaymentAttempt(
          request(`/api/v1/payment-attempts/${PAYMENT_ID}/recovery`, {
            method: 'POST',
            body: { acknowledgeUnknown: true },
          }),
          route('paymentAttemptId', PAYMENT_ID),
        )
      ).status,
    ).toBe(200);

    const reads = [
      getCheckoutSession(
        request(`/api/v1/checkout-sessions/${CHECKOUT_ID}`),
        route('checkoutSessionId', CHECKOUT_ID),
      ),
      getPaymentRecovery(
        request(`/api/v1/payment-attempts/${PAYMENT_ID}/recovery`),
        route('paymentAttemptId', PAYMENT_ID),
      ),
      getRefund(request(`/api/v1/refunds/${REFUND_ID}`), route('refundId', REFUND_ID)),
      getSettlement(request('/api/v1/merchant/settlement')),
      getWithdrawal(
        request(`/api/v1/withdrawals/${WITHDRAWAL_ID}`),
        route('withdrawalId', WITHDRAWAL_ID),
      ),
      getSplit(
        request('/api/v1/split-links/invitation-segment-0001.capability-token-segment-0001'),
        route('reference', 'invitation-segment-0001.capability-token-segment-0001'),
      ),
      getSplitPayment(
        request(`/api/v1/split-payment-attempts/${SPLIT_PAYMENT_ID}`),
        route('splitPaymentAttemptId', SPLIT_PAYMENT_ID),
      ),
      getBootstrapGrant(
        request(`/api/v1/wallet/bootstrap-gas/grants/${GRANT_ID}`),
        route('grantId', GRANT_ID),
      ),
    ];
    for (const read of reads) expect((await read).status).toBe(200);
  });
});
