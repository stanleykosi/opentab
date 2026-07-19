import { z } from 'zod';

const RequestIdSchema = z.string().min(1).max(128);
const DateTimeSchema = z.string().datetime();
const UnsignedIntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .brand<'EvmAddress'>();
const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .brand<'Bytes32'>();
const EvidenceDigestSchema = Bytes32Schema.brand<'EvidenceDigest'>();
const prefixedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
const UserIdSchema = prefixedId('usr').brand<'UserId'>();
const MerchantIdSchema = prefixedId('mer').brand<'MerchantId'>();
const ProductIdSchema = prefixedId('prd').brand<'ProductId'>();
const BaseUnitAmountSchema = UnsignedIntegerSchema.refine(
  (value) => BigInt(value) <= (1n << 256n) - 1n,
  'Value must fit uint256',
)
  .brand<'UnsignedIntegerString'>()
  .brand<'BaseUnitAmount'>();
const QuantitySchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n, 'Quantity must fit uint64')
  .brand<'Quantity'>();
const CurrentUserSchema = z.object({
  id: UserIdSchema,
  walletAddress: EvmAddressSchema,
  authMethod: z.enum(['google', 'email_otp']),
  status: z.enum(['active', 'suspended', 'closed']),
  merchantMemberships: z.array(
    z.object({
      merchantId: MerchantIdSchema,
      role: z.enum(['owner', 'admin', 'operator', 'viewer']),
    }),
  ),
});
const MerchantSchema = z.object({
  id: MerchantIdSchema,
  ownerUserId: UserIdSchema,
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
  displayName: z.string().trim().min(2).max(100),
  supportContact: z.string().trim().max(200).optional(),
  payoutAddress: EvmAddressSchema,
  status: z.enum(['draft', 'pending', 'active', 'paused', 'archived']),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
const ProductSchema = z.object({
  id: ProductIdSchema,
  merchantId: MerchantIdSchema,
  onchainProductId: UnsignedIntegerSchema.optional(),
  version: z.string().regex(/^[1-9][0-9]*$/),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().min(1).max(4_000),
  imageUrl: z.string().url().optional(),
  unitPriceBaseUnits: BaseUnitAmountSchema,
  maxSupply: QuantitySchema.optional(),
  sold: UnsignedIntegerSchema,
  maxPerOrder: QuantitySchema,
  startsAt: DateTimeSchema,
  endsAt: DateTimeSchema.optional(),
  refundWindowSeconds: UnsignedIntegerSchema,
  loyaltyPoints: BaseUnitAmountSchema,
  metadataHash: EvidenceDigestSchema,
  status: z.enum([
    'draft',
    'publishing',
    'scheduled',
    'active',
    'paused',
    'sold_out',
    'ended',
    'archived',
  ]),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});

const ApiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(1_000),
        retryable: z.boolean().optional(),
        submissionPossible: z.boolean().optional(),
        requestId: RequestIdSchema,
      })
      .strict(),
  })
  .strict();

