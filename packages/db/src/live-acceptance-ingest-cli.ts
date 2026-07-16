import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppError,
  ChainIdSchema,
  createLiveAcceptanceReceipt,
  digestLiveAcceptanceDeploymentConfig,
  digestLiveAcceptanceFile,
  digestUnknown,
  EvidenceDigestSchema,
  EvmAddressSchema,
  LiveAcceptanceArtifactSchema,
  LiveAcceptanceEvidenceInputSchema,
  serializeLiveAcceptanceArtifact,
  verifyLiveAcceptanceReceipt,
} from '@opentab/shared';
import { z } from 'zod';
import { createDatabase } from './client.js';
import { PostgresLiveAcceptanceEvidenceStore } from './live-acceptance-evidence.js';
import { safeAcceptanceIngestError } from './live-acceptance-ingest-errors.js';
import { PostgresUnitOfWork } from './unit-of-work.js';

const EnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['demo-mainnet', 'production']),
    LIVE_ACCEPTANCE_RELEASE_ID: z.string().regex(/^[0-9a-fA-F]{40}$/),
    DATABASE_URL_EVIDENCE_WRITER: z.string().min(1),
    LIVE_ACCEPTANCE_ATTESTATION_SECRET: z.string().min(32),
    NEXT_PUBLIC_CHECKOUT_ADDRESS: EvmAddressSchema,
    NEXT_PUBLIC_PASS_ADDRESS: EvmAddressSchema,
    NEXT_PUBLIC_USDC_ADDRESS: EvmAddressSchema,
    CONFIRMATION_DEPTH: z.string().regex(/^[1-9][0-9]*$/),
    PARTICLE_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(500),
    PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: z
      .string()
      .transform((value) => [
        ...new Set(value.split(',').map((entry) => ChainIdSchema.parse(entry.trim()))),
      ]),
    PARTICLE_ALLOWED_SOURCE_ASSETS: z
      .string()
      .transform((value) => [
        ...new Set(
          value.split(',').map((entry) => z.enum(['USDC', 'USDT', 'ETH']).parse(entry.trim())),
        ),
      ]),
    PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: EvmAddressSchema,
    PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: EvidenceDigestSchema,
    PARTICLE_RESPONSE_PROFILE_ID: z.string().regex(/^[A-Za-z0-9_.:/-]{3,120}$/),
    PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_AUTH_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_SUBMISSION_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_STATUS_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_SOURCE_CALL_PROFILES_JSON: z.string().transform((value, context) => {
      try {
        return z.array(z.unknown()).min(1).parse(JSON.parse(value));
      } catch {
        context.addIssue({ code: 'custom', message: 'Source call profiles must be valid JSON' });
        return z.NEVER;
      }
    }),
  })
  .passthrough();

