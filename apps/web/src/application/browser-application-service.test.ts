import type { MagicWalletPort, UniversalOperationPort } from '@opentab/application';
import {
  BoundOperationTemplateSchema,
  CheckoutBindingSchema,
  type CurrentUser,
  type EvidenceDigest,
  type EvmAddress,
  ProviderOperationIdSchema,
  ValidatedOperationPlanSchema,
} from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { BrowserApiClient } from './browser-api-client';
import { BrowserApplicationService, type ContinuationStore } from './browser-application-service';

const owner = '0x1111111111111111111111111111111111111111' as EvmAddress;
const digest = `0x${'1'.repeat(64)}`;
const user: CurrentUser = {
  id: 'usr_00000000000000000000000000' as CurrentUser['id'],
  walletAddress: owner,
  authMethod: 'google',
  status: 'active',
  merchantMemberships: [],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function publicConfig(provenance: 'deterministic' | 'recorded_live' = 'recorded_live') {
  return {
    applicationReleaseId: '0123456789abcdef0123456789abcdef01234567',
    ...(provenance === 'recorded_live' ? { liveAcceptanceConfigDigest: digest } : {}),
    environment: 'demo-mainnet',
    magic: { publishableKey: 'pk_live_browser_test', rpcUrl: 'https://arb.example/rpc' },
    challenge: { turnstileSiteKey: 'turnstile-site-key-test' },
    particle: {
      enabled: true as const,
      projectId: 'particle-project',
      projectClientKey: 'particle-client',
      projectAppUuid: 'particle-app',
      expectedImplementationAddress: '0x2222222222222222222222222222222222222222',
      expectedImplementationCodeHash: digest,
      slippageBps: 50,
      maxFeeUsdMicros: '500000',
      allowedSourceChainIds: ['8453', '42161'],
      allowedSourceAssets: ['USDC'] as const,
      allowedSourceTokens: [
        {
          chainId: '8453',
          asset: 'USDC' as const,
          address: '0x3333333333333333333333333333333333333333',
        },
      ],
      sourceCallProfiles: [
        {
          profileId: 'base-usdc-test-v1',
          chainId: '8453',
          asset: 'USDC' as const,
          tokenAddress: '0x3333333333333333333333333333333333333333',
          sourceAmount: '1',
          fixtureDigest: digest,
          calls: [
            {
              uaType: 'evm',
              to: '0x3333333333333333333333333333333333333333',
              data: '0x1234',
              valueWei: '0',
            },
          ],
        },
      ],
      responseProfile: {
        profileId: 'recorded-live-v1',
        provenance,
        deploymentsFixtureDigest: digest,
        authFixtureDigest: digest,
        submissionFixtureDigest: digest,
        statusFixtureDigest: digest,
        magicAuthorizationNonceOffset: 0 as const,
        delegationPlanTtlSeconds: 120,
      },
    },
    media: { allowedOrigins: ['https://opentab.example'] },
    features: {
      checkout: true,
      bootstrapGas: true,
      splits: false,
      loyalty: true,
      judgeMode: true,
    },
    requestId: 'req_config_test',
  };
}

function session(returnPath?: string) {
  return {
    user,
    csrfToken: 'c'.repeat(32),
    expiresAt: '2026-07-14T02:00:00.000Z',
    ...(returnPath === undefined ? {} : { returnPath }),
    requestId: 'req_session_test',
  };
}

function continuationStore(): ContinuationStore & { value: string | undefined } {
  return {
    value: undefined,
    get() {
      return this.value;
    },
    set(value) {
      this.value = value;
    },
    clear() {
      this.value = undefined;
    },
  };
}

function magicWallet(overrides: Partial<MagicWalletPort> = {}): MagicWalletPort {
  return {
    loginWithGoogle: vi.fn(async () => undefined),
    completeGoogleRedirect: vi.fn(async () => ({
      didToken: 'magic-google-did-token-test',
      authMethod: 'google' as const,
    })),
    loginWithEmailOtp: vi.fn(async () => ({
      didToken: 'magic-email-did-token-test',
      authMethod: 'email_otp' as const,
    })),
    getOwnerAddress: vi.fn(async () => owner),
    getChainId: vi.fn(async () => '42161'),
    switchToArbitrum: vi.fn(async () => undefined),
    authorizeDelegation: vi.fn(),
    submitDelegation: vi.fn(),
    signValidatedRoot: vi.fn(),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

const checkoutSessionId = `chk_${'0'.repeat(26)}`;
const paymentAttemptId = `pay_${'0'.repeat(26)}`;
const orderId = `ord_${'0'.repeat(26)}`;
const productId = `prd_${'0'.repeat(26)}`;
const merchantId = `mer_${'0'.repeat(26)}`;
const providerOperationId = ProviderOperationIdSchema.parse('particle-operation-live-1');
const future = '2027-07-14T02:00:00.000Z';
const contractOperationId = `cop_${'0'.repeat(26)}`;

const binding = CheckoutBindingSchema.parse({
  checkoutSessionId,
  attemptId: paymentAttemptId,
  orderId,
  orderIntent: {
    orderKey: digest,
    payer: owner,
    recipient: owner,
    merchantOnchainId: '1',
    productOnchainId: '1',
    productVersion: '1',
    token: '0x3333333333333333333333333333333333333333',
    amountBaseUnits: '18000000',
    platformFeeBps: '100',
    platformFeeBaseUnits: '180000',
    quantity: '1',
    validAfter: '1783987200',
    validUntil: '1815616800',
    refundDeadline: '1815703200',
    metadataHash: digest,
  },
  orderIntentDigest: digest,
  orderIntentSignature: '0x12',
  signerKeyId: 'orders-live-v1',
  chainId: '42161',
  usdcAddress: '0x3333333333333333333333333333333333333333',
  checkoutAddress: '0x4444444444444444444444444444444444444444',
  expiresAt: future,
  bindingDigest: digest,
});

const template = BoundOperationTemplateSchema.parse({
  kind: 'checkout',
  ownerAddress: owner,
  chainId: '42161',
  calls: [{ to: binding.checkoutAddress, data: '0x12', valueWei: '0' }],
  bindingDigest: digest,
  expiresAt: future,
});

const validatedPlan = ValidatedOperationPlanSchema.parse({
  planId: digest,
  template,
  rootHash: digest,
  quote: {
    amountBaseUnits: '18000000',
    estimatedFeeUsd: '0.14',
    totalUsd: '18.14',
    slippageBps: '50',
    sources: [{ chainId: '42161', symbol: 'USDC', amount: '18.14', amountUsd: '18.14' }],
    quotedAt: '2026-07-14T01:00:00.000Z',
    expiresAt: future,
  },
  validatedAt: '2026-07-14T01:00:01.000Z',
  expiresAt: future,
});

const merchantMutationTemplate = BoundOperationTemplateSchema.parse({
  kind: 'product_mutation',
  ownerAddress: owner,
  chainId: '42161',
  calls: [{ to: binding.checkoutAddress, data: '0x34', valueWei: '0' }],
  bindingDigest: digest,
  expiresAt: future,
});

function contractOperationRecord(
  status:
    | 'prepared'
    | 'submission_started'
    | 'submitted'
    | 'submitted_unknown'
    | 'confirming'
    | 'confirmed'
    | 'failed'
    | 'orphaned' = 'prepared',
) {
  return {
    id: contractOperationId,
    kind: 'merchant_mutation' as const,
    aggregateType: 'merchant' as const,
    aggregateId: merchantId,
    binding: { ownerAddress: owner, action: 'create_merchant' },
    template: merchantMutationTemplate,
    bindingDigest: digest as EvidenceDigest,
    status,
    ...(status === 'prepared' ? {} : { providerOperationId }),
    expiresAt: future,
    createdAt: '2026-07-14T01:00:00.000Z',
    updatedAt: '2026-07-14T01:00:02.000Z',
  };
}

function attemptRecord(status: string) {
  return {
    id: paymentAttemptId,
    orderId,
    checkoutSessionId,
    attemptNumber: '1',
    status,
    bindingDigest: digest,
    ...(status === 'created' ? {} : { providerOperationId }),
    ...(status === 'prepared' ? { preparedExpiresAt: future } : {}),
    reconciliationRequired: [
      'submission_started',
      'submitted',
      'submitted_unknown',
      'executing',
      'confirming',
    ].includes(status),
    createdAt: '2026-07-14T01:00:00.000Z',
    updatedAt: '2026-07-14T01:00:02.000Z',
  };
}

function orderRecord(status = 'created') {
  return {
    id: orderId,
    checkoutSessionId,
    orderKey: digest,
    userId: user.id,
    merchantId,
    productId,
    payer: owner,
    recipient: owner,
    quantity: '1',
    amountBaseUnits: '18000000',
    paidAmountBaseUnits: '0',
    refundedAmountBaseUnits: '0',
    status,
    ...(status === 'created' ? {} : { providerOperationId }),
    refundableUntil: future,
    createdAt: '2026-07-14T01:00:00.000Z',
    updatedAt: '2026-07-14T01:00:02.000Z',
  };
}

function universalAccount(overrides: Partial<UniversalOperationPort> = {}): UniversalOperationPort {
  return {
    getAccount: vi.fn(async () => ({
      ownerAddress: owner,
      evmAddress: owner,
      protocolVersion: '2.0.3',
      eip7702: true as const,
    })),
    getUnifiedBalance: vi.fn(),
    getDelegation: vi.fn(),
    prepareDelegation: vi.fn(),
    prepareOperation: vi.fn(async () => ({
      kind: 'checkout' as const,
      rawSchemaVersion: 'particle-sdk-2.0.3-prepared-v1',
      rootHash: validatedPlan.rootHash,
      providerOperationId,
      quotedAt: validatedPlan.quote.quotedAt,
      expiresAt: future,
      redactedPayloadDigest: digest as EvidenceDigest,
    })),
    validateOperation: vi.fn(async () => validatedPlan),
    submitValidated: vi.fn(async () => ({
      id: providerOperationId as never,
      status: 'preparing' as const,
      submissionPossible: true,
      updatedAt: '2026-07-14T01:00:03.000Z',
      evidence: {
        adapter: 'particle-send-transaction',
        packageVersion: '2.0.3',
        schemaVersion: 1,
        environment: 'demo-mainnet',
        observedAt: '2026-07-14T01:00:03.000Z',
        evidenceDigest: digest as EvidenceDigest,
        provenance: 'recorded_live' as const,
      },
    })),
    getOperation: vi.fn(),
    ...overrides,
  };
}

function checkoutFetcher() {
  let status = 'created';
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    const pathname = String(path);
    if (pathname === '/api/v1/auth/session/refresh') return json(session());
    if (pathname === '/api/v1/config/public') return json(publicConfig());
    if (pathname.endsWith('/payment-attempts')) {
      status = 'created';
      return json({ binding, requestId: 'req_attempt_test' }, 201);
    }
    if (pathname.endsWith('/prepared')) {
      status = 'prepared';
      return json({ attempt: attemptRecord(status), requestId: 'req_prepared_test' });
    }
    if (pathname.endsWith('/submission/start')) {
      status = 'submission_started';
      return json({ attempt: attemptRecord(status), requestId: 'req_start_test' });
    }
    if (pathname.endsWith('/submission')) {
      const body = JSON.parse(String(init?.body)) as { status: string };
      status = body.status;
      return json({ attempt: attemptRecord(status), requestId: 'req_register_test' });
    }
    if (pathname === `/api/v1/payment-attempts/${paymentAttemptId}`) {
      return json({
        attempt: attemptRecord(status),
        order: orderRecord(status === 'submitted' ? 'submitted' : 'created'),
        requestId: 'req_workflow_test',
      });
    }
    throw new Error(`Unexpected test request: ${pathname}`);
  });
  return {
    fetcher,
    setStatus(next: string) {
      status = next;
    },
  };
}

describe('browser application service boundaries', () => {
  it('restores the server session without importing wallet integrations', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(session()));
    const loader = vi.fn();
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: loader,
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
    });

    await expect(service.restoreSession()).resolves.toMatchObject({ user });
    expect(loader).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/auth/session/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store' }),
    );
  });

  it('loads Magic only after explicit Google intent and keeps only the continuation ID', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          continuationId: 'continuation_google_test',
          expiresAt: '2026-07-14T01:40:00.000Z',
          requestId: 'req_continuation_test',
        }),
      )
      .mockResolvedValueOnce(
        json({
          ...publicConfig(),
          particle: { enabled: false },
        }),
      );
    const wallet = magicWallet();
    const loader = vi.fn(async () => ({
      createCheckoutOperationTemplate: () => {
        throw new Error('not used');
      },
      digestUnknown: () => digest as EvidenceDigest,
      createMagicBrowserWallet: () => wallet,
      createParticleUniversalAccountAdapter: vi.fn<() => UniversalOperationPort>(),
    }));
    const storage = continuationStore();
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: loader,
      continuationStore: storage,
      origin: () => 'https://opentab.example',
    });

    expect(loader).not.toHaveBeenCalled();
    await service.beginGoogleSignIn('/checkout/chk_live_test');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(storage.value).toBe('continuation_google_test');
    expect(wallet.loginWithGoogle).toHaveBeenCalledWith({
      continuationId: 'continuation_google_test',
      redirectUri: 'https://opentab.example/auth/callback',
    });
  });

  it('exchanges the Google proof, verifies wallet continuity, and clears continuation state', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(publicConfig()))
      .mockResolvedValueOnce(json(session('/checkout/chk_live_test')));
    const storage = continuationStore();
    storage.value = 'continuation_google_test';
    const wallet = magicWallet();
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: async () => ({
        createCheckoutOperationTemplate: () => {
          throw new Error('not used');
        },
        digestUnknown: () => digest as EvidenceDigest,
        createMagicBrowserWallet: () => wallet,
        createParticleUniversalAccountAdapter: vi.fn<() => UniversalOperationPort>(),
      }),
      continuationStore: storage,
      origin: () => 'https://opentab.example',
    });

    await expect(service.completeGoogleSignIn()).resolves.toMatchObject({
      returnPath: '/checkout/chk_live_test',
    });
    expect(storage.value).toBeUndefined();
    const exchange = fetcher.mock.calls.find(([path]) => path === '/api/v1/auth/session');
    expect(exchange?.[1]?.body).toBe(
      JSON.stringify({
        didToken: 'magic-google-did-token-test',
        continuationId: 'continuation_google_test',
      }),
    );
  });

  it('restores and logs out through the server session before logging out Magic', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(session()))
      .mockResolvedValueOnce(json({ revoked: true, requestId: 'req_logout_test' }))
      .mockResolvedValueOnce(json(publicConfig()));
    const wallet = magicWallet();
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: async () => ({
        createCheckoutOperationTemplate: () => template,
        digestUnknown: () => digest as EvidenceDigest,
        createMagicBrowserWallet: () => wallet,
        createParticleUniversalAccountAdapter: () => universalAccount(),
      }),
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
    });

    await service.restoreSession();
    await service.logout();

    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v1/auth/session');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('DELETE');
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe(
      'c'.repeat(32),
    );
    expect(wallet.logout).toHaveBeenCalledTimes(1);
  });

  it('accepts deterministic public config but refuses to import or instantiate live SDKs', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          continuationId: 'continuation_deterministic_test',
          expiresAt: future,
          requestId: 'req_continuation_test',
        }),
      )
      .mockResolvedValueOnce(json(publicConfig('deterministic')));
    const loader = vi.fn();
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: loader,
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
    });

    await expect(service.beginGoogleSignIn('/')).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it('fails closed when a production-like config omits exact source-token contracts', async () => {
    const config = publicConfig();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({
        ...config,
        particle: { ...config.particle, allowedSourceTokens: [] },
      }),
    );
    const loader = vi.fn();
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: loader,
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
    });

    await expect(service.getUniversalAccount(owner)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it('persists the provider ID before signing and coalesces duplicate submit intents', async () => {
    const transport = checkoutFetcher();
    const account = universalAccount();
    const wallet = magicWallet({
      signValidatedRoot: vi.fn(async () => ({ signature: '0x12', recoveredOwner: owner })),
    });
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher: transport.fetcher }),
      loadIntegrations: async () => ({
        createCheckoutOperationTemplate: () => template,
        digestUnknown: () => digest as EvidenceDigest,
        createMagicBrowserWallet: () => wallet,
        createParticleUniversalAccountAdapter: () => account,
      }),
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
      createIdempotencyKey: (scope) => `test.${scope}`.slice(0, 120).padEnd(16, '0'),
    });

    await service.prepareCheckoutPayment(checkoutSessionId);
    const [first, second] = await Promise.all([
      service.submitCheckoutPayment(paymentAttemptId),
      service.submitCheckoutPayment(paymentAttemptId),
    ]);

    expect(first.kind).toBe('submitted');
    expect(second.kind).toBe('submitted');
    expect(account.submitValidated).toHaveBeenCalledTimes(1);
    expect(wallet.signValidatedRoot).toHaveBeenCalledTimes(1);
    expect(
      transport.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/submission/start')),
    ).toHaveLength(1);
    const preparedIndex = transport.fetcher.mock.calls.findIndex(([path]) =>
      String(path).endsWith('/prepared'),
    );
    const signOrder = vi.mocked(wallet.signValidatedRoot).mock.invocationCallOrder[0];
    expect(transport.fetcher.mock.invocationCallOrder[preparedIndex]).toBeLessThan(signOrder ?? 0);
  });

  it('recovers a prepared reload without reconstructing or resubmitting provider state', async () => {
    const transport = checkoutFetcher();
    transport.setStatus('prepared');
    const loader = vi.fn();
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher: transport.fetcher }),
      loadIntegrations: loader,
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
    });

    await expect(service.submitCheckoutPayment(paymentAttemptId)).rejects.toMatchObject({
      code: 'PAYMENT_PREVIEW_RELOAD_REQUIRED',
    });
    expect(loader).not.toHaveBeenCalled();
    expect(
      transport.fetcher.mock.calls.filter(([path]) => String(path).includes('/submission')),
    ).toHaveLength(0);
  });

  it('lets a cross-tab lock/server winner proceed while the losing tab only recovers status', async () => {
    const transport = checkoutFetcher();
    const account = universalAccount();
    const wallet = magicWallet({
      signValidatedRoot: vi.fn(async () => ({ signature: '0x12', recoveredOwner: owner })),
    });
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher: transport.fetcher }),
      loadIntegrations: async () => ({
        createCheckoutOperationTemplate: () => template,
        digestUnknown: () => digest as EvidenceDigest,
        createMagicBrowserWallet: () => wallet,
        createParticleUniversalAccountAdapter: () => account,
      }),
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
      createIdempotencyKey: (scope) => `test.${scope}`.slice(0, 120).padEnd(16, '0'),
      submissionLock: {
        async run() {
          // Another tab owns the browser lock and has already won the
          // authoritative server start transition.
          transport.setStatus('submission_started');
          return { acquired: false as const };
        },
      },
    });

    await service.prepareCheckoutPayment(checkoutSessionId);
    const result = await service.submitCheckoutPayment(paymentAttemptId);

    expect(result).toMatchObject({
      kind: 'already_started',
      workflow: { attempt: { status: 'submission_started' } },
    });
    expect(wallet.signValidatedRoot).not.toHaveBeenCalled();
    expect(account.submitValidated).not.toHaveBeenCalled();
    expect(
      transport.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/submission/start')),
    ).toHaveLength(0);
  });

  it('keeps the do-not-repeat boundary when status reload fails after server start', async () => {
    const transport = checkoutFetcher();
    let startRecorded = false;
    const fetcher = vi.fn<typeof fetch>(async (path, init) => {
      const pathname = String(path);
      if (startRecorded && pathname === `/api/v1/payment-attempts/${paymentAttemptId}`) {
        throw new Error('status network unavailable');
      }
      const response = await transport.fetcher(path, init);
      if (pathname.endsWith('/submission/start')) startRecorded = true;
      return response;
    });
    const account = universalAccount({
      submitValidated: vi.fn(async () => {
        throw new Error('provider response unavailable');
      }),
    });
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: async () => ({
        createCheckoutOperationTemplate: () => template,
        digestUnknown: () => digest as EvidenceDigest,
        createMagicBrowserWallet: () =>
          magicWallet({
            signValidatedRoot: vi.fn(async () => ({
              signature: '0x12',
              recoveredOwner: owner,
            })),
          }),
        createParticleUniversalAccountAdapter: () => account,
      }),
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
      createIdempotencyKey: (scope) => `test.${scope}`.slice(0, 120).padEnd(16, '0'),
    });

    await service.prepareCheckoutPayment(checkoutSessionId);
    await expect(service.submitCheckoutPayment(paymentAttemptId)).rejects.toMatchObject({
      code: 'PAYMENT_SUBMITTED_UNKNOWN',
      submissionPossible: true,
    });
    expect(account.submitValidated).toHaveBeenCalledTimes(1);
  });

  it('validates a bound contract operation and persists its provider ID before sending it', async () => {
    let status: ReturnType<typeof contractOperationRecord>['status'] = 'prepared';
    const events: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (path, init) => {
      const pathname = String(path);
      if (pathname === '/api/v1/auth/session/refresh') return json(session());
      if (pathname === '/api/v1/config/public') return json(publicConfig());
      if (pathname === `/api/v1/contract-operations/${contractOperationId}`) {
        return json({ operation: contractOperationRecord(status), requestId: 'req_contract_get' });
      }
      if (pathname === `/api/v1/contract-operations/${contractOperationId}/submission`) {
        const body = JSON.parse(String(init?.body)) as {
          status: typeof status;
          providerOperationId: string;
        };
        expect(body.providerOperationId).toBe(providerOperationId);
        events.push(`server:${body.status}`);
        status = body.status;
        return json({
          operation: contractOperationRecord(status),
          requestId: 'req_contract_submit',
        });
      }
      throw new Error(`Unexpected test request: ${pathname}`);
    });
    const account = universalAccount({
      prepareOperation: vi.fn(async () => ({
        kind: 'product_mutation' as const,
        rawSchemaVersion: 'particle-sdk-2.0.3-prepared-v1',
        rootHash: validatedPlan.rootHash,
        providerOperationId,
        quotedAt: validatedPlan.quote.quotedAt,
        expiresAt: future,
        redactedPayloadDigest: digest as EvidenceDigest,
      })),
      validateOperation: vi.fn(async () => ({
        ...validatedPlan,
        template: merchantMutationTemplate,
      })),
      submitValidated: vi.fn(async () => {
        events.push('provider:send');
        return {
          id: providerOperationId as never,
          status: 'preparing' as const,
          submissionPossible: true,
          updatedAt: '2026-07-14T01:00:03.000Z',
          evidence: {
            adapter: 'particle-send-transaction',
            packageVersion: '2.0.3',
            schemaVersion: 1,
            environment: 'demo-mainnet',
            observedAt: '2026-07-14T01:00:03.000Z',
            evidenceDigest: digest as EvidenceDigest,
            provenance: 'recorded_live' as const,
          },
        };
      }),
    });
    const wallet = magicWallet({
      signValidatedRoot: vi.fn(async () => ({ signature: '0x12', recoveredOwner: owner })),
    });
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: async () => ({
        createCheckoutOperationTemplate: () => template,
        digestUnknown: () => digest as EvidenceDigest,
        validateBrowserContractOperation: () => merchantMutationTemplate,
        createMagicBrowserWallet: () => wallet,
        createParticleUniversalAccountAdapter: () => account,
      }),
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
      createIdempotencyKey: (scope) => `test.${scope}`.slice(0, 120).padEnd(16, '0'),
    });

    const preview = await service.prepareContractOperation(contractOperationRecord());
    expect(preview.providerOperationId).toBe(providerOperationId);
    const result = await service.submitContractOperation(contractOperationId);

    expect(result.kind).toBe('submitted');
    expect(events).toEqual(['server:submission_started', 'provider:send', 'server:submitted']);
    expect(account.submitValidated).toHaveBeenCalledTimes(1);
  });
});