export const PublicBrowserConfigSchema = z
  .object({
    applicationReleaseId: z.string().min(3).max(80),
    liveAcceptanceConfigDigest: EvidenceDigestSchema.optional(),
    environment: z.string().min(1).max(40),
    magic: z
      .object({
        publishableKey: z.string().min(1).max(512),
        rpcUrl: z.string().url(),
      })
      .strict(),
    particle: z.discriminatedUnion('enabled', [
      z.object({ enabled: z.literal(false) }).strict(),
      z
        .object({
          enabled: z.literal(true),
          projectId: z.string().min(1).max(256),
          projectClientKey: z.string().min(1).max(512),
          projectAppUuid: z.string().min(1).max(256),
          certificationStage: z.enum(['canary_ready', 'certified']),
          profileDigest: EvidenceDigestSchema,
          expectedImplementationAddress: EvmAddressSchema,
          expectedImplementationCodeHash: EvidenceDigestSchema,
          slippageBps: z.number().int().min(0).max(500),
          maxFeeUsdMicros: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
          allowedSourceChainIds: z.array(UnsignedIntegerSchema).min(1).max(32),
          allowedSourceAssets: z
            .array(z.enum(['USDC', 'USDT', 'ETH']))
            .min(1)
            .max(3),
          allowedSourceTokens: z
            .array(
              z
                .object({
                  chainId: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
                  asset: z.enum(['USDC', 'USDT', 'ETH']),
                  address: EvmAddressSchema,
                })
                .strict(),
            )
            .max(32),
          sourceCallPolicies: z
            .array(
              z
                .object({
                  policyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
                  chainId: UnsignedIntegerSchema.refine((value) => BigInt(value) > 0n),
                  asset: z.enum(['USDC', 'USDT', 'ETH']),
                  tokenAddress: EvmAddressSchema,
                  uaType: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
                  target: EvmAddressSchema,
                  functionSelector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
                  nativeValueAllowed: z.boolean(),
                  maxCalls: z.number().int().min(1).max(16),
                  capturedFixtureDigest: EvidenceDigestSchema,
                })
                .strict(),
            )
            .max(32),
          rpcUrl: z.string().url().optional(),
          responseProfile: z
            .object({
              profileId: z.string().min(1).max(128),
              provenance: z.enum(['deterministic', 'recorded_live']),
              deploymentsFixtureDigest: EvidenceDigestSchema,
              authFixtureDigest: EvidenceDigestSchema,
              submissionFixtureDigest: EvidenceDigestSchema.optional(),
              statusFixtureDigest: EvidenceDigestSchema.optional(),
              magicAuthorizationNonceOffset: z.union([z.literal(0), z.literal(1)]),
              delegationPlanTtlSeconds: z.number().int().min(30).max(600),
            })
            .strict(),
        })
        .strict(),
    ]),
    media: z.object({ allowedOrigins: z.array(z.string().url()).min(1).max(21) }).strict(),
    features: z
      .object({
        checkout: z.boolean(),
        bootstrapGas: z.boolean(),
        splits: z.boolean(),
        loyalty: z.boolean(),
        judgeMode: z.boolean(),
      })
      .strict(),
    challenge: z.object({ turnstileSiteKey: z.string().min(1).max(256).optional() }).strict(),
    requestId: RequestIdSchema,
  })
  .strict();

export const BrowserSessionSchema = z
  .object({
    user: CurrentUserSchema,
    csrfToken: z.string().min(32).max(256),
    expiresAt: DateTimeSchema,
    returnPath: z.string().startsWith('/').max(1_024).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

export const PublicProductRecordSchema = z
  .object({
    merchant: MerchantSchema,
    product: ProductSchema,
    availabilityObservedAt: DateTimeSchema,
    projectionStale: z.boolean(),
    requestId: RequestIdSchema,
  })
  .strict();

const LogoutResultSchema = z
  .object({ revoked: z.literal(true), requestId: RequestIdSchema })
  .strict();

export type PublicBrowserConfig = z.infer<typeof PublicBrowserConfigSchema>;
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export type PublicProductRecord = z.infer<typeof PublicProductRecordSchema>;

export class BrowserApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly submissionPossible: boolean;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(input: {
    code: string;
    message: string;
    retryable?: boolean;
    submissionPossible?: boolean;
    requestId?: string;
    status: number;
  }) {
    super(input.message);
    this.name = 'BrowserApiError';
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.submissionPossible = input.submissionPossible ?? false;
    this.requestId = input.requestId;
    this.status = input.status;
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new BrowserApiError({
      code: 'VALIDATION_FAILED',
      message: 'The requested resource reference is invalid.',
      status: 0,
    });
  }
  return encodeURIComponent(value);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: Readonly<Record<string, unknown>>;
  csrf?: boolean;
}

export class PublicSessionApiClient {
  readonly #fetcher: typeof fetch;
  #csrfToken: string | undefined;

  constructor(options: { fetcher?: typeof fetch } = {}) {
    // Window.fetch is receiver-sensitive in Chromium. Preserve the runtime
    // receiver when the native transport is stored on this client instance.
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  getPublicConfig(): Promise<PublicBrowserConfig> {
    return this.#request('/api/v1/config/public', PublicBrowserConfigSchema);
  }

  getPublicProduct(merchantSlug: string, productSlug: string): Promise<PublicProductRecord> {
    return this.#request(
      `/api/v1/merchants/${safeSegment(merchantSlug)}/products/${safeSegment(productSlug)}`,
      PublicProductRecordSchema,
    );
  }

  async restoreSession(): Promise<BrowserSession> {
    const session = await this.#request('/api/v1/auth/session/refresh', BrowserSessionSchema, {
      method: 'POST',
      body: {},
    });
    this.#csrfToken = session.csrfToken;
    return session;
  }

  async logoutSession(): Promise<void> {
    await this.#request('/api/v1/auth/session', LogoutResultSchema, {
      method: 'DELETE',
      body: {},
      csrf: true,
    });
    this.#csrfToken = undefined;
  }

  getCsrfTokenForTests(): string | undefined {
    return this.#csrfToken;
  }

  async #request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.csrf === true) {
      if (this.#csrfToken === undefined) {
        throw new BrowserApiError({
          code: 'CSRF_UNAVAILABLE',
          message: 'Refresh your secure session before continuing.',
          retryable: true,
          status: 0,
        });
      }
      headers.set('X-CSRF-Token', this.#csrfToken);
    }

    let response: Response;
    try {
      response = await this.#fetcher(path, {
        method: options.method ?? 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new BrowserApiError({
        code: 'NETWORK_UNAVAILABLE',
        message: 'OpenTab could not reach the secure server. Try again.',
        retryable: true,
        status: 0,
      });
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsedError = ApiErrorEnvelopeSchema.safeParse(payload);
      if (parsedError.success) {
        throw new BrowserApiError({
          code: parsedError.data.error.code,
          message: parsedError.data.error.message,
          requestId: parsedError.data.error.requestId,
          status: response.status,
          ...(parsedError.data.error.retryable === undefined
            ? {}
            : { retryable: parsedError.data.error.retryable }),
          ...(parsedError.data.error.submissionPossible === undefined
            ? {}
            : { submissionPossible: parsedError.data.error.submissionPossible }),
        });
      }
      throw new BrowserApiError({
        code: 'RESPONSE_INVALID',
        message: 'OpenTab received an unexpected secure-server response and stopped safely.',
        status: response.status,
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new BrowserApiError({
        code: 'RESPONSE_INVALID',
        message: 'OpenTab received an unexpected secure-server response and stopped safely.',
        status: response.status,
      });
    }
    return parsed.data;
  }
}

