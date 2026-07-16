import { AppError, type CurrentUser, OrderIdSchema, ProductIdSchema } from '@opentab/shared';
import { z } from 'zod';
import { handleMutation, handleQuery } from './http.js';
import { queryInput, type RouteContext, routeParam } from './params.js';
import {
  CheckoutLinkBodySchema,
  ContractOperationSubmissionBodySchema,
  EmptyBodySchema,
  FinancialSubmissionBodySchema,
  JudgeEvidencePublishBodySchema,
  LoyaltyBodySchema,
  MerchantBodySchema,
  MerchantPatchBodySchema,
  OpaqueReferenceSchema,
  ProductBodySchema,
  ProductPatchBodySchema,
  RefundBodySchema,
  WithdrawalBodySchema,
} from './schemas.js';

const ListQuerySchema = z
  .object({
    cursor: z.string().min(4).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
const OrderListQuerySchema = ListQuerySchema.extend({
  status: z
    .enum([
      'created',
      'submitted',
      'executing',
      'paid',
      'partially_refunded',
      'refunded',
      'failed_confirmed',
      'mismatch',
      'orphaned',
    ])
    .optional(),
  productId: ProductIdSchema.optional(),
}).strict();

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new AppError('INTERNAL_ERROR', `${label} was not resolved.`);
  return value;
}

function context(input: {
  actor?: CurrentUser;
  idempotencyKeyHash?: string;
  requestHash: string;
  requestId: string;
}) {
  return {
    actor: required(input.actor, 'Actor'),
    idempotencyKeyHash: required(input.idempotencyKeyHash, 'Idempotency key'),
    requestHash: input.requestHash,
    requestId: input.requestId,
  };
}

export function getMerchantProfile(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getMerchantProfile(required(actor, 'Actor')),
  });
}

export function createMerchantProfile(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: MerchantBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    status: 201,
    execute: ({ registry, body, ...input }) =>
      registry.commands.createMerchant({ ...context(input), body }),
  });
}

export function updateMerchantProfile(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: MerchantPatchBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    execute: ({ registry, body, ...input }) =>
      registry.commands.updateMerchantProfile({ ...context(input), body }),
  });
}

export function getMerchantMembership(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getMerchantMembership(required(actor, 'Actor')),
  });
}

export function onboardMerchant(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: EmptyBodySchema,
    allowEmptyBody: true,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    status: 202,
    execute: ({ registry, ...input }) =>
      registry.commands.onboardMerchant({ ...context(input), body: {} }),
  });
}

export function getMerchantSummary(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) => {
      const summary = await registry.queries.getMerchantSummary(required(actor, 'Actor'));
      return summary === undefined ? undefined : { ...summary };
    },
  });
}

export function listMerchantOrders(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) => {
      const query = queryInput(request, OrderListQuerySchema);
      const page = await registry.queries.listMerchantOrders({
        actor: required(actor, 'Actor'),
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.productId === undefined ? {} : { productId: query.productId }),
      });
      return { ...page };
    },
  });
}

export function listMerchantProducts(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) => {
      const query = queryInput(request, ListQuerySchema);
      const page = await registry.queries.listMerchantProducts({
        actor: required(actor, 'Actor'),
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return { ...page };
    },
  });
}

export function createProduct(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: ProductBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    status: 202,
    execute: ({ registry, body, ...input }) =>
      registry.commands.createProduct({ ...context(input), body }),
  });
}

export async function updateProduct(request: Request, route: RouteContext): Promise<Response> {
  return handleMutation({
    request,
    schema: ProductPatchBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    execute: async ({ registry, body, ...input }) =>
      registry.commands.updateProduct({
        ...context(input),
        productId: await routeParam(route, 'productId', ProductIdSchema),
        body,
      }),
  });
}

export async function getMerchantProduct(request: Request, route: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.queries.getMerchantProductForActor({
        actor: required(actor, 'Actor'),
        productId: await routeParam(route, 'productId', ProductIdSchema),
      }),
  });
}

function productStatus(
  request: Request,
  route: RouteContext,
  status: 'publishing' | 'paused' | 'archived',
): Promise<Response> {
  return handleMutation({
    request,
    schema: EmptyBodySchema,
    allowEmptyBody: true,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    status: 202,
    execute: async ({ registry, ...input }) =>
      registry.commands.changeProductStatus({
        ...context(input),
        productId: await routeParam(route, 'productId', ProductIdSchema),
        status,
      }),
  });
}

