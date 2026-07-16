import { AppError } from '@opentab/shared';
import { handleMutation, handleQuery, secretDigest } from './http.js';
import { type RouteContext, routeParam } from './params.js';
import {
  ChallengeBodySchema,
  DelegationEvidenceBodySchema,
  OpaqueReferenceSchema,
} from './schemas.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new AppError('INTERNAL_ERROR', `${label} was not resolved.`);
  return value;
}

function subjectBody(
  request: Request,
  registry: Parameters<typeof secretDigest>[0],
  actor: { id: string; walletAddress: string },
) {
  const network = registry.networkSubject(request);
  const device = request.headers.get('user-agent') ?? 'unknown-device';
  if (network.length < 1 || network.length > 512 || device.length > 1_024) {
    throw new AppError('CONFIGURATION_INVALID', 'The privacy subject input is invalid.');
  }
  return {
    identitySubjectHash: secretDigest(registry, 'sponsor-identity-subject', actor.id),
    addressSubjectHash: secretDigest(
      registry,
      'sponsor-address-subject',
      actor.walletAddress.toLowerCase(),
    ),
    networkSubjectHash: secretDigest(registry, 'sponsor-network-subject', network),
    deviceSubjectHash: secretDigest(registry, 'sponsor-device-subject', device),
  };
}

export function getWalletReadiness(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    feature: 'particle-reads',
    execute: async ({ registry, actor }) =>
      registry.resourceQueries.getWalletReadiness(required(actor, 'Actor')),
  });
}

export function getWalletBalance(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    feature: 'particle-reads',
    execute: ({ registry, actor }) =>
      registry.resourceQueries.getWalletBalance(required(actor, 'Actor')),
  });
}

export function recordDelegationEvidence(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: DelegationEvidenceBodySchema,
    auth: 'required',
    idempotency: true,
    execute: ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) =>
      registry.commands.recordDelegationEvidence({
        actor: required(actor, 'Actor'),
        body,
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      }),
  });
}

export function evaluateBootstrapEligibility(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: ChallengeBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'bootstrap-sponsor',
    execute: ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) => {
      const resolvedActor = required(actor, 'Actor');
      return registry.commands.evaluateBootstrapEligibility({
        actor: resolvedActor,
        body: { ...body, ...subjectBody(request, registry, resolvedActor) },
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      });
    },
  });
}

export function requestBootstrapGrant(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: ChallengeBodySchema,
    auth: 'required',
    idempotency: true,
    feature: 'bootstrap-sponsor',
    status: 201,
    execute: ({ registry, actor, body, idempotencyKeyHash, requestHash, requestId }) => {
      const resolvedActor = required(actor, 'Actor');
      return registry.commands.requestBootstrapGrant({
        actor: resolvedActor,
        body: {
          ...body,
          recipient: resolvedActor.walletAddress,
          ...subjectBody(request, registry, resolvedActor),
        },
        idempotencyKeyHash: required(idempotencyKeyHash, 'Idempotency key'),
        requestHash,
        requestId,
      });
    },
  });
}

export async function getBootstrapGrant(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      registry.queries
        .getSponsorGrantForActor(
          await routeParam(context, 'grantId', OpaqueReferenceSchema),
          required(actor, 'Actor'),
        )
        .then((grant) => (grant === undefined ? undefined : { grant })),
  });
}