export interface PublicSessionApplicationService {
  restoreSession(): Promise<BrowserSession>;
  logout(): Promise<void>;
  getPublicProduct(merchantSlug: string, productSlug: string): Promise<PublicProductRecord>;
  getPublicMediaOrigins(): Promise<readonly string[]>;
  getPublicCheckoutContext(): Promise<PublicCheckoutContext>;
}

export interface PublicCheckoutContext {
  readonly checkoutEnabled: boolean;
  readonly allowedMediaOrigins: readonly string[];
}

export class DefaultPublicSessionApplicationService implements PublicSessionApplicationService {
  readonly #api: PublicSessionApiClient;
  readonly #loadProviderSession: () => Promise<{ logoutProviderSession(): Promise<void> }>;

  constructor(
    options: {
      api?: PublicSessionApiClient;
      loadProviderSession?: () => Promise<{ logoutProviderSession(): Promise<void> }>;
    } = {},
  ) {
    this.#api = options.api ?? new PublicSessionApiClient();
    this.#loadProviderSession =
      options.loadProviderSession ??
      (() =>
        import('./browser-application-service').then(({ getBrowserApplicationService }) =>
          getBrowserApplicationService(),
        ));
  }

  restoreSession(): Promise<BrowserSession> {
    return this.#api.restoreSession();
  }

  async logout(): Promise<void> {
    await this.#api.logoutSession();
    await (await this.#loadProviderSession()).logoutProviderSession();
  }

  getPublicProduct(merchantSlug: string, productSlug: string): Promise<PublicProductRecord> {
    return this.#api.getPublicProduct(merchantSlug, productSlug);
  }

  async getPublicMediaOrigins(): Promise<readonly string[]> {
    return (await this.#api.getPublicConfig()).media.allowedOrigins;
  }

  async getPublicCheckoutContext(): Promise<PublicCheckoutContext> {
    const config = await this.#api.getPublicConfig();
    return {
      checkoutEnabled: config.features.checkout,
      allowedMediaOrigins: config.media.allowedOrigins,
    };
  }
}

let publicSessionApplicationService: PublicSessionApplicationService | undefined;

export function getPublicSessionApplicationService(): PublicSessionApplicationService {
  publicSessionApplicationService ??= new DefaultPublicSessionApplicationService();
  return publicSessionApplicationService;
}

export function resetPublicSessionApplicationServiceForTests(): void {
  publicSessionApplicationService = undefined;
}
