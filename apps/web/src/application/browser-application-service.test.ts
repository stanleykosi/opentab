import type { MagicWalletPort, UniversalOperationPort } from '@opentab/application';
import {
  ARBITRUM_ONE_CHAIN_ID,
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
import {
  BrowserApplicationService,
  type ContinuationStore,
  createBrowserIdempotencyKey,
} from './browser-application-service';

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
      certificationStage: 'certified' as const,
      profileDigest: digest,
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
      sourceCallPolicies: [
        {
          policyId: 'base-usdc-test-v1',
          chainId: '8453',
          asset: 'USDC' as const,
          tokenAddress: '0x3333333333333333333333333333333333333333',
          uaType: 'evm',
          target: '0x3333333333333333333333333333333333333333',
          functionSelector: '0x12345678',
          nativeValueAllowed: false,
          maxCalls: 1,
          capturedFixtureDigest: digest,
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

type TestMagicWallet = MagicWalletPort & {
  probeDelegationAuthorizationNonce(input: {
    ownerAddress: EvmAddress;
    implementationAddress: EvmAddress;
  }): Promise<{
    chainId: typeof ARBITRUM_ONE_CHAIN_ID;
    implementationAddress: EvmAddress;
    nonce: string;
  }>;
};

function magicWallet(overrides: Partial<TestMagicWallet> = {}): TestMagicWallet {
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
    getNativeBalanceWei: vi.fn(async () => '1000000000000000'),
    getChainId: vi.fn(async () => '42161'),
    switchToArbitrum: vi.fn(async () => undefined),
    probeDelegationAuthorizationNonce: vi.fn(async (input) => ({
      chainId: ARBITRUM_ONE_CHAIN_ID,
      implementationAddress: input.implementationAddress,
      nonce: '0',
    })),
    authorizeDelegation: vi.fn(),
    submitDelegation: vi.fn(),
    signValidatedRoot: vi.fn(),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

const certificationIntegrationStub = {
  createParticleOperatorCertificationAdapter: () => ({
    captureBootstrap: async (): Promise<never> => {
      throw new Error('Particle certification is not available in this test');
    },
    captureCanaryReady: async (): Promise<never> => {
      throw new Error('Particle certification is not available in this test');
    },
  }),
};

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
  kind: 'merchant_mutation',
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
  it('bounds the full Particle checkout scope to the server idempotency-key contract', () => {
    const nonce = '00000000-0000-4000-8000-000000000000';
    const scope = `particle-certification.checkout.${'a'.repeat(40)}.prd_${'0'.repeat(26)}`;
    const key = createBrowserIdempotencyKey(scope, nonce);

    expect(key).toHaveLength(128);
    expect(key).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(key).toContain('particle-certification.checkout');
    expect(key).toContain(`prd_${'0'.repeat(26)}`);
    expect(key.endsWith(`.${nonce}`)).toBe(true);
  });

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
      ...certificationIntegrationStub,
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
        ...certificationIntegrationStub,
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
        ...certificationIntegrationStub,
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
        ...certificationIntegrationStub,
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
        ...certificationIntegrationStub,
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
        ...certificationIntegrationStub,
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
        ...certificationIntegrationStub,
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

  it('creates the fixed activation item through durable Magic-direct operations without duplicate sends', async () => {
    type BootstrapAction = 'create_merchant' | 'create_product' | 'set_product_active';
    type OperationStatus = ReturnType<typeof contractOperationRecord>['status'];
    const profileScopeId = '0123456789abcdef0123456789abcdef01234567';
    const checkoutAddress = binding.checkoutAddress;
    const operationIds: Record<BootstrapAction, string> = {
      create_merchant: `cop_${'0'.repeat(25)}1`,
      create_product: `cop_${'0'.repeat(25)}2`,
      set_product_active: `cop_${'0'.repeat(25)}3`,
    };
    const transactionHashes: Record<BootstrapAction, `0x${string}`> = {
      create_merchant: `0x${'21'.repeat(32)}`,
      create_product: `0x${'22'.repeat(32)}`,
      set_product_active: `0x${'23'.repeat(32)}`,
    };
    const statuses = new Map<BootstrapAction, OperationStatus>([
      ['create_merchant', 'prepared'],
      ['create_product', 'prepared'],
      ['set_product_active', 'prepared'],
    ]);
    let merchantCreated = false;
    let productCreated = false;
    let productActive = false;
    const events: string[] = [];
    const merchant = (active: boolean) => ({
      id: merchantId,
      ownerUserId: user.id,
      slug: 'opentab-payments-11111111',
      displayName: 'OpenTab Payments',
      supportContact: 'OpenTab payment operator',
      payoutAddress: owner,
      status: active ? ('active' as const) : ('draft' as const),
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:01.000Z',
    });
    const product = () => ({
      id: productId,
      merchantId,
      ...(productCreated ? { onchainProductId: '7' } : {}),
      version: '1',
      slug: 'opentab-payment-activation',
      title: 'OpenTab Payment Activation',
      description: 'The one-time project payment used to verify settlement.',
      unitPriceBaseUnits: '100000',
      maxSupply: '100',
      sold: '0',
      maxPerOrder: '1',
      startsAt: '2025-01-01T00:00:00.000Z',
      refundWindowSeconds: '0',
      loyaltyPoints: '1',
      metadataHash: digest,
      status: productActive
        ? ('active' as const)
        : productCreated
          ? ('publishing' as const)
          : ('draft' as const),
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:01.000Z',
    });
    const bootstrapOperation = (action: BootstrapAction) => {
      const status = statuses.get(action) ?? 'prepared';
      const kind = action === 'create_merchant' ? 'merchant_mutation' : 'product_mutation';
      const operationTemplate = BoundOperationTemplateSchema.parse({
        kind,
        ownerAddress: owner,
        chainId: '42161',
        calls: [{ to: checkoutAddress, data: '0x1234', valueWei: '0' }],
        bindingDigest: digest,
        expiresAt: future,
      });
      return {
        id: operationIds[action],
        kind,
        aggregateType: action === 'create_merchant' ? ('merchant' as const) : ('product' as const),
        aggregateId: action === 'create_merchant' ? merchantId : productId,
        binding: { mutation: { action } },
        template: operationTemplate,
        bindingDigest: digest,
        status,
        ...(status === 'prepared'
          ? {}
          : {
              providerOperationId: `magic-direct:${operationIds[action]}`,
              transactionHash: transactionHashes[action],
            }),
        ...(status === 'confirmed'
          ? {
              canonicalEventName:
                action === 'create_merchant' ? 'MerchantCreated' : 'ProductCreated',
            }
          : {}),
        expiresAt: future,
        createdAt: '2026-07-14T01:00:00.000Z',
        updatedAt: '2026-07-14T01:00:01.000Z',
      };
    };
    const actionForOperationId = (operationId: string): BootstrapAction => {
      const entry = Object.entries(operationIds).find(([, id]) => id === operationId);
      if (entry === undefined) throw new Error(`Unknown operation ${operationId}`);
      return entry[0] as BootstrapAction;
    };
    const certificationStatus = {
      environment: 'demo-mainnet' as const,
      profileScopeId,
      chainId: '42161' as const,
      captureConfig: {
        projectId: 'particle-project',
        projectClientKey: 'particle-client',
        projectAppUuid: 'particle-app',
        arbitrumRpcUrl: 'https://arb.example/rpc',
        checkoutAddress,
        passAddress: '0x5555555555555555555555555555555555555555',
        tokenAddress: '0x3333333333333333333333333333333333333333',
        maximumSlippageBps: 50,
        maximumFeeUsdMicros: '500000',
        delegationPlanTtlSeconds: 120,
        allowedSourceChainIds: ['8453', '42161'],
        allowedSourceAssets: ['USDC'] as const,
        allowedSourceTokens: [],
        useEIP7702: true as const,
      },
      certification: { stage: 'uncertified' as const, subjectMatches: false as const },
      effectiveCapabilities: {
        captureBootstrap: true,
        captureCanaryPreview: false,
        runCanary: false,
        payments: false,
      },
      requestId: 'req_certification_unlock',
    };
    const fetcher = vi.fn<typeof fetch>(async (path, init) => {
      const pathname = String(path);
      const method = init?.method ?? 'GET';
      if (pathname === '/api/v1/auth/session/refresh') return json(session());
      if (pathname === '/api/v1/config/public') {
        return json({ ...publicConfig(), particle: { enabled: false } });
      }
      if (pathname === '/api/v1/operator/particle-certification/unlock') {
        return json(certificationStatus);
      }
      if (pathname === '/api/v1/merchant/profile' && method === 'GET') {
        if (!merchantCreated) {
          return json(
            {
              error: {
                code: 'NOT_FOUND',
                message: 'Merchant not found.',
                retryable: false,
                submissionPossible: false,
                requestId: 'req_merchant_missing',
              },
            },
            404,
          );
        }
        return json({ merchant: merchant(true), requestId: 'req_merchant_profile' });
      }
      if (pathname === '/api/v1/merchant/profile' && method === 'POST') {
        return json(
          {
            merchant: merchant(false),
            operation: bootstrapOperation('create_merchant'),
            requestId: 'req_merchant_create',
          },
          201,
        );
      }
      if (pathname === '/api/v1/merchant/products?limit=100') {
        return json({
          items: productCreated ? [product()] : [],
          requestId: 'req_products_list',
        });
      }
      if (pathname === '/api/v1/merchant/products' && method === 'POST') {
        return json(
          {
            product: product(),
            optimisticVersion: '1',
            operation: bootstrapOperation('create_product'),
            requestId: 'req_product_create',
          },
          202,
        );
      }
      if (pathname === `/api/v1/merchant/products/${productId}`) {
        return json({
          product: product(),
          optimisticVersion: '1',
          chainSyncStatus: productCreated ? 'confirmed' : 'pending',
          operation: bootstrapOperation(productActive ? 'set_product_active' : 'create_product'),
          requestId: 'req_product_detail',
        });
      }
      if (pathname === `/api/v1/merchant/products/${productId}/publish`) {
        return json(
          {
            id: productId,
            status: 'publishing',
            operation: bootstrapOperation('set_product_active'),
            requestId: 'req_product_publish',
          },
          202,
        );
      }
      const operationMatch =
        /^\/api\/v1\/contract-operations\/(cop_[0-9A-HJKMNP-TV-Z]{26})(\/submission)?$/.exec(
          pathname,
        );
      if (operationMatch !== null) {
        const action = actionForOperationId(operationMatch[1] ?? '');
        if (operationMatch[2] === '/submission') {
          const body = JSON.parse(String(init?.body)) as {
            status: OperationStatus;
            providerOperationId: string;
            transactionHash?: string;
          };
          events.push(`server:${action}:${body.status}`);
          if (body.status !== 'submission_started') {
            expect(body.transactionHash).toBe(transactionHashes[action]);
          }
          statuses.set(action, body.status);
          return json({ operation: bootstrapOperation(action), requestId: 'req_operation_submit' });
        }
        if (statuses.get(action) === 'submitted') {
          statuses.set(action, 'confirmed');
          if (action === 'create_merchant') merchantCreated = true;
          if (action === 'create_product') productCreated = true;
          if (action === 'set_product_active') productActive = true;
        }
        return json({ operation: bootstrapOperation(action), requestId: 'req_operation_get' });
      }
      throw new Error(`Unexpected test request: ${method} ${pathname}`);
    });
    const submitOperatorBootstrapMutation = vi.fn(async (input: { action: BootstrapAction }) => {
      events.push(`magic:${input.action}`);
      return { transactionHash: transactionHashes[input.action] };
    });
    const wallet = {
      ...magicWallet(),
      submitOperatorBootstrapMutation,
    };
    const service = new BrowserApplicationService({
      api: new BrowserApiClient({ fetcher }),
      loadIntegrations: async () => ({
        createCheckoutOperationTemplate: () => template,
        digestUnknown: () => digest as EvidenceDigest,
        validateBrowserContractOperation: (input) => input.template,
        createMagicBrowserWallet: () => wallet,
        createParticleUniversalAccountAdapter: () => universalAccount(),
        ...certificationIntegrationStub,
      }),
      continuationStore: continuationStore(),
      origin: () => 'https://opentab.example',
      wait: async () => undefined,
    });

    const first = await service.bootstrapParticleCertificationCanary({
      operatorToken: 'o'.repeat(48),
    });
    const second = await service.bootstrapParticleCertificationCanary({
      operatorToken: 'o'.repeat(48),
    });

    expect(first).toMatchObject({ ownerAddress: owner, product: { status: 'active' } });
    expect(second.product.id).toBe(first.product.id);
    expect(events).toEqual([
      'server:create_merchant:submission_started',
      'magic:create_merchant',
      'server:create_merchant:submitted',
      'server:create_product:submission_started',
      'magic:create_product',
      'server:create_product:submitted',
      'server:set_product_active:submission_started',
      'magic:set_product_active',
      'server:set_product_active:submitted',
    ]);
    expect(submitOperatorBootstrapMutation).toHaveBeenCalledTimes(3);
    expect(wallet.getNativeBalanceWei).toHaveBeenCalledTimes(3);
  });
});
