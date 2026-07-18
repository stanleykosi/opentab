import {
  AppError,
  type CurrentUser,
  ParticleCompatibilityProfileSchema,
  ProductIdSchema,
} from '@opentab/shared';
import { z } from 'zod';
import { handleMutation, handleQuery } from './http.js';
import type { BackendApiRegistry } from './registry.js';

const OperatorTokenSchema = z.string().min(32).max(512);
const UnlockBodySchema = z.object({ operatorToken: OperatorTokenSchema }).strict();
const CertifyBodySchema = z
  .object({
    operatorToken: OperatorTokenSchema,
    profile: ParticleCompatibilityProfileSchema,
    productId: ProductIdSchema,
  })
  .strict();
const FinalizeBodySchema = z
  .object({
    operatorToken: OperatorTokenSchema,
    paymentAttemptId: z.string().min(3).max(128),
    submissionEvidenceDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    statusEvidenceDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict();

function service(registry: BackendApiRegistry) {
  if (registry.particleCertification === undefined) {
    throw new AppError(
      'FEATURE_DISABLED',
      'Particle operator certification is not configured for this environment.',
    );
  }
  return registry.particleCertification;
}

function requiredActor(actor: CurrentUser | undefined): CurrentUser {
  if (actor === undefined) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
  return actor;
}

export async function getParticleCertificationStatus(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) =>
      service(registry).getStatus({
        actor: requiredActor(actor),
      }),
  });
}

export async function unlockParticleCertification(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: UnlockBodySchema,
    auth: 'required',
    csrf: true,
    execute: async ({ registry, actor, body }) =>
      service(registry).getStatus({
        actor: requiredActor(actor),
        operatorToken: body.operatorToken,
      }),
  });
}

export async function certifyParticleCompatibility(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: CertifyBodySchema,
    auth: 'required',
    csrf: true,
    idempotency: true,
    execute: async ({ registry, actor, body }) =>
      service(registry).certify({
        actor: requiredActor(actor),
        operatorToken: body.operatorToken,
        profile: body.profile,
        productId: body.productId,
      }),
  });
}

export async function finalizeParticleCertification(request: Request): Promise<Response> {
  return handleMutation({
    request,
    schema: FinalizeBodySchema,
    auth: 'required',
    csrf: true,
    idempotency: true,
    execute: async ({ registry, actor, body }) =>
      service(registry).finalize({
        actor: requiredActor(actor),
        ...body,
      }),
  });
}
