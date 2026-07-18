import type { MagicWalletPort, UniversalOperationPort } from '@opentab/application';
import type { BrowserContractOperationValidationInput } from '@opentab/integrations/browser';
import {
  AppError,
  type BoundOperationTemplate,
  type Bytes32,
  Bytes32Schema,
  type CheckoutBinding,
  type CurrentUser,
  type EvidenceDigest,
  type EvmAddress,
  EvmAddressSchema,
  type ParticleCompatibilityProfile,
  type ProviderOperation,
  sameEvmAddress,
  TransactionHashSchema,
  type UnifiedBalance,
  type ValidatedOperationPlan,
} from '@opentab/shared';
import {
  type BootstrapEligibilityResponse,
  BrowserApiClient,
  BrowserApiError,
  type BrowserSession,
  type CheckoutSnapshotResponse,
  type ContractOperationRecord,
  type MerchantProductListResponse,
  type ParticleCertificationStatus,
  type PaymentWorkflowResponse,
  type PublicBrowserConfig,
  type WalletReadinessResponse,
} from './browser-api-client';

const CONTINUATION_STORAGE_KEY = 'opentab.auth.continuation';
const RELEASE_CANARY_PRODUCT_SLUG = 'opentab-release-canary';
const RELEASE_CANARY_PRICE_BASE_UNITS = '100000';
const RELEASE_CANARY_MAX_PRICE_BASE_UNITS = 100_000n;

type OperatorBootstrapAction = 'create_merchant' | 'create_product' | 'set_product_active';

interface BrowserIntegrationModule {
  createCheckoutOperationTemplate(binding: CheckoutBinding): ValidatedOperationPlan['template'];
  digestUnknown(value: unknown): EvidenceDigest;
  validateBrowserContractOperation?(
    input: BrowserContractOperationValidationInput,
  ): BoundOperationTemplate;
  createMagicBrowserWallet(config: {
    publishableKey: string;
    environment: string;
    allowedRedirectUris: readonly string[];
    rpcNetworks: readonly { chainId: number; rpcUrl: string; default?: boolean }[];
  }): MagicWallet;
  createParticleUniversalAccountAdapter(config: {
    projectId: string;
    projectClientKey: string;
    projectAppUuid: string;
    ownerAddress: EvmAddress;
    expectedImplementationAddress: EvmAddress;
    expectedImplementationCodeHash: `0x${string}`;
    environment: string;
    slippageBps: number;
    maxFeeUsdMicros: bigint;
    allowedSourceChainIds: readonly string[];
    allowedSourceAssets: readonly ('USDC' | 'USDT' | 'ETH')[];
    allowedSourceTokens: readonly {
      readonly chainId: string;
      readonly asset: 'USDC' | 'USDT' | 'ETH';
      readonly address: EvmAddress;
    }[];
    sourceCallPolicies: readonly {
      readonly policyId: string;
      readonly chainId: string;
      readonly asset: 'USDC' | 'USDT' | 'ETH';
      readonly tokenAddress: EvmAddress;
      readonly uaType: string;
      readonly target: EvmAddress;
      readonly functionSelector: `0x${string}`;
      readonly nativeValueAllowed: boolean;
      readonly maxCalls: number;
      readonly capturedFixtureDigest: Bytes32;
    }[];
    responseProfile: {
      profileId: string;
      provenance: 'recorded_live';
      certificationStage: 'canary_ready' | 'certified';
      deploymentsFixtureDigest: `0x${string}`;
      authFixtureDigest: `0x${string}`;
      submissionFixtureDigest?: `0x${string}`;
      statusFixtureDigest?: `0x${string}`;
      magicAuthorizationNonceOffset: 0 | 1;
      delegationPlanTtlSeconds: number;
    };
    rpcUrl?: string;
  }): UniversalOperationPort;
  createParticleOperatorCertificationAdapter(config: {
    profileId: string;
    environment: 'demo-mainnet' | 'production';
    projectId: string;
    projectClientKey: string;
    projectAppUuid: string;
    ownerAddress: EvmAddress;
    magic: {
      getOwnerAddress(): Promise<EvmAddress>;
      getChainId(): Promise<string>;
      switchToArbitrum(): Promise<void>;
      probeDelegationAuthorizationNonce(input: {
        ownerAddress: EvmAddress;
        implementationAddress: EvmAddress;
      }): Promise<{
        chainId: '42161';
        implementationAddress: EvmAddress;
        nonce: string;
      }>;
    };
    arbitrumRpcUrl: string;
    allowedArbitrumRpcOrigins: readonly string[];
    allowedSourceChainIds: readonly string[];
    allowedSourceAssets: readonly ('USDC' | 'USDT' | 'ETH')[];
    slippageBps: number;
    delegationPlanTtlSeconds: number;
    particleRpcUrl?: string;
  }): {
    captureBootstrap(): Promise<{ profile: ParticleCompatibilityProfile }>;
    captureCanaryReady(binding: CheckoutBinding): Promise<{
      profile: ParticleCompatibilityProfile;
      preparedFixtureDigest: Bytes32;
    }>;
  };
}

type MagicWallet = MagicWalletPort & {
  probeDelegationAuthorizationNonce(input: {
    ownerAddress: EvmAddress;
    implementationAddress: EvmAddress;
  }): Promise<{ chainId: '42161'; implementationAddress: EvmAddress; nonce: string }>;
  submitOperatorBootstrapMutation?(input: {
    readonly template: BoundOperationTemplate;
    readonly action: OperatorBootstrapAction;
    readonly checkoutAddress: EvmAddress;
  }): Promise<{ readonly transactionHash: string }>;
};
type UniversalAccount = UniversalOperationPort;

type IntegrationLoader = () => Promise<BrowserIntegrationModule>;

export interface SubmissionLock {
  run<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
}

interface WebLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: object | null) => Promise<{ acquired: false } | { acquired: true; value: T }>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
}

function browserSubmissionLock(): SubmissionLock {
  return {
    async run<T>(name: string, operation: () => Promise<T>) {
      const manager = (globalThis.navigator as Navigator & { locks?: WebLockManager }).locks;
      if (manager === undefined) return { acquired: true, value: await operation() };
      return manager.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) =>
        lock === null ? { acquired: false } : { acquired: true, value: await operation() },
      );
    },
  };
}

export interface ContinuationStore {
  get(): string | undefined;
  set(value: string): void;
  clear(): void;
}

function browserContinuationStore(): ContinuationStore {
  return {
    get: () => window.sessionStorage.getItem(CONTINUATION_STORAGE_KEY) ?? undefined,
    set: (value) => window.sessionStorage.setItem(CONTINUATION_STORAGE_KEY, value),
    clear: () => window.sessionStorage.removeItem(CONTINUATION_STORAGE_KEY),
  };
}

function normalizeReturnPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 512) return '/';
  return value;
}

function asHexDigest(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new BrowserApiError({
      code: 'CONFIGURATION_INVALID',
      message: 'The browser integration configuration is invalid.',
      status: 0,
    });
  }
  return value as `0x${string}`;
}

function asBytes32(value: string): Bytes32 {
  return Bytes32Schema.parse(value);
}

function isSubmissionBoundaryStatus(status: PaymentWorkflowResponse['attempt']['status']): boolean {
  return [
    'submission_started',
    'submitted',
    'submitted_unknown',
    'executing',
    'confirming',
    'paid',
    'failed_confirmed',
  ].includes(status);
}

function decimalUsdToMicros(value: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) {
    throw new BrowserApiError({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
      message: 'The payment cost was not a valid decimal amount.',
      status: 0,
    });
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(6, '0').slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString();
}

function idempotencyKey(scope: string): string {
  return `web.${scope}.${globalThis.crypto.randomUUID()}`;
}

function certificationIdempotencyKey(
  profileScopeId: string,
  scope: string,
  reference: string,
): string {
  const value = `opentab.cert.${profileScopeId}.${scope}.${reference}`;
  if (value.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new BrowserApiError({
      code: 'CONFIGURATION_INVALID',
      message: 'The Particle certification reference is invalid.',
      status: 0,
    });
  }
  return value;
}