export const publishProduct = (request: Request, route: RouteContext) =>
  productStatus(request, route, 'publishing');
export const pauseProduct = (request: Request, route: RouteContext) =>
  productStatus(request, route, 'paused');
export const archiveProduct = (request: Request, route: RouteContext) =>
  productStatus(request, route, 'archived');

export function createCheckoutLink(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: CheckoutLinkBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    status: 201,
    execute: ({ registry, body, ...input }) =>
      registry.commands.createCheckoutLink({ ...context(input), body }),
  });
}

export async function prepareRefund(request: Request, route: RouteContext): Promise<Response> {
  return handleMutation({
    request,
    schema: RefundBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'refunds',
    status: 202,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.prepareRefund({
        ...context(input),
        orderId: await routeParam(route, 'orderId', OrderIdSchema),
        body,
      }),
  });
}

export async function registerRefundSubmission(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: FinancialSubmissionBodySchema,
    auth: 'required',
    idempotency: true,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.registerRefundSubmission({
        ...context(input),
        refundId: await routeParam(route, 'refundId', OpaqueReferenceSchema),
        body,
      }),
  });
}

export async function getRefund(request: Request, route: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getRefund(
        await routeParam(route, 'refundId', OpaqueReferenceSchema),
        required(actor, 'Actor'),
      ),
  });
}

export function getSettlement(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: ({ registry, actor }) =>
      registry.resourceQueries.getSettlement(required(actor, 'Actor')),
  });
}

export function prepareWithdrawal(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: WithdrawalBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'withdrawals',
    status: 202,
    execute: ({ registry, body, ...input }) =>
      registry.commands.prepareWithdrawal({ ...context(input), body }),
  });
}

export async function registerWithdrawalSubmission(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: FinancialSubmissionBodySchema,
    auth: 'required',
    idempotency: true,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.registerWithdrawalSubmission({
        ...context(input),
        withdrawalId: await routeParam(route, 'withdrawalId', OpaqueReferenceSchema),
        body,
      }),
  });
}

export async function getWithdrawal(request: Request, route: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getWithdrawal(
        await routeParam(route, 'withdrawalId', OpaqueReferenceSchema),
        required(actor, 'Actor'),
      ),
  });
}

export function getLoyaltyStatus(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: ({ registry, actor }) =>
      registry.resourceQueries.getLoyaltyStatus(required(actor, 'Actor')),
  });
}

export function updateLoyalty(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: LoyaltyBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'merchant-mutations',
    execute: ({ registry, body, ...input }) =>
      registry.commands.updateLoyalty({ ...context(input), body }),
  });
}

export async function registerContractOperationSubmission(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: ContractOperationSubmissionBodySchema,
    auth: 'required',
    idempotency: true,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.registerContractOperationSubmission({
        ...context(input),
        operationId: await routeParam(route, 'operationId', OpaqueReferenceSchema),
        body,
      }),
  });
}

export async function getContractOperation(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getContractOperation(
        await routeParam(route, 'operationId', OpaqueReferenceSchema),
        required(actor, 'Actor'),
      ),
  });
}

export async function materializeJudgeEvidence(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: EmptyBodySchema,
    allowEmptyBody: true,
    auth: 'required',
    idempotency: true,
    feature: 'judge-mode',
    status: 201,
    execute: async ({ registry, ...input }) =>
      registry.commands.materializeJudgeEvidence({
        ...context(input),
        orderId: await routeParam(route, 'orderId', OrderIdSchema),
      }),
  });
}

export async function publishJudgeEvidence(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: JudgeEvidencePublishBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'judge-mode',
    execute: async ({ registry, body, ...input }) =>
      registry.commands.publishJudgeEvidence({
        ...context(input),
        orderId: await routeParam(route, 'orderId', OrderIdSchema),
        body,
      }),
  });
}

export async function revokeJudgeEvidence(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: EmptyBodySchema,
    allowEmptyBody: true,
    auth: 'required',
    idempotency: true,
    feature: 'judge-mode',
    execute: async ({ registry, ...input }) =>
      registry.commands.revokeJudgeEvidence({
        ...context(input),
        orderId: await routeParam(route, 'orderId', OrderIdSchema),
      }),
  });
}
