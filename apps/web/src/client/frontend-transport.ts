import type { z } from 'zod';
import {
  demoCheckout,
  demoDashboard,
  demoJudgeProof,
  demoProduct,
  demoReceipt,
  demoSplit,
} from './deterministic-data';
import type { CommandReceipt } from './schemas';
import {
  CheckoutSnapshotViewSchema,
  CommandReceiptSchema,
  JudgeProofViewSchema,
  MerchantDashboardViewSchema,
  ProductViewSchema,
  ReceiptViewSchema,
  SplitViewSchema,
} from './schemas';
import type {
  CheckoutSnapshotView,
  JudgeProofView,
  MerchantDashboardView,
  ProductView,
  ReceiptView,
  SplitView,
} from './view-models';

export class FrontendTransportError extends Error {
  readonly code: 'CONFIGURATION_UNAVAILABLE' | 'REQUEST_FAILED' | 'RESPONSE_INVALID';
  readonly retrySafe: boolean;

  constructor(code: FrontendTransportError['code'], message: string, retrySafe: boolean) {
    super(message);
    this.name = 'FrontendTransportError';
    this.code = code;
    this.retrySafe = retrySafe;
  }
}

export interface ProductCommandInput {
  title: string;
  slug: string;
  description: string;
  unitPriceBaseUnits: string;
  inventory: string;
  maxPerOrder: string;
  refundWindowSeconds: string;
  loyaltyPoints: string;
}

export interface FrontendTransport {
  getPublicProduct(merchantSlug: string, productSlug: string): Promise<ProductView>;
  getCheckout(checkoutSessionId: string): Promise<CheckoutSnapshotView>;
  getReceipt(orderId: string): Promise<ReceiptView>;
  getSplit(reference: string): Promise<SplitView>;
  getMerchantDashboard(): Promise<MerchantDashboardView>;
  getJudgeProof(evidenceId: string): Promise<JudgeProofView>;
  startCheckout(
    input: { productId: string; quantity: string },
    idempotencyKey: string,
  ): Promise<CommandReceipt>;
  createProduct(input: ProductCommandInput, idempotencyKey: string): Promise<CommandReceipt>;
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    throw new FrontendTransportError(
      'REQUEST_FAILED',
      response.status >= 500
        ? 'OpenTab is temporarily unavailable.'
        : 'This action could not be completed.',
      response.status >= 500 || response.status === 429,
    );
  }
  const result = schema.safeParse(await response.json());
  if (!result.success) {
    throw new FrontendTransportError(
      'RESPONSE_INVALID',
      'OpenTab received an unexpected response and stopped safely.',
      false,
    );
  }
  return result.data;
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new FrontendTransportError(
      'REQUEST_FAILED',
      'The requested reference is invalid.',
      false,
    );
  }
  return encodeURIComponent(value);
}

export interface HttpFrontendTransportOptions {
  fetcher?: typeof fetch;
  getCsrfToken?: () => string | undefined;
}

function readCsrfTokenFromDocument(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.querySelector<HTMLMetaElement>('meta[name="opentab-csrf"]')?.content || undefined;
}

export function createHttpFrontendTransport(
  options: HttpFrontendTransportOptions = {},
): FrontendTransport {
  const fetcher = options.fetcher ?? fetch;
  const getCsrfToken = options.getCsrfToken ?? readCsrfTokenFromDocument;
  async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const method = init?.method?.toUpperCase() ?? 'GET';
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrfToken = getCsrfToken();
      if (!csrfToken) {
        throw new FrontendTransportError(
          'CONFIGURATION_UNAVAILABLE',
          'This secure action needs a refreshed session before it can continue.',
          true,
        );
      }
      headers.set('X-CSRF-Token', csrfToken);
    }
    const response = await fetcher(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
      headers,
    });
    return parseResponse(response, schema);
  }

  return {
    getPublicProduct: (merchantSlug, productSlug) =>
      request(
        `/api/v1/merchants/${safeSegment(merchantSlug)}/products/${safeSegment(productSlug)}`,
        ProductViewSchema,
      ),
    getCheckout: (checkoutSessionId) =>
      request(
        `/api/v1/checkout-sessions/${safeSegment(checkoutSessionId)}`,
        CheckoutSnapshotViewSchema,
      ),
    getReceipt: (orderId) => request(`/api/v1/receipts/${safeSegment(orderId)}`, ReceiptViewSchema),
    getSplit: (reference) =>
      request(`/api/v1/split-links/${safeSegment(reference)}`, SplitViewSchema),
    getMerchantDashboard: () => request('/api/v1/merchant/summary', MerchantDashboardViewSchema),
    getJudgeProof: (evidenceId) =>
      request(`/api/v1/judge/orders/${safeSegment(evidenceId)}/proof`, JudgeProofViewSchema),
    startCheckout: (input, idempotencyKey) =>
      request('/api/v1/checkout-sessions', CommandReceiptSchema, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      }),
    createProduct: (input, idempotencyKey) =>
      request('/api/v1/merchant/products', CommandReceiptSchema, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      }),
  };
}

export function createDeterministicFrontendTransport(): FrontendTransport {
  const accepted = (resourceId: string): CommandReceipt => ({
    accepted: true,
    requestId: 'req_deterministic_frontend',
    resourceId,
  });
  return {
    getPublicProduct: async () => demoProduct,
    getCheckout: async (checkoutSessionId) => ({
      ...demoCheckout('product_ready'),
      checkoutSessionId,
    }),
    getReceipt: async () => demoReceipt,
    getSplit: async () => demoSplit,
    getMerchantDashboard: async () => demoDashboard,
    getJudgeProof: async () => demoJudgeProof,
    startCheckout: async () => accepted('chk_demo_sunday_table'),
    createProduct: async () => accepted('prd_demo_new'),
  };
}

export function createFailClosedFrontendTransport(): FrontendTransport {
  const unavailable = (): never => {
    throw new FrontendTransportError(
      'CONFIGURATION_UNAVAILABLE',
      'Live actions are disabled until the server confirms provider and contract readiness.',
      false,
    );
  };
  return {
    getPublicProduct: async () => unavailable(),
    getCheckout: async () => unavailable(),
    getReceipt: async () => unavailable(),
    getSplit: async () => unavailable(),
    getMerchantDashboard: async () => unavailable(),
    getJudgeProof: async () => unavailable(),
    startCheckout: async () => unavailable(),
    createProduct: async () => unavailable(),
  };
}