function bootstrapAction(operation: ContractOperationRecord): OperatorBootstrapAction {
  const mutation = operation.binding.mutation;
  if (typeof mutation !== 'object' || mutation === null || !('action' in mutation)) {
    throw new BrowserApiError({
      code: 'OPERATION_PLAN_INVALID',
      message: 'The canary operation omitted its exact contract action.',
      status: 0,
    });
  }
  const action = (mutation as Readonly<Record<string, unknown>>).action;
  if (
    action !== 'create_merchant' &&
    action !== 'create_product' &&
    action !== 'set_product_active'
  ) {
    throw new BrowserApiError({
      code: 'OPERATION_PLAN_INVALID',
      message: 'The canary operation is not an allowed bootstrap action.',
      status: 0,
    });
  }
  return action;
}

export interface BrowserApplicationServiceOptions {
  api?: BrowserApiClient;
  loadIntegrations?: IntegrationLoader;
  continuationStore?: ContinuationStore;
  origin?: () => string;
  submissionLock?: SubmissionLock;
  createIdempotencyKey?: (scope: string) => string;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface PreparedCheckoutPayment {
  readonly binding: CheckoutBinding;
  readonly plan: ValidatedOperationPlan;
  readonly providerOperationId: string;
}

export type PaymentSubmissionResult =
  | {
      readonly kind: 'submitted';
      readonly operation: ProviderOperation;
      readonly workflow: PaymentWorkflowResponse;
    }
  | {
      readonly kind: 'submitted_unknown' | 'already_started';
      readonly workflow: PaymentWorkflowResponse;
    };

export interface PreparedContractOperation {
  readonly operation: ContractOperationRecord;
  readonly plan: ValidatedOperationPlan;
  readonly providerOperationId: string;
}

export interface CertificationCanaryBootstrapResult {
  readonly ownerAddress: EvmAddress;
  readonly product: MerchantProductListResponse['items'][number];
}

export type ContractOperationSubmissionResult =
  | {
      readonly kind: 'submitted';
      readonly operation: ContractOperationRecord;
      readonly providerOperation: ProviderOperation;
    }
  | {
      readonly kind: 'submitted_unknown' | 'already_started';
      readonly operation: ContractOperationRecord;
    };

/**
 * Browser-owned orchestration boundary. Components call intent-level methods;
 * only this service may load or instantiate the Magic and Particle adapters.
 */
export class BrowserApplicationService {
  readonly #api: BrowserApiClient;
  readonly #loadIntegrations: IntegrationLoader;
  readonly #continuationStore: ContinuationStore;
  readonly #origin: () => string;
  readonly #submissionLock: SubmissionLock;
  readonly #createIdempotencyKey: (scope: string) => string;
  readonly #wait: (milliseconds: number) => Promise<void>;
  #modulePromise: Promise<BrowserIntegrationModule> | undefined;
  #configPromise: Promise<PublicBrowserConfig> | undefined;
  #walletPromise: Promise<MagicWallet> | undefined;
  #account: { owner: EvmAddress; adapter: UniversalAccount } | undefined;
  #accountPreparationPromise: Promise<WalletReadinessResponse> | undefined;
  #bootstrapEligibility:
    | { readonly owner: EvmAddress; readonly result: BootstrapEligibilityResponse }
    | undefined;
  readonly #preparedPayments = new Map<string, PreparedCheckoutPayment>();
  readonly #checkoutPreparationPromises = new Map<string, Promise<PreparedCheckoutPayment>>();
  readonly #submissionPromises = new Map<string, Promise<PaymentSubmissionResult>>();
  readonly #preparedContractOperations = new Map<string, PreparedContractOperation>();
  readonly #contractSubmissionPromises = new Map<
    string,
    Promise<ContractOperationSubmissionResult>
  >();
  #pendingGoogleProof:
    | { didToken: string; continuationId: string; authMethod: 'google' }
    | undefined;

  constructor(options: BrowserApplicationServiceOptions = {}) {
    this.#api = options.api ?? new BrowserApiClient();
    this.#loadIntegrations =
      options.loadIntegrations ?? (() => import('@opentab/integrations/browser'));
    this.#continuationStore = options.continuationStore ?? browserContinuationStore();
    this.#origin = options.origin ?? (() => window.location.origin);
    this.#submissionLock = options.submissionLock ?? browserSubmissionLock();
    this.#createIdempotencyKey = options.createIdempotencyKey ?? idempotencyKey;
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** HTTP-only restoration. This intentionally does not load wallet SDK code. */
  restoreSession(): Promise<BrowserSession> {
    return this.#api.restoreSession();
  }

  getPublicProduct(merchantSlug: string, productSlug: string) {
    return this.#api.getPublicProduct(merchantSlug, productSlug);
  }

  async getPublicMediaOrigins(): Promise<readonly string[]> {
    return (await this.#config()).media.allowedOrigins;
  }

  getCheckout(checkoutSessionId: string): Promise<CheckoutSnapshotResponse> {
    return this.#api.getCheckoutSession(checkoutSessionId);
  }

  getPaymentWorkflow(paymentAttemptId: string): Promise<PaymentWorkflowResponse> {
    return this.#api.getPaymentAttempt(paymentAttemptId);
  }

  async getParticleCertificationStatus() {
    await this.restoreSession();
    return this.#api.getParticleCertificationStatus();
  }

  async listParticleCertificationProducts() {
    await this.restoreSession();
    return this.#api.listMerchantProducts();
  }

  async getSponsorChallengeConfig(): Promise<{ siteKey?: string }> {
    const { challenge } = await this.#config();
    return challenge.turnstileSiteKey === undefined ? {} : { siteKey: challenge.turnstileSiteKey };
  }

  async startCheckout(input: { productId: string; quantity: string }, idempotencyKey: string) {
    try {
      await this.restoreSession();
    } catch (error) {
      if (!(error instanceof BrowserApiError) || error.code !== 'AUTH_REQUIRED') throw error;
    }
    return this.#api.createCheckoutSession(input, idempotencyKey);
  }

  async beginGoogleSignIn(returnPath: string): Promise<void> {
    const continuation = await this.#api.createAuthContinuation(normalizeReturnPath(returnPath));
    this.#continuationStore.set(continuation.continuationId);
    try {
      const wallet = await this.#wallet();
      await wallet.loginWithGoogle({
        redirectUri: `${this.#origin()}/auth/callback`,
        continuationId: continuation.continuationId,
      });
    } catch (error) {
      this.#continuationStore.clear();
      throw error;
    }
  }

  async completeGoogleSignIn(): Promise<BrowserSession> {
    const continuationId = this.#continuationStore.get();
    if (continuationId === undefined) {
      throw new BrowserApiError({
        code: 'AUTH_STATE_MISMATCH',
        message: 'This sign-in return is no longer valid. Start sign-in again.',
        status: 0,
      });
    }
    if (this.#pendingGoogleProof === undefined) {
      const wallet = await this.#wallet();
      const proof = await wallet.completeGoogleRedirect();
      this.#pendingGoogleProof = { ...proof, continuationId };
    }
    try {
      const session = await this.#api.exchangeSession({
        didToken: this.#pendingGoogleProof.didToken,
        continuationId: this.#pendingGoogleProof.continuationId,
      });
      await this.#assertSessionOwner(session.user);
      this.#pendingGoogleProof = undefined;
      this.#continuationStore.clear();
      return session;
    } catch (error) {
      if (!(error instanceof BrowserApiError) || !error.retryable) {
        this.#pendingGoogleProof = undefined;
        this.#continuationStore.clear();
      }
      throw error;
    }
  }

