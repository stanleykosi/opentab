import { AppError, type CurrentUser, OrderIdSchema, SplitIdSchema } from '@opentab/shared';
import { handleMutation, handleQuery } from './http.js';
import { type RouteContext, routeParam } from './params.js';
import {
  OpaqueReferenceSchema,
  SplitBodySchema,
  SplitCapabilityReferenceSchema,
  SplitInvitationBodySchema,
  SplitPrepareBodySchema,
  SplitRevokeBodySchema,
  SplitSubmissionBodySchema,
} from './schemas.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new AppError('INTERNAL_ERROR', `${label} was not resolved.`);
  return value;
}

function commandContext(input: {
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

export async function createSplit(request: Request, route: RouteContext): Promise<Response> {
  return handleMutation({
    request,
    schema: SplitBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'splits',
    status: 201,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.createSplit({
        ...commandContext(input),
        orderId: await routeParam(route, 'orderId', OrderIdSchema),
        body,
      }),
  });
}

export async function getSplit(request: Request, route: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'optional',
    execute: async ({ registry, actor }) => {
      const split = await registry.queries.getSplitByCapability(
        await routeParam(route, 'reference', SplitCapabilityReferenceSchema),
        new Date(),
        actor,
      );
      return split === undefined ? undefined : { ...split };
    },
  });
}

export async function inviteSplitParticipants(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: SplitInvitationBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'splits',
    status: 201,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.inviteSplitParticipants({
        ...commandContext(input),
        splitId: await routeParam(route, 'splitId', SplitIdSchema),
        body,
      }),
  });
}

export async function revokeSplit(request: Request, route: RouteContext): Promise<Response> {
  return handleMutation({
    request,
    schema: SplitRevokeBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'splits',
    execute: async ({ registry, body, ...input }) =>
      registry.commands.revokeSplit({
        ...commandContext(input),
        splitId: await routeParam(route, 'splitId', SplitIdSchema),
        body,
      }),
  });
}

export async function prepareSplitPayment(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: SplitPrepareBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'splits',
    status: 201,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.prepareSplitPayment({
        ...commandContext(input),
        splitId: await routeParam(route, 'splitId', SplitIdSchema),
        body,
      }),
  });
}

export async function registerSplitPaymentSubmission(
  request: Request,
  route: RouteContext,
): Promise<Response> {
  return handleMutation({
    request,
    schema: SplitSubmissionBodySchema,
    auth: 'required',
    idempotency: true,
    execute: async ({ registry, body, ...input }) =>
      registry.commands.registerSplitPaymentSubmission({
        ...commandContext(input),
        splitPaymentAttemptId: await routeParam(
          route,
          'splitPaymentAttemptId',
          OpaqueReferenceSchema,
        ),
        body,
      }),
  });
}

export async function getSplitPayment(request: Request, route: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getSplitPayment(
        await routeParam(route, 'splitPaymentAttemptId', OpaqueReferenceSchema),
        required(actor, 'Actor'),
      ),
  });
}

export async function getJudgeProof(request: Request, route: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'none',
    feature: 'judge-mode',
    execute: async ({ registry }) => {
      if (new URL(request.url).search.length > 0) {
        throw new AppError('VALIDATION_FAILED', 'The Judge proof capability is invalid.');
      }
      const shareToken = request.headers.get('x-opentab-judge-token') ?? undefined;
      if (shareToken !== undefined && !/^[A-Za-z0-9_-]{32,256}$/.test(shareToken)) {
        throw new AppError('VALIDATION_FAILED', 'The Judge proof capability is invalid.');
      }
      const proof = await registry.queries.getJudgeProof(
        await routeParam(route, 'orderId', OrderIdSchema),
        shareToken,
      );
      return proof === undefined ? undefined : { proof };
    },
  });
}