function evidenceInputPath(values: readonly string[]): string {
  const positional = values.filter((value) => value !== '--');
  if (positional.length !== 1) {
    throw new Error('Exactly one protected acceptance evidence path is required');
  }
  const value = positional[0];
  if (value === undefined) throw new Error('A protected acceptance evidence path is required');
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const directory = path.join(root, 'artifacts', 'autonomous-build', 'evidence');
  const realDirectory = fs.realpathSync(directory);
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${directory}${path.sep}`) || !resolved.endsWith('.ingest.json')) {
    throw new Error('Acceptance evidence must use the protected evidence directory');
  }
  if (fs.realpathSync(path.dirname(resolved)) !== realDirectory) {
    throw new Error('Acceptance evidence parent directory is not trusted');
  }
  const metadata = fs.lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw new Error('Acceptance evidence must be a bounded regular file');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Acceptance evidence permissions are too broad');
  }
  return resolved;
}

function readProtectedFile(target: string): string {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) {
      throw new Error('Acceptance evidence must be a bounded regular file');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error('Acceptance evidence permissions are too broad');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function readEvidenceFile(target: string): unknown {
  return JSON.parse(readProtectedFile(target));
}

function acceptedReceiptPath(evidencePath: string): string {
  if (!evidencePath.endsWith('.ingest.json')) {
    throw new Error('Acceptance evidence path suffix is invalid');
  }
  return `${evidencePath.slice(0, -'.ingest.json'.length)}.accepted.json`;
}

function validateArtifactBinding(
  evidence: z.infer<typeof LiveAcceptanceEvidenceInputSchema>,
  artifactContent: string,
): void {
  const artifact = LiveAcceptanceArtifactSchema.parse(JSON.parse(artifactContent));
  if (evidence.settlement.event.eventName !== 'OrderPaid') {
    throw new AppError('PAYMENT_EVENT_MISMATCH', 'OrderPaid acceptance evidence is required.');
  }
  if (artifactContent !== serializeLiveAcceptanceArtifact(artifact)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'The pending acceptance artifact is not in canonical serialized form.',
    );
  }
  const { providerOperationId: recoveryProviderOperationId, ...artifactRecovery } =
    artifact.recovery;
  const artifactRoute = {
    totalUsd: artifact.particle.totalUsd,
    estimatedFeeUsd: artifact.particle.estimatedFeeUsd,
    slippageBps: artifact.particle.slippageBps,
    quotedAt: artifact.particle.quotedAt,
    expiresAt: artifact.particle.expiresAt,
    previewDigest: artifact.particle.previewDigest,
    sources: artifact.particle.sources,
    ...(artifact.particle.activityUrl === undefined
      ? {}
      : { activityUrl: artifact.particle.activityUrl }),
  };
  if (
    artifact.environment !== evidence.environment ||
    artifact.releaseId !== evidence.releaseId ||
    artifact.deploymentConfigDigest.toLowerCase() !==
      evidence.deploymentConfigDigest.toLowerCase() ||
    artifact.orderId !== evidence.orderId ||
    artifact.paymentAttemptId !== evidence.paymentAttemptId ||
    artifact.startedAt !== evidence.startedAt ||
    artifact.capturedAt !== evidence.capturedAt ||
    artifact.ownerAddressBefore.toLowerCase() !==
      evidence.settlement.event.fields.payer.toLowerCase() ||
    artifact.ownerAddressAfter.toLowerCase() !==
      evidence.settlement.event.fields.payer.toLowerCase() ||
    artifact.ownerAddressBefore.toLowerCase() !== evidence.context.ownerAddress.toLowerCase() ||
    artifact.authMethod !== evidence.context.authMethod ||
    artifact.activationPath !== evidence.context.activationPath ||
    artifact.delegationTransactionHash?.toLowerCase() !==
      evidence.context.delegationTransactionHash.toLowerCase() ||
    artifact.sponsorGrantTransactionHash?.toLowerCase() !==
      evidence.context.sponsorGrantTransactionHash?.toLowerCase() ||
    artifact.particle.protocolVersion !== evidence.context.particleProtocolVersion ||
    digestUnknown(artifact.particle.safeAccountIdentifiers) !==
      digestUnknown(evidence.context.safeAccountIdentifiers) ||
    artifact.particle.providerOperationId !== evidence.providerOperationId ||
    recoveryProviderOperationId !== evidence.providerOperationId ||
    digestUnknown(artifact.providerOperation) !== digestUnknown(evidence.providerOperation) ||
    digestUnknown(artifactRoute) !== digestUnknown(evidence.route) ||
    digestUnknown(artifact.arbitrum) !== digestUnknown(evidence.settlement) ||
    digestUnknown(artifactRecovery) !== digestUnknown(evidence.recovery) ||
    digestUnknown(artifact.timingMs) !== digestUnknown(evidence.timingMs)
  ) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'The pending artifact does not match the acceptance ingestion record.',
    );
  }
}

function writeAcceptedReceipt(input: {
  evidencePath: string;
  secret: string;
  evidence: z.infer<typeof LiveAcceptanceEvidenceInputSchema>;
  accepted: { readonly id: string; readonly digest: string };
  ingestionFileDigest: ReturnType<typeof digestLiveAcceptanceFile>;
  artifactFileDigest: ReturnType<typeof digestLiveAcceptanceFile>;
}): void {
  const target = acceptedReceiptPath(input.evidencePath);
  const expectedBinding = {
    schemaVersion: 1 as const,
    status: 'accepted' as const,
    evidenceId: input.accepted.id,
    releaseId: input.evidence.releaseId,
    deploymentConfigDigest: input.evidence.deploymentConfigDigest,
    orderId: input.evidence.orderId,
    paymentAttemptId: input.evidence.paymentAttemptId,
    providerOperationId: input.evidence.providerOperationId,
    payloadDigest: input.accepted.digest,
    ingestionFileDigest: input.ingestionFileDigest,
    artifactFileDigest: input.artifactFileDigest,
  };
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const receipt = createLiveAcceptanceReceipt(input.secret, {
      ...expectedBinding,
      acceptedAt: new Date().toISOString(),
    });
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, target);
      const directoryDescriptor = fs.openSync(path.dirname(target), fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const existing = verifyLiveAcceptanceReceipt(input.secret, readEvidenceFile(target));
      if (
        existing.schemaVersion !== expectedBinding.schemaVersion ||
        existing.status !== expectedBinding.status ||
        existing.evidenceId !== expectedBinding.evidenceId ||
        existing.releaseId !== expectedBinding.releaseId ||
        existing.deploymentConfigDigest.toLowerCase() !==
          expectedBinding.deploymentConfigDigest.toLowerCase() ||
        existing.orderId !== expectedBinding.orderId ||
        existing.paymentAttemptId !== expectedBinding.paymentAttemptId ||
        existing.providerOperationId !== expectedBinding.providerOperationId ||
        existing.payloadDigest.toLowerCase() !== expectedBinding.payloadDigest.toLowerCase() ||
        existing.ingestionFileDigest.toLowerCase() !==
          expectedBinding.ingestionFileDigest.toLowerCase() ||
        existing.artifactFileDigest.toLowerCase() !==
          expectedBinding.artifactFileDigest.toLowerCase()
      ) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The existing acceptance receipt does not match the accepted evidence.',
        );
      }
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let cleanupError: unknown;
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && cleanupError === undefined) {
      cleanupError = error;
    }
  }
  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const target = evidenceInputPath(process.argv.slice(2));
  const ingestionContent = readProtectedFile(target);
  const evidence = LiveAcceptanceEvidenceInputSchema.parse(JSON.parse(ingestionContent));
  const artifactPath = target.replace(/\.ingest\.json$/, '.pending.json');
  const artifactContent = readProtectedFile(artifactPath);
  validateArtifactBinding(evidence, artifactContent);
  if (evidence.environment !== environment.APP_ENV) {
    throw new AppError('CONFIGURATION_INVALID', 'Acceptance environment does not match runtime.');
  }
  if (evidence.releaseId.toLowerCase() !== environment.LIVE_ACCEPTANCE_RELEASE_ID.toLowerCase()) {
    throw new AppError('CONFIGURATION_INVALID', 'Acceptance release does not match runtime.');
  }
  const confirmations = BigInt(environment.CONFIRMATION_DEPTH);
  if (confirmations < 1n || confirmations > 100n) {
    throw new AppError('CONFIGURATION_INVALID', 'Acceptance confirmation depth is invalid.');
  }
  const deploymentConfigDigest = digestLiveAcceptanceDeploymentConfig({
    domain: 'opentab/live-acceptance-deployment-config',
    releaseId: environment.LIVE_ACCEPTANCE_RELEASE_ID,
    environment: environment.APP_ENV,
    chainId: '42161',
    checkoutAddress: environment.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: environment.NEXT_PUBLIC_PASS_ADDRESS,
    tokenAddress: environment.NEXT_PUBLIC_USDC_ADDRESS,
    expectedDelegationImplementation: environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
    expectedDelegationCodeHash: environment.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH,
    particleSdkVersion: '2.0.3',
    particleResponseProfileId: environment.PARTICLE_RESPONSE_PROFILE_ID,
    particleFixtureSetDigest: digestUnknown({
      deployments: environment.PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST,
      authorization: environment.PARTICLE_AUTH_FIXTURE_DIGEST,
      submission: environment.PARTICLE_SUBMISSION_FIXTURE_DIGEST,
      status: environment.PARTICLE_STATUS_FIXTURE_DIGEST,
    }),
    particleSourceCallProfilesDigest: digestUnknown(environment.PARTICLE_SOURCE_CALL_PROFILES_JSON),
    confirmationDepth: environment.CONFIRMATION_DEPTH,
    maximumSlippageBps: environment.PARTICLE_MAX_SLIPPAGE_BPS.toString(),
    allowedSourceChainIds: environment.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS,
    allowedSourceAssets: environment.PARTICLE_ALLOWED_SOURCE_ASSETS,
  });
  if (deploymentConfigDigest.toLowerCase() !== evidence.deploymentConfigDigest.toLowerCase()) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Acceptance evidence does not match the active deployment configuration.',
    );
  }
  const handle = createDatabase({
    url: environment.DATABASE_URL_EVIDENCE_WRITER,
    maxConnections: 1,
    applicationName: 'opentab-live-acceptance-evidence-writer',
    idleTimeoutSeconds: 5,
  });
  try {
    const store = new PostgresLiveAcceptanceEvidenceStore(new PostgresUnitOfWork(handle.db), {
      checkoutAddress: environment.NEXT_PUBLIC_CHECKOUT_ADDRESS,
      passAddress: environment.NEXT_PUBLIC_PASS_ADDRESS,
      tokenAddress: environment.NEXT_PUBLIC_USDC_ADDRESS,
      deploymentConfigDigest,
      minimumConfirmations: confirmations,
      allowedSourceChainIds: environment.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS,
      allowedSourceSymbols: environment.PARTICLE_ALLOWED_SOURCE_ASSETS,
      maximumSlippageBps: BigInt(environment.PARTICLE_MAX_SLIPPAGE_BPS),
      attestationSecret: environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
    });
    const accepted = await store.accept(evidence);
    writeAcceptedReceipt({
      evidencePath: target,
      secret: environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
      evidence,
      accepted,
      ingestionFileDigest: digestLiveAcceptanceFile(ingestionContent),
      artifactFileDigest: digestLiveAcceptanceFile(artifactContent),
    });
    process.stdout.write(`${JSON.stringify({ status: 'accepted', ...accepted })}\n`);
  } finally {
    await handle.close();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeAcceptanceIngestError(error))}\n`);
  process.exitCode = 1;
});