  async signInWithEmail(email: string, returnPath: string): Promise<BrowserSession> {
    const continuation = await this.#api.createAuthContinuation(normalizeReturnPath(returnPath));
    const wallet = await this.#wallet();
    const proof = await wallet.loginWithEmailOtp({ email });
    const session = await this.#api.exchangeSession({
      didToken: proof.didToken,
      continuationId: continuation.continuationId,
    });
    await this.#assertSessionOwner(session.user);
    return session;
  }

  /** Re-attests a restored Magic login before a protected live operation. */
  async refreshAuthenticatedMagicSession(returnPath: string): Promise<BrowserSession> {
    const current = await this.restoreSession();
    const continuation = await this.#api.createAuthContinuation(normalizeReturnPath(returnPath));
    const wallet = await this.#wallet();
    if (wallet.getFreshIdentityProof === undefined) {
      throw new AppError(
        'AUTH_PROVIDER_UNAVAILABLE',
        'The installed Magic adapter cannot refresh the identity proof.',
      );
    }
    const proof = await wallet.getFreshIdentityProof();
    const session = await this.#api.exchangeSession({
      didToken: proof.didToken,
      continuationId: continuation.continuationId,
    });
    if (!sameEvmAddress(current.user.walletAddress, session.user.walletAddress)) {
      throw new AppError(
        'WALLET_ADDRESS_MISMATCH',
        'The refreshed Magic identity changed the wallet address.',
      );
    }
    await this.#assertSessionOwner(session.user);
    return session;
  }

  async logout(): Promise<void> {
    await this.#api.logoutSession();
    await this.logoutProviderSession();
  }

  /** Provider cleanup loaded only after the secure server session has been revoked. */
  async logoutProviderSession(): Promise<void> {
    this.#continuationStore.clear();
    const wallet = await this.#wallet();
    await wallet.logout();
    this.#pendingGoogleProof = undefined;
    this.#account = undefined;
    this.#preparedPayments.clear();
    this.#checkoutPreparationPromises.clear();
  }

  async unlockParticleCertification(operatorToken: string): Promise<ParticleCertificationStatus> {
    await this.restoreSession();
    return this.#api.unlockParticleCertification(operatorToken);
  }

  async bootstrapParticleCertificationCanary(input: {
    readonly operatorToken: string;
    readonly onProgress?: (message: string) => void;
  }): Promise<CertificationCanaryBootstrapResult> {
    const status = await this.unlockParticleCertification(input.operatorToken);
    const session = await this.restoreSession();
    const ownerAddress = await this.getWalletOwner();
    if (!sameEvmAddress(session.user.walletAddress, ownerAddress)) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The certification operator session does not match the authenticated Magic EOA.',
        status: 0,
      });
    }
    input.onProgress?.(`Authenticated Magic EOA ${ownerAddress}. Checking merchant state…`);

    let profile = await this.#api.getMerchantProfile().catch((error: unknown) => {
      if (error instanceof BrowserApiError && error.status === 404) return undefined;
      throw error;
    });
    if (profile === undefined) {
      const merchant = await this.#api.createMerchantProfile(
        {
          slug: `opentab-canary-${ownerAddress.slice(-8).toLowerCase()}`,
          displayName: 'OpenTab Release Canary',
          supportContact: 'OpenTab release operator',
          payoutAddress: ownerAddress,
        },
        certificationIdempotencyKey(
          status.profileScopeId,
          'merchant',
          ownerAddress.slice(-8).toLowerCase(),
        ),
      );
      input.onProgress?.('Approve the one-time merchant registration in Magic…');
      await this.#submitOperatorBootstrapOperation({
        status,
        operation: merchant.operation,
        expectedAction: 'create_merchant',
        onProgress: input.onProgress,
      });
      profile = await this.#waitForActiveMerchant(input.onProgress);
    } else if (profile.merchant.status !== 'active') {
      if (profile.operation === undefined) {
        throw new BrowserApiError({
          code: 'OPERATION_PLAN_INVALID',
          message: 'The pending merchant has no durable activation operation.',
          status: 0,
        });
      }
      await this.#submitOperatorBootstrapOperation({
        status,
        operation: profile.operation,
        expectedAction: 'create_merchant',
        onProgress: input.onProgress,
      });
      profile = await this.#waitForActiveMerchant(input.onProgress);
    }

    let products = (await this.#api.listMerchantProducts()).items;
    let product = products.find((candidate) => candidate.slug === RELEASE_CANARY_PRODUCT_SLUG);
    if (
      product !== undefined &&
      BigInt(product.unitPriceBaseUnits) !== RELEASE_CANARY_MAX_PRICE_BASE_UNITS
    ) {
      throw new BrowserApiError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The reserved release-canary slug already has a different price.',
        status: 0,
      });
    }
    if (product === undefined) {
      const created = await this.#api.createMerchantProduct(
        {
          merchantId: profile.merchant.id,
          slug: RELEASE_CANARY_PRODUCT_SLUG,
          title: 'OpenTab 10¢ Release Canary',
          description:
            'A single tiny live purchase used to certify this Particle configuration before customer payments open.',
          unitPriceBaseUnits: RELEASE_CANARY_PRICE_BASE_UNITS,
          maxSupply: '100',
          maxPerOrder: '1',
          startsAt: '2025-01-01T00:00:00.000Z',
          refundWindowSeconds: '0',
          loyaltyPoints: '1',
        },
        certificationIdempotencyKey(status.profileScopeId, 'product', 'create'),
      );
      product = created.product;
      input.onProgress?.('Approve the fixed 0.10 USDC canary product in Magic…');
      await this.#submitOperatorBootstrapOperation({
        status,
        operation: created.operation,
        expectedAction: 'create_product',
        onProgress: input.onProgress,
      });
      product = await this.#waitForCanaryProduct(product.id, input.onProgress);
    } else if (product.onchainProductId === undefined) {
      const detail = await this.#api.getMerchantProduct(product.id);
      if (detail.operation === undefined) {
        throw new BrowserApiError({
          code: 'OPERATION_PLAN_INVALID',
          message: 'The pending canary product has no durable contract operation.',
          status: 0,
        });
      }
      await this.#submitOperatorBootstrapOperation({
        status,
        operation: detail.operation,
        expectedAction: 'create_product',
        onProgress: input.onProgress,
      });
      product = await this.#waitForCanaryProduct(product.id, input.onProgress);
    }

    if (product.status !== 'active') {
      const activated = await this.#api.changeMerchantProductStatus(
        product.id,
        'publish',
        certificationIdempotencyKey(status.profileScopeId, 'product', 'activate'),
      );
      input.onProgress?.('Approve the final canary activation in Magic…');
      await this.#submitOperatorBootstrapOperation({
        status,
        operation: activated.operation,
        expectedAction: 'set_product_active',
        onProgress: input.onProgress,
      });
      product = await this.#waitForCanaryProduct(product.id, input.onProgress, true);
    }

    const canaryProductId = product.id;
    products = (await this.#api.listMerchantProducts()).items;
    product = products.find((candidate) => candidate.id === canaryProductId);
    if (
      product === undefined ||
      product.status !== 'active' ||
      product.onchainProductId === undefined ||
      BigInt(product.unitPriceBaseUnits) > RELEASE_CANARY_MAX_PRICE_BASE_UNITS
    ) {
      throw new BrowserApiError({
        code: 'INDEXER_LAGGING',
        message:
          'The canonical active canary product is not visible yet. Resume without resubmitting.',
        retryable: true,
        submissionPossible: true,
        status: 0,
      });
    }
    input.onProgress?.('Tiny onchain canary product is active and ready for certification.');
    return { ownerAddress, product };
  }

  async #submitOperatorBootstrapOperation(input: {
    readonly status: ParticleCertificationStatus;
    readonly operation: ContractOperationRecord;
    readonly expectedAction: OperatorBootstrapAction;
    readonly onProgress: ((message: string) => void) | undefined;
  }): Promise<ContractOperationRecord> {
    if (bootstrapAction(input.operation) !== input.expectedAction) {
      throw new BrowserApiError({
        code: 'OPERATION_PLAN_INVALID',
        message: 'The server returned a different bootstrap action than requested.',
        status: 0,
      });
    }
    const providerOperationId = `magic-direct:${input.operation.id}`;
    const locked = await this.#submissionLock.run(
      `opentab.operator-bootstrap.${input.operation.id}`,
      async () => {
        let current = await this.#api.getContractOperation(input.operation.id);
        if (current.status !== 'prepared') return current;
        if (new Date(current.expiresAt) <= new Date()) {
          throw new BrowserApiError({
            code: 'UA_QUOTE_EXPIRED',
            message: 'This bootstrap approval expired before broadcast. Refresh its server record.',
            retryable: true,
            status: 0,
          });
        }
        if (bootstrapAction(current) !== input.expectedAction) {
          throw new BrowserApiError({
            code: 'OPERATION_PLAN_INVALID',
            message: 'The durable bootstrap action changed before submission.',
            status: 0,
          });
        }
        const session = await this.restoreSession();
        const owner = await this.getWalletOwner();
        if (
          !sameEvmAddress(owner, session.user.walletAddress) ||
          !sameEvmAddress(owner, current.template.ownerAddress)
        ) {
          throw new BrowserApiError({
            code: 'WALLET_ADDRESS_MISMATCH',
            message: 'The bootstrap operation does not belong to this Magic EOA.',
            status: 0,
          });
        }
        const integrations = await this.#integrations();
        const validate = integrations.validateBrowserContractOperation;
        if (validate === undefined) {
          throw new BrowserApiError({
            code: 'CONFIGURATION_INVALID',
            message: 'Exact browser operation validation is unavailable.',
            status: 0,
          });
        }
        const template = validate({
          kind: current.kind,
          binding: current.binding,
          template: current.template,
        } as BrowserContractOperationValidationInput);
        if (
          template.bindingDigest.toLowerCase() !== current.bindingDigest.toLowerCase() ||
          template.chainId !== '42161' ||
          template.calls.some(
            (call) => !sameEvmAddress(call.to, input.status.captureConfig.checkoutAddress),
          )
        ) {
          throw new BrowserApiError({
            code: 'OPERATION_PLAN_INVALID',
            message: 'The bootstrap calls did not match the configured checkout contract.',
            status: 0,
          });
        }
        const wallet = await this.#wallet();
        await wallet.switchToArbitrum();
        const submitBootstrapMutation = wallet.submitOperatorBootstrapMutation;
        if (typeof submitBootstrapMutation !== 'function') {
          throw new BrowserApiError({
            code: 'CONFIGURATION_INVALID',
            message: 'The installed Magic adapter cannot submit constrained operator actions.',
            status: 0,
          });
        }
        try {
          current = await this.#api.registerContractOperationSubmission(
            current.id,
            { status: 'submission_started', providerOperationId },
            certificationIdempotencyKey(input.status.profileScopeId, 'start', current.id),
          );
        } catch (error) {
          const recovered = await this.#api.getContractOperation(current.id).catch(() => undefined);
          if (recovered !== undefined && recovered.status !== 'prepared') return recovered;
          throw error;
        }
        if (current.status !== 'submission_started') return current;

        let transactionHash: string;
        try {
          const submitted = await submitBootstrapMutation.call(wallet, {
            template,
            action: input.expectedAction,
            checkoutAddress: input.status.captureConfig.checkoutAddress,
          });
          transactionHash = TransactionHashSchema.parse(submitted.transactionHash);
        } catch {
          const recovered = await this.#api.getContractOperation(current.id).catch(() => current);
          if (recovered.status !== 'submission_started') return recovered;
          throw new BrowserApiError({
            code: 'PAYMENT_SUBMITTED_UNKNOWN',
            message:
              'Magic did not return a verifiable transaction hash. OpenTab will not submit this operation again.',
            retryable: true,
            submissionPossible: true,
            status: 0,
          });
        }

        try {
          return await this.#api.registerContractOperationSubmission(
            current.id,
            { status: 'submitted', providerOperationId, transactionHash },
            certificationIdempotencyKey(input.status.profileScopeId, 'submitted', current.id),
          );
        } catch {
          try {
            return await this.#api.registerContractOperationSubmission(
              current.id,
              { status: 'submitted_unknown', providerOperationId, transactionHash },
              certificationIdempotencyKey(input.status.profileScopeId, 'unknown', current.id),
            );
          } catch {
            return this.#api.getContractOperation(current.id);
          }
        }
      },
    );
    const current = locked.acquired
      ? locked.value
      : await this.#api.getContractOperation(input.operation.id);
    return this.#waitForCanonicalBootstrapOperation(current, input.onProgress);
  }

  async #waitForCanonicalBootstrapOperation(
    initial: ContractOperationRecord,
    onProgress?: (message: string) => void,
  ): Promise<ContractOperationRecord> {
    let current = initial;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (current.status === 'confirmed') return current;
      if (current.status === 'failed' || current.status === 'orphaned') {
        throw new BrowserApiError({
          code: 'PAYMENT_FAILED_CONFIRMED',
          message: 'The canonical Arbitrum bootstrap operation failed.',
          status: 0,
        });
      }
      if (attempt % 10 === 0) {
        onProgress?.('Transaction submitted once. Waiting for Railway canonical confirmation…');
      }
      await this.#wait(2_000);
      current = await this.#api.getContractOperation(current.id);
    }
    throw new BrowserApiError({
      code: 'INDEXER_LAGGING',
      message: 'Railway is still reconciling this operation. Resume later without resubmitting.',
      retryable: true,
      submissionPossible: true,
      status: 0,
    });
  }

  async #waitForActiveMerchant(
    onProgress?: (message: string) => void,
  ): Promise<Awaited<ReturnType<BrowserApiClient['getMerchantProfile']>>> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const profile = await this.#api.getMerchantProfile();
      if (profile.merchant.status === 'active') return profile;
      if (profile.operation?.status === 'failed' || profile.operation?.status === 'orphaned') {
        throw new BrowserApiError({
          code: 'PAYMENT_FAILED_CONFIRMED',
          message: 'The canonical merchant registration failed.',
          status: 0,
        });
      }
      if (attempt % 10 === 0) onProgress?.('Waiting for the canonical merchant projection…');
      await this.#wait(2_000);
    }
    throw new BrowserApiError({
      code: 'INDEXER_LAGGING',
      message: 'The merchant transaction is confirmed but its projection is still catching up.',
      retryable: true,
      submissionPossible: true,
      status: 0,
    });
  }

  async #waitForCanaryProduct(
    productId: string,
    onProgress?: (message: string) => void,
    requireActive = false,
  ): Promise<MerchantProductListResponse['items'][number]> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const detail = await this.#api.getMerchantProduct(productId);
      if (
        detail.product.onchainProductId !== undefined &&
        (!requireActive || detail.product.status === 'active')
      ) {
        return detail.product;
      }
      if (detail.operation?.status === 'failed' || detail.operation?.status === 'orphaned') {
        throw new BrowserApiError({
          code: 'PAYMENT_FAILED_CONFIRMED',
          message: 'The canonical canary product operation failed.',
          status: 0,
        });
      }
      if (attempt % 10 === 0) onProgress?.('Waiting for the canonical product projection…');
      await this.#wait(2_000);
    }
    throw new BrowserApiError({
      code: 'INDEXER_LAGGING',
      message: 'The canary product is still being projected. Resume without resubmitting.',
      retryable: true,
      submissionPossible: true,
      status: 0,
    });
  }

  async captureParticleCertificationBootstrap(input: {
    readonly operatorToken: string;
    readonly productId: string;
  }): Promise<ParticleCertificationStatus> {
    const status = await this.unlockParticleCertification(input.operatorToken);
    if (status.certification.stage !== 'uncertified') return status;
    const adapter = await this.#particleCertificationAdapter(status);
    const capture = await adapter.captureBootstrap();
    const certified = await this.#api.certifyParticleCompatibility(
      {
        operatorToken: input.operatorToken,
        profile: capture.profile,
        productId: input.productId,
      },
      this.#createIdempotencyKey(`particle-certification.bootstrap.${status.profileScopeId}`),
    );
    this.#resetLiveConfiguration();
    return certified;
  }

  async captureParticleCertificationCanaryPreview(input: {
    readonly operatorToken: string;
    readonly productId: string;
  }): Promise<{
    readonly status: ParticleCertificationStatus;
    readonly checkoutSessionId: string;
    readonly paymentAttemptId: string;
    readonly preparedFixtureDigest: string;
  }> {
    const status = await this.unlockParticleCertification(input.operatorToken);
    const certification = status.certification;
    if (
      (certification.stage !== 'bootstrap' && certification.stage !== 'canary_ready') ||
      !certification.subjectMatches
    ) {
      throw new BrowserApiError({
        code: 'UA_CONFIGURATION_INVALID',
        message: 'Capture bootstrap evidence with this Magic account first.',
        status: 0,
      });
    }
    const checkout = await this.#api.createCheckoutSession(
      { productId: input.productId, quantity: '1' },
      this.#createIdempotencyKey(
        `particle-certification.checkout.${status.profileScopeId}.${input.productId}`,
      ),
    );
    const { binding } = await this.#api.createPaymentAttempt(
      checkout.sessionId,
      this.#createIdempotencyKey(`payment-attempt.${checkout.sessionId}`),
    );
    let preparedFixtureDigest = certification.profileDigest;
    let resultingStatus = status;
    if (status.certification.stage === 'bootstrap') {
      const adapter = await this.#particleCertificationAdapter(status);
      const capture = await adapter.captureCanaryReady(binding);
      preparedFixtureDigest = capture.preparedFixtureDigest;
      resultingStatus = await this.#api.certifyParticleCompatibility(
        {
          operatorToken: input.operatorToken,
          profile: capture.profile,
          productId: input.productId,
        },
        this.#createIdempotencyKey(
          `particle-certification.canary-ready.${status.profileScopeId}`,
        ),
      );
      this.#resetLiveConfiguration();
    }
    const recovery = {
      checkoutSessionId: checkout.sessionId,
      paymentAttemptId: binding.attemptId,
      preparedFixtureDigest,
    };
    window.sessionStorage.setItem(
      'opentab.particle-certification.preview',
      JSON.stringify(recovery),
    );
    return {
      status: resultingStatus,
      checkoutSessionId: checkout.sessionId,
      paymentAttemptId: binding.attemptId,
      preparedFixtureDigest,
    };
  }

  async runAndCertifyParticleCanary(input: {
    readonly operatorToken: string;
    readonly checkoutSessionId: string;
    readonly expectedPaymentAttemptId: string;
    readonly onProgress?: (message: string) => void;
  }): Promise<ParticleCertificationStatus> {
    const storedSubmission = this.#particleCanarySubmission(input.expectedPaymentAttemptId);
    let submissionEvidenceDigest = storedSubmission?.submissionEvidenceDigest;
    if (submissionEvidenceDigest === undefined) {
      input.onProgress?.('Preparing the exact profile-bound canary payment…');
      const prepared = await this.prepareCheckoutPayment(input.checkoutSessionId);
      if (prepared.binding.attemptId !== input.expectedPaymentAttemptId) {
        throw new BrowserApiError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The canary checkout resolved to another payment attempt.',
          status: 0,
        });
      }
      input.onProgress?.('Approve the tiny canary once in Magic.');
      const submitted = await this.submitCheckoutPayment(prepared.binding.attemptId);
      if (submitted.kind !== 'submitted') {
        throw new BrowserApiError({
          code: 'PAYMENT_SUBMITTED_UNKNOWN',
          message:
            'The canary may already be moving. This tab will not submit it again; return after reconciliation.',
          retryable: true,
          submissionPossible: true,
          status: 0,
        });
      }
      submissionEvidenceDigest = submitted.operation.evidence.evidenceDigest;
      window.sessionStorage.setItem(
        'opentab.particle-certification.canary',
        JSON.stringify({
          paymentAttemptId: prepared.binding.attemptId,
          submissionEvidenceDigest,
        }),
      );
      input.onProgress?.('Submitted. Waiting for Particle and canonical Arbitrum confirmation…');
    } else {
      input.onProgress?.(
        'Recovering the existing canary. No second Particle operation will be submitted…',
      );
    }
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const observed = await this.pollPaymentAttempt(input.expectedPaymentAttemptId);
      if (
        observed.providerOperation?.status === 'succeeded' &&
        observed.workflow.canonicalOrderPaid !== undefined &&
        observed.workflow.receipt?.status === 'issued'
      ) {
        input.onProgress?.('Canonical OrderPaid event and pass confirmed. Certifying profile…');
        const status = await this.#api.finalizeParticleCertification(
          {
            operatorToken: input.operatorToken,
            paymentAttemptId: input.expectedPaymentAttemptId,
            submissionEvidenceDigest,
            statusEvidenceDigest: observed.providerOperation.evidence.evidenceDigest,
          },
          this.#createIdempotencyKey(
            `particle-certification.finalize.${input.expectedPaymentAttemptId}`,
          ),
        );
        window.sessionStorage.removeItem('opentab.particle-certification.canary');
        this.#resetLiveConfiguration();
        return status;
      }
      await this.#wait(2_000);
    }
    throw new BrowserApiError({
      code: 'INDEXER_LAGGING',
      message:
        'The canary is still reconciling. No duplicate payment was started; resume certification.',
      retryable: true,
      submissionPossible: true,
      status: 0,
    });
  }

  #particleCanarySubmission(
    paymentAttemptId: string,
  ): { readonly submissionEvidenceDigest: EvidenceDigest } | undefined {
    try {
      const raw = window.sessionStorage.getItem('opentab.particle-certification.canary');
      if (raw === null) return undefined;
      const parsed = JSON.parse(raw) as {
        readonly paymentAttemptId?: unknown;
        readonly submissionEvidenceDigest?: unknown;
      };
      if (
        parsed.paymentAttemptId !== paymentAttemptId ||
        typeof parsed.submissionEvidenceDigest !== 'string'
      ) {
        return undefined;
      }
      return {
        submissionEvidenceDigest: EvidenceDigestSchema.parse(parsed.submissionEvidenceDigest),
      };
    } catch {
      return undefined;
    }
  }

  async bindCheckout(checkoutSessionId: string): Promise<CheckoutSnapshotResponse> {
    await this.restoreSession();
    await this.#api.bindCheckoutSession(
      checkoutSessionId,
      this.#createIdempotencyKey(`checkout-bind.${checkoutSessionId}`),
    );
    return this.#api.getCheckoutSession(checkoutSessionId);
  }

  async checkWalletReadiness(): Promise<WalletReadinessResponse> {
    const session = await this.restoreSession();
    const owner = await this.getWalletOwner();
    if (!sameEvmAddress(owner, session.user.walletAddress)) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The signed-in wallet changed. Sign in again before paying.',
        status: 0,
      });
    }
    const account = await this.getUniversalAccount(owner);
    const [identity, browserDelegation, server] = await Promise.all([
      account.getAccount(),
      account.getDelegation(),
      this.#api.getWalletReadiness(),
    ]);
    if (
      !sameEvmAddress(identity.ownerAddress, owner) ||
      !sameEvmAddress(identity.evmAddress, owner) ||
      !sameEvmAddress(server.ownerAddress, owner) ||
      !sameEvmAddress(server.universalAccountAddress, owner) ||
      !sameEvmAddress(browserDelegation.ownerAddress, owner) ||
      browserDelegation.delegated !== server.delegation.delegated
    ) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The wallet readiness checks did not agree. Payment was stopped safely.',
        status: 0,
      });
    }
    return server;
  }

  async evaluateWalletPreparation(challengeToken: string): Promise<{ grantRequired: boolean }> {
    this.#assertChallengeToken(challengeToken);
    const session = await this.restoreSession();
    const owner = await this.getWalletOwner();
    if (!sameEvmAddress(owner, session.user.walletAddress)) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The signed-in wallet changed. Sign in again before account preparation.',
        status: 0,
      });
    }
    const result = await this.#api.evaluateBootstrapEligibility(
      challengeToken,
      this.#createIdempotencyKey(`bootstrap-eligibility.${owner.toLowerCase()}`),
    );
    if (
      !result.eligible &&
      result.reason !== 'already_prepared' &&
      result.reason !== 'sufficient_balance'
    ) {
      throw new BrowserApiError({
        code: 'SPONSOR_INELIGIBLE',
        message: 'Account preparation is not available for this wallet.',
        status: 0,
      });
    }
    this.#bootstrapEligibility = { owner, result };
    return { grantRequired: result.eligible && BigInt(result.deficitWei) > 0n };
  }

  prepareWalletAccount(challengeToken?: string): Promise<WalletReadinessResponse> {
    const eligibility = this.#bootstrapEligibility;
    if (eligibility === undefined) {
      throw new BrowserApiError({
        code: 'VALIDATION_FAILED',
        message: 'Check setup eligibility before preparing the account.',
        status: 0,
      });
    }
    const grantRequired = eligibility.result.eligible && BigInt(eligibility.result.deficitWei) > 0n;
    if (grantRequired) this.#assertChallengeToken(challengeToken);
    this.#accountPreparationPromise ??= this.#prepareWalletAccount(
      eligibility,
      challengeToken,
    ).finally(() => {
      this.#accountPreparationPromise = undefined;
    });
    return this.#accountPreparationPromise;
  }

  #assertChallengeToken(challengeToken: string | undefined): asserts challengeToken is string {
    if (
      challengeToken === undefined ||
      challengeToken.length < 16 ||
      challengeToken.length > 4_096
    ) {
      throw new BrowserApiError({
        code: 'VALIDATION_FAILED',
        message: 'Complete the security check before preparing the account.',
        status: 0,
      });
    }
  }

  async #prepareWalletAccount(
    eligibility: { readonly owner: EvmAddress; readonly result: BootstrapEligibilityResponse },
    challengeToken?: string,
  ): Promise<WalletReadinessResponse> {
    const session = await this.restoreSession();
    const owner = await this.getWalletOwner();
    if (
      !sameEvmAddress(owner, session.user.walletAddress) ||
      !sameEvmAddress(owner, eligibility.owner)
    ) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The signed-in wallet changed. Sign in again before account preparation.',
        status: 0,
      });
    }
    const account = await this.getUniversalAccount(owner);
    if (eligibility.result.eligible && BigInt(eligibility.result.deficitWei) > 0n) {
      this.#assertChallengeToken(challengeToken);
      let { grant } = await this.#api.requestBootstrapGrant(
        challengeToken,
        this.#createIdempotencyKey(`bootstrap-grant.${owner.toLowerCase()}`),
      );
      for (
        let poll = 0;
        poll < 30 && !['confirmed', 'failed', 'replaced'].includes(grant.status);
        poll += 1
      ) {
        await this.#wait(2_000);
        ({ grant } = await this.#api.getBootstrapGrant(grant.id));
      }
      if (grant.status !== 'confirmed') {
        throw new BrowserApiError({
          code: grant.status === 'failed' ? 'SPONSOR_INELIGIBLE' : 'SPONSOR_SUBMISSION_UNKNOWN',
          message:
            grant.status === 'failed'
              ? 'OpenTab could not prepare the account fee balance.'
              : 'Account preparation is still confirming. Return using this checkout link.',
          retryable: grant.status !== 'failed',
          submissionPossible: grant.status !== 'failed',
          status: 0,
        });
      }
    }

    this.#bootstrapEligibility = undefined;

    await (await this.#wallet()).switchToArbitrum();
    const existing = await account.getDelegation();
    if (!existing.delegated) {
      const plan = await account.prepareDelegation();
      const authorization = await (await this.#wallet()).authorizeDelegation(plan);
      const submitted = await (await this.#wallet()).submitDelegation(plan, authorization);
      if (!submitted.submissionPossible) {
        throw new BrowserApiError({
          code: 'WALLET_TYPE4_SUBMISSION_FAILED',
          message: 'The account preparation transaction was not accepted.',
          status: 0,
        });
      }
      await this.#api.recordDelegationEvidence(
        { transactionHash: submitted.transactionHash, evidenceDigest: plan.bindingDigest },
        this.#createIdempotencyKey(`delegation-evidence.${owner.toLowerCase()}`),
      );
    }
    return this.checkWalletReadiness();
  }

  async loadUnifiedBalance(): Promise<UnifiedBalance> {
    const session = await this.restoreSession();
    const owner = await this.getWalletOwner();
    if (!sameEvmAddress(owner, session.user.walletAddress)) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The signed-in wallet changed. Payment was stopped safely.',
        status: 0,
      });
    }
    const account = await this.getUniversalAccount(owner);
    const [browserBalance, serverBalance] = await Promise.all([
      account.getUnifiedBalance(),
      this.#api.getWalletBalance(),
    ]);
    if (serverBalance.balance.assets.length === 0 && browserBalance.assets.length > 0) {
      throw new BrowserApiError({
        code: 'UA_PROVIDER_SCHEMA_INVALID',
        message: 'The balance checks did not agree. Payment was stopped safely.',
        status: 0,
      });
    }
    return browserBalance;
  }

  async prepareContractOperation(
    operation: ContractOperationRecord,
  ): Promise<PreparedContractOperation> {
    if (operation.status !== 'prepared' || new Date(operation.expiresAt) <= new Date()) {
      throw new BrowserApiError({
        code: 'UA_QUOTE_EXPIRED',
        message: 'These approval details are no longer current. Refresh them safely.',
        retryable: true,
        status: 0,
      });
    }
    if (operation.kind === 'split_revocation') {
      throw new BrowserApiError({
        code: 'OPERATION_PLAN_INVALID',
        message: 'This managed operation cannot be approved in the browser.',
        status: 0,
      });
    }
    const session = await this.restoreSession();
    const owner = await this.getWalletOwner();
    if (
      !sameEvmAddress(owner, session.user.walletAddress) ||
      !sameEvmAddress(owner, operation.template.ownerAddress)
    ) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The approval owner does not match the signed-in account.',
        status: 0,
      });
    }
    await (await this.#wallet()).switchToArbitrum();
    const integrations = await this.#integrations();
    const validate = integrations.validateBrowserContractOperation;
    if (validate === undefined) {
      throw new BrowserApiError({
        code: 'CONFIGURATION_INVALID',
        message: 'Exact browser operation validation is unavailable.',
        status: 0,
      });
    }
    const template = validate({
      kind: operation.kind,
      binding: operation.binding,
      template: operation.template,
    } as BrowserContractOperationValidationInput);
    if (template.bindingDigest.toLowerCase() !== operation.bindingDigest.toLowerCase()) {
      throw new BrowserApiError({
        code: 'OPERATION_PLAN_INVALID',
        message: 'The durable approval reference does not match its exact calls.',
        status: 0,
      });
    }
    const account = await this.getUniversalAccount(owner);
    const prepared = await account.prepareOperation(template);
    if (prepared.providerOperationId === undefined) {
      throw new BrowserApiError({
        code: 'UA_PROVIDER_SCHEMA_INVALID',
        message: 'The payment provider omitted its durable operation reference.',
        status: 0,
      });
    }
    const plan = await account.validateOperation({ template, prepared });
    const result = { operation, plan, providerOperationId: prepared.providerOperationId };
    this.#preparedContractOperations.set(operation.id, result);
    return result;
  }

  submitContractOperation(operationId: string): Promise<ContractOperationSubmissionResult> {
    const existing = this.#contractSubmissionPromises.get(operationId);
    if (existing !== undefined) return existing;
    const pending = this.#submitContractOperation(operationId).finally(() => {
      this.#contractSubmissionPromises.delete(operationId);
    });
    this.#contractSubmissionPromises.set(operationId, pending);
    return pending;
  }

  async #submitContractOperation(operationId: string): Promise<ContractOperationSubmissionResult> {
    const locked = await this.#submissionLock.run(
      `opentab.contract-operation-submit.${operationId}`,
      async () => {
        const current = await this.#api.getContractOperation(operationId);
        if (current.status !== 'prepared') {
          return { kind: 'already_started' as const, operation: current };
        }
        const prepared = this.#preparedContractOperations.get(operationId);
        if (prepared === undefined) {
          throw new BrowserApiError({
            code: 'PAYMENT_PREVIEW_RELOAD_REQUIRED',
            message: 'These approval details are no longer held in this tab. Refresh them safely.',
            retryable: true,
            status: 0,
          });
        }
        const wallet = await this.#wallet();
        const signed = await wallet.signValidatedRoot(prepared.plan);
        if (!sameEvmAddress(signed.recoveredOwner, prepared.operation.template.ownerAddress)) {
          throw new BrowserApiError({
            code: 'WALLET_SIGNATURE_REJECTED',
            message: 'The approval came from a different account.',
            status: 0,
          });
        }
        let started: ContractOperationRecord;
        try {
          started = await this.#api.registerContractOperationSubmission(
            operationId,
            { status: 'submission_started', providerOperationId: prepared.providerOperationId },
            this.#createIdempotencyKey(`contract-operation-start.${operationId}`),
          );
        } catch (error) {
          const recovered = await this.#api
            .getContractOperation(operationId)
            .catch(() => undefined);
          if (recovered !== undefined && recovered.status !== 'prepared') {
            return { kind: 'already_started' as const, operation: recovered };
          }
          throw error;
        }
        if (started.status !== 'submission_started') {
          return { kind: 'already_started' as const, operation: started };
        }
        this.#preparedContractOperations.delete(operationId);
        try {
          const account = await this.getUniversalAccount(prepared.operation.template.ownerAddress);
          const providerOperation = await account.submitValidated({
            plan: prepared.plan,
            rootSignature: signed.signature,
          });
          const operation = await this.#api.registerContractOperationSubmission(
            operationId,
            {
              status: 'submitted',
              providerOperationId: prepared.providerOperationId,
              ...(providerOperation.destinationTransactionHash === undefined
                ? {}
                : { transactionHash: providerOperation.destinationTransactionHash }),
            },
            this.#createIdempotencyKey(`contract-operation-submitted.${operationId}`),
          );
          return { kind: 'submitted' as const, operation, providerOperation };
        } catch {
          const operation = await this.#api
            .registerContractOperationSubmission(
              operationId,
              {
                status: 'submitted_unknown',
                providerOperationId: prepared.providerOperationId,
              },
              this.#createIdempotencyKey(`contract-operation-unknown.${operationId}`),
            )
            .catch(() => started);
          return { kind: 'submitted_unknown' as const, operation };
        }
      },
    );
    if (!locked.acquired) {
      return {
        kind: 'already_started',
        operation: await this.#api.getContractOperation(operationId),
      };
    }
    return locked.value;
  }

  getContractOperation(operationId: string): Promise<ContractOperationRecord> {
    return this.#api.getContractOperation(operationId);
  }

  prepareCheckoutPayment(checkoutSessionId: string): Promise<PreparedCheckoutPayment> {
    const existing = this.#checkoutPreparationPromises.get(checkoutSessionId);
    if (existing !== undefined) return existing;
    const pending = this.#prepareCheckoutPayment(checkoutSessionId).finally(() => {
      this.#checkoutPreparationPromises.delete(checkoutSessionId);
    });
    this.#checkoutPreparationPromises.set(checkoutSessionId, pending);
    return pending;
  }

  async #prepareCheckoutPayment(checkoutSessionId: string): Promise<PreparedCheckoutPayment> {
    const session = await this.restoreSession();
    const owner = await this.getWalletOwner();
    if (!sameEvmAddress(owner, session.user.walletAddress)) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The signed-in wallet changed. Payment was stopped safely.',
        status: 0,
      });
    }
    await (await this.#wallet()).switchToArbitrum();
    const account = await this.getUniversalAccount(owner);
    const { binding } = await this.#api.createPaymentAttempt(
      checkoutSessionId,
      this.#createIdempotencyKey(`payment-attempt.${checkoutSessionId}`),
    );
    if (
      binding.checkoutSessionId !== checkoutSessionId ||
      !sameEvmAddress(binding.orderIntent.payer, owner)
    ) {
      throw new BrowserApiError({
        code: 'OPERATION_PLAN_INVALID',
        message: 'The server payment binding did not match this checkout or wallet.',
        status: 0,
      });
    }
    const integrations = await this.#integrations();
    const template = integrations.createCheckoutOperationTemplate(binding);
    const prepared = await account.prepareOperation(template);
    if (prepared.providerOperationId === undefined) {
      throw new BrowserApiError({
        code: 'UA_PROVIDER_SCHEMA_INVALID',
        message: 'The payment provider omitted its durable operation reference.',
        status: 0,
      });
    }
    const plan = await account.validateOperation({ template, prepared });
    await this.#api.recordPreparedPayment(
      binding.attemptId,
      {
        providerOperationId: prepared.providerOperationId,
        rootHashDigest: integrations.digestUnknown(plan.rootHash),
        previewDigest: integrations.digestUnknown(plan.quote),
        expiresAt: plan.expiresAt,
        quoteSummary: {
          sourceAmountBaseUnits: plan.quote.amountBaseUnits,
          destinationAmountBaseUnits: binding.orderIntent.amountBaseUnits,
          feeBaseUnits: decimalUsdToMicros(plan.quote.estimatedFeeUsd),
          routeLabel: 'Particle Universal Account to Arbitrum One',
        },
      },
      this.#createIdempotencyKey(`payment-prepared.${binding.attemptId}`),
    );
    const result = { binding, plan, providerOperationId: prepared.providerOperationId };
    this.#preparedPayments.set(binding.attemptId, result);
    return result;
  }

  async submitCheckoutPayment(paymentAttemptId: string): Promise<PaymentSubmissionResult> {
    const existing = this.#submissionPromises.get(paymentAttemptId);
    if (existing !== undefined) return existing;
    const pending = this.#submitCheckoutPayment(paymentAttemptId).finally(() => {
      this.#submissionPromises.delete(paymentAttemptId);
    });
    this.#submissionPromises.set(paymentAttemptId, pending);
    return pending;
  }

  async pollPaymentAttempt(paymentAttemptId: string): Promise<{
    workflow: PaymentWorkflowResponse;
    providerOperation?: ProviderOperation;
  }> {
    const workflow = await this.#api.getPaymentAttempt(paymentAttemptId);
    if (['failed_confirmed', 'expired'].includes(workflow.attempt.status)) {
      return { workflow };
    }
    const id = workflow.attempt.providerOperationId;
    if (id === undefined) return { workflow };
    const owner = workflow.order.payer;
    const account = await this.getUniversalAccount(owner);
    return { workflow, providerOperation: await account.getOperation(id) };
  }

  async #submitCheckoutPayment(paymentAttemptId: string): Promise<PaymentSubmissionResult> {
    const locked = await this.#submissionLock.run(
      `opentab.payment-submit.${paymentAttemptId}`,
      async () => {
        const prepared = this.#preparedPayments.get(paymentAttemptId);
        const current = await this.#api.getPaymentAttempt(paymentAttemptId);
        if (isSubmissionBoundaryStatus(current.attempt.status)) {
          return { kind: 'already_started' as const, workflow: current };
        }
        if (prepared === undefined || current.attempt.status !== 'prepared') {
          throw new BrowserApiError({
            code: 'PAYMENT_PREVIEW_RELOAD_REQUIRED',
            message: 'These payment details are no longer held in this tab. Refresh them safely.',
            retryable: true,
            status: 0,
          });
        }
        const wallet = await this.#wallet();
        const signed = await wallet.signValidatedRoot(prepared.plan);
        if (!sameEvmAddress(signed.recoveredOwner, prepared.binding.orderIntent.payer)) {
          throw new BrowserApiError({
            code: 'WALLET_SIGNATURE_REJECTED',
            message: 'The payment approval came from a different wallet.',
            status: 0,
          });
        }
        try {
          const started = await this.#api.startPaymentSubmission(
            paymentAttemptId,
            prepared.binding.bindingDigest,
            this.#createIdempotencyKey(`payment-start.${paymentAttemptId}`),
          );
          if (started.attempt.status !== 'submission_started') {
            return {
              kind: 'already_started' as const,
              workflow: await this.#api.getPaymentAttempt(paymentAttemptId),
            };
          }
        } catch (error) {
          if (
            error instanceof BrowserApiError &&
            [
              'PAYMENT_ALREADY_SUBMITTED',
              'PAYMENT_SUBMITTED_UNKNOWN',
              'IDEMPOTENCY_CONFLICT',
            ].includes(error.code)
          ) {
            return {
              kind: 'already_started' as const,
              workflow: await this.#api.getPaymentAttempt(paymentAttemptId),
            };
          }
          try {
            const workflow = await this.#api.getPaymentAttempt(paymentAttemptId);
            if (isSubmissionBoundaryStatus(workflow.attempt.status)) {
              return { kind: 'already_started' as const, workflow };
            }
            throw error;
          } catch (recoveryError) {
            if (recoveryError === error) throw error;
            throw new BrowserApiError({
              code: 'PAYMENT_SUBMITTED_UNKNOWN',
              message:
                'OpenTab could not prove whether the durable submission lock was recorded. Do not pay again.',
              retryable: true,
              submissionPossible: true,
              status: 0,
            });
          }
        }

        this.#preparedPayments.delete(paymentAttemptId);
        try {
          const account = await this.getUniversalAccount(prepared.binding.orderIntent.payer);
          const operation = await account.submitValidated({
            plan: prepared.plan,
            rootSignature: signed.signature,
          });
          await this.#api.registerPaymentSubmission(
            paymentAttemptId,
            { status: 'submitted', providerOperationId: prepared.providerOperationId },
            this.#createIdempotencyKey(`payment-register.${paymentAttemptId}`),
          );
          return {
            kind: 'submitted' as const,
            operation,
            workflow: await this.#api.getPaymentAttempt(paymentAttemptId),
          };
        } catch {
          await this.#api
            .registerPaymentSubmission(
              paymentAttemptId,
              { status: 'submitted_unknown' },
              this.#createIdempotencyKey(`payment-unknown.${paymentAttemptId}`),
            )
            .catch(() => undefined);
          try {
            return {
              kind: 'submitted_unknown' as const,
              workflow: await this.#api.getPaymentAttempt(paymentAttemptId),
            };
          } catch {
            throw new BrowserApiError({
              code: 'PAYMENT_SUBMITTED_UNKNOWN',
              message:
                'The payment may have moved, but OpenTab could not load its durable status. Do not pay again.',
              retryable: true,
              submissionPossible: true,
              status: 0,
            });
          }
        }
      },
    );
    if (!locked.acquired) {
      return {
        kind: 'already_started',
        workflow: await this.#api.getPaymentAttempt(paymentAttemptId),
      };
    }
    return locked.value;
  }

  async getWalletOwner(): Promise<EvmAddress> {
    return (await this.#wallet()).getOwnerAddress();
  }

  async getUniversalAccount(owner: EvmAddress): Promise<UniversalAccount> {
    if (this.#account !== undefined) {
      if (!sameEvmAddress(this.#account.owner, owner)) {
        throw new BrowserApiError({
          code: 'WALLET_ADDRESS_MISMATCH',
          message: 'The authenticated account changed. Sign in again before paying.',
          status: 0,
        });
      }
      return this.#account.adapter;
    }
    const config = await this.#liveConfig();
    const module = await this.#integrations();
    const adapter = module.createParticleUniversalAccountAdapter({
      projectId: config.particle.projectId,
      projectClientKey: config.particle.projectClientKey,
      projectAppUuid: config.particle.projectAppUuid,
      ownerAddress: owner,
      expectedImplementationAddress: config.particle.expectedImplementationAddress,
      expectedImplementationCodeHash: asHexDigest(config.particle.expectedImplementationCodeHash),
      environment: config.environment,
      slippageBps: config.particle.slippageBps,
      maxFeeUsdMicros: BigInt(config.particle.maxFeeUsdMicros),
      allowedSourceChainIds: config.particle.allowedSourceChainIds,
      allowedSourceAssets: config.particle.allowedSourceAssets,
      allowedSourceTokens: config.particle.allowedSourceTokens,
      sourceCallPolicies: config.particle.sourceCallPolicies.map((policy) => ({
        ...policy,
        tokenAddress: EvmAddressSchema.parse(policy.tokenAddress),
        target: EvmAddressSchema.parse(policy.target),
        functionSelector: policy.functionSelector as `0x${string}`,
        capturedFixtureDigest: asBytes32(policy.capturedFixtureDigest),
      })),
      responseProfile: {
        ...config.particle.responseProfile,
        certificationStage: config.particle.certificationStage,
        deploymentsFixtureDigest: asHexDigest(
          config.particle.responseProfile.deploymentsFixtureDigest,
        ),
        authFixtureDigest: asHexDigest(config.particle.responseProfile.authFixtureDigest),
        ...(config.particle.responseProfile.submissionFixtureDigest === undefined
          ? {}
          : {
              submissionFixtureDigest: asHexDigest(
                config.particle.responseProfile.submissionFixtureDigest,
              ),
            }),
        ...(config.particle.responseProfile.statusFixtureDigest === undefined
          ? {}
          : {
              statusFixtureDigest: asHexDigest(config.particle.responseProfile.statusFixtureDigest),
            }),
      },
      ...(config.particle.rpcUrl === undefined ? {} : { rpcUrl: config.particle.rpcUrl }),
    });
    this.#account = { owner, adapter };
    return adapter;
  }

  async #particleCertificationAdapter(status: ParticleCertificationStatus) {
    const session = await this.restoreSession();
    const wallet = await this.#wallet();
    const owner = await wallet.getOwnerAddress();
    if (!sameEvmAddress(owner, session.user.walletAddress)) {
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The Magic wallet does not match the authenticated operator session.',
        status: 0,
      });
    }
    if (typeof wallet.probeDelegationAuthorizationNonce !== 'function') {
      throw new BrowserApiError({
        code: 'WALLET_7702_UNSUPPORTED',
        message: 'The installed Magic adapter cannot run the EIP-7702 compatibility probe.',
        status: 0,
      });
    }
    const config = status.captureConfig;
    const integrations = await this.#integrations();
    return integrations.createParticleOperatorCertificationAdapter({
      profileId: `project-${status.profileScopeId.slice(0, 20)}`,
      environment: status.environment,
      projectId: config.projectId,
      projectClientKey: config.projectClientKey,
      projectAppUuid: config.projectAppUuid,
      ownerAddress: owner,
      magic: wallet,
      arbitrumRpcUrl: config.arbitrumRpcUrl,
      allowedArbitrumRpcOrigins: [new URL(config.arbitrumRpcUrl).origin],
      allowedSourceChainIds: config.allowedSourceChainIds,
      allowedSourceAssets: config.allowedSourceAssets,
      slippageBps: config.maximumSlippageBps,
      delegationPlanTtlSeconds: config.delegationPlanTtlSeconds,
      ...(config.particleRpcUrl === undefined ? {} : { particleRpcUrl: config.particleRpcUrl }),
    });
  }

  #resetLiveConfiguration(): void {
    this.#configPromise = undefined;
    this.#account = undefined;
  }

  async #assertSessionOwner(user: CurrentUser): Promise<void> {
    const owner = await this.getWalletOwner();
    if (!sameEvmAddress(owner, user.walletAddress)) {
      await this.#api.logoutSession().catch(() => undefined);
      throw new BrowserApiError({
        code: 'WALLET_ADDRESS_MISMATCH',
        message: 'The signed-in wallet does not match the secure application session.',
        status: 0,
      });
    }
  }

  #integrations(): Promise<BrowserIntegrationModule> {
    this.#modulePromise ??= this.#loadIntegrations();
    return this.#modulePromise;
  }

  #config(): Promise<PublicBrowserConfig> {
    this.#configPromise ??= this.#api.getPublicConfig();
    return this.#configPromise;
  }

  async #liveConfig(): Promise<
    PublicBrowserConfig & {
      particle: Extract<PublicBrowserConfig['particle'], { enabled: true }> & {
        responseProfile: Extract<
          PublicBrowserConfig['particle'],
          { enabled: true }
        >['responseProfile'] & {
          provenance: 'recorded_live';
        };
      };
    }
  > {
    const config = await this.#config();
    if (!config.particle.enabled) {
      throw new BrowserApiError({
        code: 'FEATURE_DISABLED',
        message: 'Cross-chain wallet operations are not enabled yet.',
        status: 0,
      });
    }
    if (config.particle.responseProfile.provenance !== 'recorded_live') {
      throw new BrowserApiError({
        code: 'CONFIGURATION_INVALID',
        message: 'Live browser integrations require a recorded-live vendor response profile.',
        status: 0,
      });
    }
    if (
      ['preview', 'staging', 'demo-mainnet', 'production'].includes(config.environment) &&
      (config.particle.allowedSourceTokens.length === 0 ||
        config.particle.sourceCallPolicies.length === 0)
    ) {
      throw new BrowserApiError({
        code: 'CONFIGURATION_INVALID',
        message: 'Live browser integrations require exact source-token and source-call policies.',
        status: 0,
      });
    }
    return config as PublicBrowserConfig & {
      particle: Extract<PublicBrowserConfig['particle'], { enabled: true }> & {
        responseProfile: Extract<
          PublicBrowserConfig['particle'],
          { enabled: true }
        >['responseProfile'] & {
          provenance: 'recorded_live';
        };
      };
    };
  }

  async #wallet(): Promise<MagicWallet> {
    if (this.#walletPromise !== undefined) return this.#walletPromise;
    this.#walletPromise = this.#config().then(async (config) => {
      if (
        config.particle.enabled &&
        config.particle.responseProfile.provenance !== 'recorded_live'
      ) {
        throw new BrowserApiError({
          code: 'CONFIGURATION_INVALID',
          message: 'Live wallet integrations require a recorded provider profile.',
          status: 0,
        });
      }
      const module = await this.#integrations();
      return module.createMagicBrowserWallet({
        publishableKey: config.magic.publishableKey,
        environment: config.environment,
        allowedRedirectUris: [`${this.#origin()}/auth/callback`],
        rpcNetworks: [{ chainId: 42_161, rpcUrl: config.magic.rpcUrl, default: true }],
      });
    });
    return this.#walletPromise;
  }
}

let browserApplicationService: BrowserApplicationService | undefined;

export function getBrowserApplicationService(): BrowserApplicationService {
  browserApplicationService ??= new BrowserApplicationService();
  return browserApplicationService;
}

export function resetBrowserApplicationServiceForTests(): void {
  browserApplicationService = undefined;
}
