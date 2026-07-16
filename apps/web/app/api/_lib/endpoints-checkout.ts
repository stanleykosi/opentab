import {
  AppError,
  CheckoutSessionIdSchema,
  OrderIdSchema,
  PaymentAttemptIdSchema,
} from '@opentab/shared';
import { handleMutation, handleQuery } from './http.js';
import { type RouteContext, routeParam } from './params.js';
import {
  BindCheckoutBodySchema,
  CheckoutSessionBodySchema,
  EmptyBodySchema,
  PreparedPaymentBodySchema,
  QuoteRefreshBodySchema,
  RecoveryBodySchema,
  RegisterSubmissionBodySchema,
  StartSubmissionBodySchema,
} from './schemas.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new AppError('INTERNAL_ERROR', `${label} was not resolved.`);
  return value;
}

export function createCheckoutSession(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: CheckoutSessionBodySchema,
    auth: 'optional',
    idempotency: true,
    feature: 'checkout-preview',
    status: 201,
    execute: ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.createCheckoutSession({
        ...(actor === undefined ? {} : { actor }),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function getCheckoutSession(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleQuery({
    request,
    auth: 'optional',
    execute: async ({ registry, actor }) => {
      const checkoutSessionId = await routeParam(
        context,
        'checkoutSessionId',
        CheckoutSessionIdSchema,
      );
      const snapshot = await registry.queries.getCheckoutForActor(checkoutSessionId, actor);
      if (snapshot === undefined) return undefined;
      const product = await registry.queries.getPublicProductById(snapshot.session.productId);
      return product === undefined
        ? undefined
        : { ...snapshot, product: product.product, merchant: product.merchant };
    },
  });
}

export async function bindCheckoutSession(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: BindCheckoutBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'checkout-preview',
    execute: async ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.bindCheckoutSession({
        actor: required(actor, 'Actor'),
        checkoutSessionId: await routeParam(context, 'checkoutSessionId', CheckoutSessionIdSchema),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function refreshCheckoutQuote(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: QuoteRefreshBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'checkout-preview',
    execute: async ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.refreshCheckoutQuote({
        actor: required(actor, 'Actor'),
        checkoutSessionId: await routeParam(context, 'checkoutSessionId', CheckoutSessionIdSchema),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function createPaymentAttempt(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: EmptyBodySchema,
    allowEmptyBody: true,
    auth: 'required',
    idempotency: true,
    feature: 'checkout-submit',
    status: 201,
    execute: async ({ registry, actor, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.createPaymentAttempt({
        actor: required(actor, 'Actor'),
        checkoutSessionId: await routeParam(context, 'checkoutSessionId', CheckoutSessionIdSchema),
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function recordPreparedPayment(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: PreparedPaymentBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'checkout-submit',
    execute: async ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.recordPreparedPayment({
        actor: required(actor, 'Actor'),
        paymentAttemptId: await routeParam(context, 'paymentAttemptId', PaymentAttemptIdSchema),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function startPaymentSubmission(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: StartSubmissionBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'checkout-submit',
    execute: async ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.startPaymentSubmission({
        actor: required(actor, 'Actor'),
        paymentAttemptId: await routeParam(context, 'paymentAttemptId', PaymentAttemptIdSchema),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function registerPaymentSubmission(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: RegisterSubmissionBodySchema,
    auth: 'required',
    idempotency: true,
    execute: async ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.registerPaymentSubmission({
        actor: required(actor, 'Actor'),
        paymentAttemptId: await routeParam(context, 'paymentAttemptId', PaymentAttemptIdSchema),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function getPaymentAttempt(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) => {
      const paymentAttemptId = await routeParam(
        context,
        'paymentAttemptId',
        PaymentAttemptIdSchema,
      );
      const workflow = await registry.queries.getPaymentWorkflowForActor(
        paymentAttemptId,
        required(actor, 'Actor'),
      );
      return workflow === undefined ? undefined : { ...workflow };
    },
  });
}

export async function recoverPaymentAttempt(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: RecoveryBodySchema,
    auth: 'required',
    idempotency: true,
    execute: async ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.recoverPaymentAttempt({
        actor: required(actor, 'Actor'),
        paymentAttemptId: await routeParam(context, 'paymentAttemptId', PaymentAttemptIdSchema),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export async function getPaymentRecovery(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getPaymentRecovery(
        await routeParam(context, 'paymentAttemptId', PaymentAttemptIdSchema),
        required(actor, 'Actor'),
      ),
  });
}

export async function getOrder(request: Request, context: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) => {
      const order = await registry.queries.getOrderForActor(
        await routeParam(context, 'orderId', OrderIdSchema),
        required(actor, 'Actor'),
      );
      return order === undefined ? undefined : { ...order };
    },
  });
}

export async function getReceipt(request: Request, context: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getReceipt(
        await routeParam(context, 'orderId', OrderIdSchema),
        required(actor, 'Actor'),
      ),
  });
}
