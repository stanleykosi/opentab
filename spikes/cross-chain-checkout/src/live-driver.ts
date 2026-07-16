import { execFile } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createViemArbitrumReadAdapter } from '@opentab/integrations/server';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  CanonicalEventProofSchema,
  digestLiveAcceptanceDeploymentConfig,
  digestLiveAcceptanceFile,
  digestUnknown,
  type EvidenceDigest,
  EvidenceDigestSchema,
  type EvmAddress,
  EvmAddressSchema,
  LiveAcceptanceActivationPathSchema,
  LiveAcceptanceEvidenceInputSchema,
  LiveAcceptanceReceiptSchema,
  OrderIdSchema,
  OrderKeySchema,
  PaymentAttemptIdSchema,
  ProductIdSchema,
  ProviderOperationIdSchema,
  ProviderOperationSchema,
  ReceiptIdSchema,
  sameEvmAddress,
  serializeLiveAcceptanceArtifact,
  TransactionHashSchema,
  verifyLiveAcceptanceReceipt,
} from '@opentab/shared';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import postgres, { type Sql } from 'postgres';
import { getAddress, type Hex, keccak256 } from 'viem';
import { z } from 'zod';
import {
  assessLiveAcceptanceGate,
  LiveAcceptanceArtifactSchema,
  type LiveAcceptanceDependencies,
  type LiveAcceptanceEvidence,
  runLiveAcceptance,
} from './index.js';

const spikeRoot = path.resolve(import.meta.dirname, '..');
const root = path.resolve(spikeRoot, '..', '..');
const bridgeEntry = path.join(spikeRoot, 'src', 'live-browser-entry.ts');
const bridgeName = '__openTabLiveAcceptanceBridge';

export function parseCredentialFreeCdpUrl(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new AppError('CONFIGURATION_INVALID', 'The live CDP endpoint is invalid.', {
      cause: error,
    });
  }
  if (
    !['https:', 'wss:'].includes(endpoint.protocol) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The live CDP endpoint must be credential-free HTTPS or WSS without a query or fragment.',
    );
  }
  return endpoint.toString();
}

const CredentialFreeCdpUrlSchema = z.string().transform((value, context) => {
  try {
    return parseCredentialFreeCdpUrl(value);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Expected a credential-free HTTPS or WSS CDP endpoint without query or fragment.',
    });
    return z.NEVER;
  }
});

const DriverEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['demo-mainnet', 'production']),
    NEXT_PUBLIC_APP_ORIGIN: z.string().url(),
    NEXT_PUBLIC_USDC_ADDRESS: EvmAddressSchema,
    NEXT_PUBLIC_CHECKOUT_ADDRESS: EvmAddressSchema,
    NEXT_PUBLIC_PASS_ADDRESS: EvmAddressSchema,
    PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: EvmAddressSchema,
    PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    PARTICLE_RESPONSE_PROFILE_ID: z.string().regex(/^[A-Za-z0-9_.:/-]{3,120}$/),
    PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_AUTH_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_SUBMISSION_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_STATUS_FIXTURE_DIGEST: EvidenceDigestSchema,
    PARTICLE_SOURCE_CALL_PROFILES_JSON: z.string().min(2),
    ARBITRUM_RPC_URL: z.string().url(),
    ARBITRUM_FALLBACK_RPC_URL: z.string().url(),
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_EVIDENCE_WRITER: z.string().min(1),
    LIVE_ACCEPTANCE_ATTESTATION_SECRET: z.string().min(32),
    PARTICLE_MAX_SLIPPAGE_BPS: z.string().regex(/^(0|[1-9][0-9]*)$/),
    PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: z.string().min(1),
    PARTICLE_ALLOWED_SOURCE_ASSETS: z.string().min(1),
    CONFIRMATION_DEPTH: z.string().regex(/^[1-9][0-9]*$/),
    INDEXER_DEPLOYMENT_BLOCK: z.string().regex(/^[1-9][0-9]*$/),
    LIVE_ACCEPTANCE_PRODUCT_ID: ProductIdSchema,
    LIVE_ACCEPTANCE_RELEASE_ID: z.string().regex(/^[0-9a-fA-F]{40}$/),
    LIVE_ACCEPTANCE_AUTH_METHOD: z.enum(['google', 'email_otp']),
    LIVE_ACCEPTANCE_EMAIL: z.string().email().max(254).optional(),
    LIVE_ACCEPTANCE_CDP_URL: CredentialFreeCdpUrlSchema.optional(),
    LIVE_ACCEPTANCE_HEADLESS: z.enum(['true', 'false']).default('false'),
    LIVE_ACCEPTANCE_MAX_LOOKUP_BLOCKS: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .default('200000'),
    LIVE_ACCEPTANCE_TIMEOUT_MS: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .default('900000'),
    LIVE_ACCEPTANCE_EVIDENCE_PATH: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (
      value.LIVE_ACCEPTANCE_AUTH_METHOD === 'email_otp' &&
      value.LIVE_ACCEPTANCE_EMAIL === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['LIVE_ACCEPTANCE_EMAIL'],
        message: 'LIVE_ACCEPTANCE_EMAIL is required for email OTP acceptance.',
      });
    }
    try {
      const runtimeDatabase = new URL(value.DATABASE_URL);
      const evidenceDatabase = new URL(value.DATABASE_URL_EVIDENCE_WRITER);
      if (
        runtimeDatabase.username.length === 0 ||
        evidenceDatabase.username.length === 0 ||
        runtimeDatabase.username === evidenceDatabase.username
      ) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL_EVIDENCE_WRITER'],
          message: 'The evidence writer must use a distinct authenticated database role.',
        });
      }
      if (
        runtimeDatabase.protocol !== evidenceDatabase.protocol ||
        runtimeDatabase.hostname.toLowerCase() !== evidenceDatabase.hostname.toLowerCase() ||
        runtimeDatabase.port !== evidenceDatabase.port ||
        runtimeDatabase.pathname !== evidenceDatabase.pathname
      ) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL_EVIDENCE_WRITER'],
          message: 'Runtime and evidence-writer roles must target the same PostgreSQL database.',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL_EVIDENCE_WRITER'],
        message: 'The runtime and evidence-writer database URLs must be valid.',
      });
    }
    const timeout = BigInt(value.LIVE_ACCEPTANCE_TIMEOUT_MS);
    if (timeout < 60_000n || timeout > 1_800_000n) {
      context.addIssue({
        code: 'custom',
        path: ['LIVE_ACCEPTANCE_TIMEOUT_MS'],
        message: 'Live timeout must be between one and thirty minutes.',
      });
    }
    const lookup = BigInt(value.LIVE_ACCEPTANCE_MAX_LOOKUP_BLOCKS);
    if (lookup < 1_000n || lookup > 5_000_000n) {
      context.addIssue({
        code: 'custom',
        path: ['LIVE_ACCEPTANCE_MAX_LOOKUP_BLOCKS'],
        message: 'Live event lookup bound is invalid.',
      });
    }
  });

type DriverEnvironment = z.infer<typeof DriverEnvironmentSchema>;
const execFileAsync = promisify(execFile);

const BrowserResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1).max(100),
  }),
]);

const CheckoutProofSchema = z.object({
  orderId: OrderIdSchema,
  attemptId: PaymentAttemptIdSchema,
  orderKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  ownerAddress: EvmAddressSchema,
  recipientAddress: EvmAddressSchema,
  checkoutAddress: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  merchantOnchainId: z.string().regex(/^[1-9][0-9]*$/),
  productOnchainId: z.string().regex(/^[1-9][0-9]*$/),
  amountBaseUnits: z.string().regex(/^[1-9][0-9]*$/),
  platformFeeBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  quantity: z.string().regex(/^[1-9][0-9]*$/),
  intentDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  refundDeadline: z.string().regex(/^(0|[1-9][0-9]*)$/),
  bindingDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const JournalIdentityResultSchema = z
  .object({
    ownerAddress: EvmAddressSchema,
    serverVerifiedAddress: EvmAddressSchema,
    authMethod: z.enum(['google', 'email_otp']),
  })
  .passthrough();
const JournalReadinessResultSchema = z
  .object({
    ownerAddress: EvmAddressSchema,
    activationPath: LiveAcceptanceActivationPathSchema,
  })
  .passthrough();
const JournalActivationResultSchema = z
  .object({
    ownerAddress: EvmAddressSchema,
    transactionHash: TransactionHashSchema,
    sponsorGrantTransactionHash: TransactionHashSchema.optional(),
  })
  .passthrough();
const JournalDelegationResultSchema = z
  .object({
    ownerAddress: EvmAddressSchema,
    transactionHash: TransactionHashSchema.optional(),
  })
  .passthrough();
const JournalParticleAccountResultSchema = z
  .object({
    ownerAddress: EvmAddressSchema,
    evmAddress: EvmAddressSchema,
    useEIP7702: z.literal(true),
    protocolVersion: z.string().min(1).max(40),
  })
  .passthrough();

const LiveRunPreparedSchema = z
  .object({
    providerOperationId: ProviderOperationIdSchema,
    ownerAddress: EvmAddressSchema,
    chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
    checkoutAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    amountBaseUnits: z.string().regex(/^[1-9][0-9]*$/),
    exactCallTemplateVerified: z.literal(true),
    sources: LiveAcceptanceEvidenceInputSchema.shape.route.shape.sources,
    totalUsd: LiveAcceptanceEvidenceInputSchema.shape.route.shape.totalUsd,
    estimatedFeeUsd: LiveAcceptanceEvidenceInputSchema.shape.route.shape.estimatedFeeUsd,
    slippageBps: LiveAcceptanceEvidenceInputSchema.shape.route.shape.slippageBps,
    quotedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    previewDigest: EvidenceDigestSchema,
    preparedEvidenceDigest: EvidenceDigestSchema,
    activityUrl: z.string().url().optional(),
  })
  .strict();

const LiveRunContextSchema = z
  .object({
    ownerAddress: EvmAddressSchema,
    authMethod: z.enum(['google', 'email_otp']),
    activationPath: LiveAcceptanceActivationPathSchema,
    delegationTransactionHash: TransactionHashSchema,
    sponsorGrantTransactionHash: TransactionHashSchema.optional(),
    particleProtocolVersion: z.string().min(1).max(40),
    checkout: CheckoutProofSchema.strict(),
    prepared: LiveRunPreparedSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !sameEvmAddress(value.ownerAddress, value.checkout.ownerAddress) ||
      !sameEvmAddress(value.ownerAddress, value.prepared.ownerAddress) ||
      value.prepared.providerOperationId.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ownerAddress'],
        message: 'Recovery context owner binding is invalid',
      });
    }
    if (
      (value.activationPath === 'bootstrap_sponsor') !==
      (value.sponsorGrantTransactionHash !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sponsorGrantTransactionHash'],
        message: 'Recovery sponsor binding is invalid',
      });
    }
  });

const LiveRunScopeSchema = z
  .object({
    domain: z.literal('opentab/live-acceptance-run'),
    environment: z.enum(['demo-mainnet', 'production']),
    chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
    productId: ProductIdSchema,
    sourceChainId: z.string().regex(/^[1-9][0-9]*$/),
    checkoutAddress: EvmAddressSchema,
    passAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    expectedDelegationImplementation: EvmAddressSchema,
    expectedDelegationCodeHash: EvidenceDigestSchema,
    applicationReleaseId: z.string().regex(/^[0-9a-fA-F]{40}$/),
    particleSdkVersion: z.literal('2.0.3'),
    particleResponseProfileId: z.string().regex(/^[A-Za-z0-9_.:/-]{3,120}$/),
    particleFixtureSetDigest: EvidenceDigestSchema,
    particleSourceCallProfilesDigest: EvidenceDigestSchema,
    deploymentConfigDigest: EvidenceDigestSchema,
    confirmationDepth: z.string().regex(/^[1-9][0-9]*$/),
    maximumSlippageBps: z.string().regex(/^(0|[1-9][0-9]*)$/),
    allowedSourceChainIds: z
      .array(z.string().regex(/^[1-9][0-9]*$/))
      .min(1)
      .max(30),
    allowedSourceAssets: z
      .array(z.enum(['USDC', 'USDT', 'ETH']))
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = digestLiveAcceptanceDeploymentConfig({
      domain: 'opentab/live-acceptance-deployment-config',
      releaseId: value.applicationReleaseId,
      environment: value.environment,
      chainId: value.chainId,
      checkoutAddress: value.checkoutAddress,
      passAddress: value.passAddress,
      tokenAddress: value.tokenAddress,
      expectedDelegationImplementation: value.expectedDelegationImplementation,
      expectedDelegationCodeHash: value.expectedDelegationCodeHash,
      particleSdkVersion: value.particleSdkVersion,
      particleResponseProfileId: value.particleResponseProfileId,
      particleFixtureSetDigest: value.particleFixtureSetDigest,
      particleSourceCallProfilesDigest: value.particleSourceCallProfilesDigest,
      confirmationDepth: value.confirmationDepth,
      maximumSlippageBps: value.maximumSlippageBps,
      allowedSourceChainIds: value.allowedSourceChainIds,
      allowedSourceAssets: value.allowedSourceAssets,
    });
    if (expected.toLowerCase() !== value.deploymentConfigDigest.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        path: ['deploymentConfigDigest'],
        message: 'Deployment config digest does not match the live-run scope',
      });
    }
  });

const LiveRunJournalSchema = z
  .object({
    schemaVersion: z.literal(2),
    runId: z.string().uuid(),
    scopeDigest: EvidenceDigestSchema,
    scope: LiveRunScopeSchema,
    artifactFileName: z
      .string()
      .min(6)
      .max(240)
      .regex(/^[A-Za-z0-9._-]+\.json$/),
    stage: z.enum([
      'reserved',
      'checkout_bound',
      'operation_prepared',
      'operation_persisted',
      'submission_started',
      'submitted',
      'evidence_ready',
    ]),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    submissionStartedAt: z.string().datetime().optional(),
    checkout: CheckoutProofSchema.strict().optional(),
    context: LiveRunContextSchema.optional(),
    evidence: LiveAcceptanceArtifactSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (digestUnknown(value.scope).toLowerCase() !== value.scopeDigest.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        path: ['scopeDigest'],
        message: 'Recovery journal scope digest mismatch',
      });
    }
    if (value.stage !== 'reserved' && value.checkout === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['checkout'],
        message: 'Recovery checkout binding is required after checkout creation',
      });
    }
    if (
      [
        'operation_prepared',
        'operation_persisted',
        'submission_started',
        'submitted',
        'evidence_ready',
      ].includes(value.stage) &&
      value.context === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['context'],
        message: 'Recovery context is required after operation preparation',
      });
    }
    if (
      value.checkout !== undefined &&
      value.context !== undefined &&
      digestUnknown(value.checkout).toLowerCase() !==
        digestUnknown(value.context.checkout).toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['checkout'],
        message: 'Recovery checkout and operation context differ',
      });
    }
    if (
      ['submission_started', 'submitted', 'evidence_ready'].includes(value.stage) !==
      (value.submissionStartedAt !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['submissionStartedAt'],
        message: 'Recovery submission timestamp does not match its stage',
      });
    }
    if ((value.stage === 'evidence_ready') !== (value.evidence !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Canonical evidence is required only at the evidence-ready stage',
      });
    }
    if (
      value.evidence !== undefined &&
      (value.context === undefined ||
        value.evidence.orderId !== value.context.checkout.orderId ||
        value.evidence.paymentAttemptId !== value.context.checkout.attemptId ||
        value.evidence.particle.providerOperationId !==
          value.context.prepared.providerOperationId ||
        value.evidence.startedAt !== value.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Canonical evidence does not match the active recovery context',
      });
    }
  });

export type LiveRunJournal = z.infer<typeof LiveRunJournalSchema>;

const LiveRunCompletionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    domain: z.literal('opentab/live-acceptance-completion'),
    scopeDigest: EvidenceDigestSchema,
    scope: LiveRunScopeSchema,
    runId: z.string().uuid(),
    startedAt: z.string().datetime(),
    artifactFileName: z
      .string()
      .min(6)
      .max(240)
      .regex(/^[A-Za-z0-9._-]+\.json$/),
    artifactFileDigest: EvidenceDigestSchema,
    orderId: OrderIdSchema,
    paymentAttemptId: PaymentAttemptIdSchema,
    providerOperationId: ProviderOperationIdSchema,
    evidenceId: z.string().uuid(),
    payloadDigest: EvidenceDigestSchema,
    completedAt: z.string().datetime(),
    receipt: LiveAcceptanceReceiptSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      digestUnknown(value.scope).toLowerCase() !== value.scopeDigest.toLowerCase() ||
      value.receipt.orderId !== value.orderId ||
      value.receipt.releaseId.toLowerCase() !== value.scope.applicationReleaseId.toLowerCase() ||
      value.receipt.deploymentConfigDigest.toLowerCase() !==
        value.scope.deploymentConfigDigest.toLowerCase() ||
      value.receipt.paymentAttemptId !== value.paymentAttemptId ||
      value.receipt.providerOperationId !== value.providerOperationId ||
      value.receipt.evidenceId !== value.evidenceId ||
      value.receipt.payloadDigest.toLowerCase() !== value.payloadDigest.toLowerCase() ||
      value.receipt.artifactFileDigest.toLowerCase() !== value.artifactFileDigest.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['receipt'],
        message: 'Completion tombstone binding is invalid',
      });
    }
  });

const LiveRunCompletionSchema = LiveRunCompletionPayloadSchema.extend({
  completionMac: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
}).strict();

function completionMac(secret: string, payload: z.infer<typeof LiveRunCompletionPayloadSchema>) {
  if (secret.length < 32) throw new RangeError('Live completion secret is too short');
  return `0x${createHmac('sha256', secret)
    .update(
      JSON.stringify({
        domain: 'opentab/live-acceptance-completion-mac',
        version: 1,
        payload: sortJournalKeys(payload),
      }),
      'utf8',
    )
    .digest('hex')}` as const;
}

export function createLiveRunCompletion(
  secret: string,
  input: unknown,
): z.infer<typeof LiveRunCompletionSchema> {
  const payload = LiveRunCompletionPayloadSchema.parse(input);
  return LiveRunCompletionSchema.parse({
    ...payload,
    completionMac: completionMac(secret, payload),
  });
}

export function verifyLiveRunCompletion(secret: string, input: unknown): LiveRunCompletion {
  const completion = LiveRunCompletionSchema.parse(input);
  const { completionMac: supplied, ...payloadInput } = completion;
  const payload = LiveRunCompletionPayloadSchema.parse(payloadInput);
  const expected = completionMac(secret, payload);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied.slice(2), 'hex'), Buffer.from(expected.slice(2), 'hex'))
  ) {
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Completion tombstone MAC is invalid.');
  }
  return completion;
}

export const LIVE_ACCEPTANCE_RETIRE_CONFIRMATION =
  'I_REVIEWED_AND_RETIRED_THIS_ACCEPTANCE_SCOPE' as const;

export function retireLiveRunCompletion(input: {
  path: string;
  receiptSecret: string;
  confirmation: string;
}): {
  readonly runId: string;
  readonly scopeDigest: EvidenceDigest;
  readonly artifactFileName: string;
} {
  if (input.confirmation !== LIVE_ACCEPTANCE_RETIRE_CONFIRMATION) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Explicit live-acceptance completion retirement confirmation is required.',
    );
  }
  const target = resolveProtectedEvidencePath(input.path);
  if (!target.endsWith('.complete.json')) {
    throw new AppError('CONFIGURATION_INVALID', 'A completion tombstone path is required.');
  }
  const parsed = verifyLiveRunCompletion(
    input.receiptSecret,
    JSON.parse(readProtectedEvidenceFile(target)),
  );
  readLiveRunCompletion(target, input.receiptSecret, parsed.scope);
  removeProtectedEvidenceFile(target);
  return {
    runId: parsed.runId,
    scopeDigest: parsed.scopeDigest,
    artifactFileName: parsed.artifactFileName,
  };
}

export type LiveRunCompletion = z.infer<typeof LiveRunCompletionSchema>;

const WorkflowSchema = z
  .object({
    attempt: z
      .object({
        id: PaymentAttemptIdSchema,
        status: z.string().min(1).max(40),
        providerOperationId: ProviderOperationIdSchema.optional(),
      })
      .passthrough(),
    order: z
      .object({
        id: OrderIdSchema,
        status: z.string().min(1).max(40),
        providerOperationId: ProviderOperationIdSchema.optional(),
      })
      .passthrough(),
    receipt: z
      .object({
        status: z.enum(['expected', 'issued', 'revoked', 'orphaned']),
        tokenId: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .optional(),
      })
      .optional(),
    canonicalOrderPaid: z
      .object({
        canonical: z.literal(true),
        transactionHash: TransactionHashSchema,
        confirmations: z.string().regex(/^(0|[1-9][0-9]*)$/),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const RecoveredCanonicalPaymentSchema = z
  .object({
    providerOperationId: ProviderOperationIdSchema,
    event: CanonicalEventProofSchema,
    receiptId: ReceiptIdSchema,
    passTokenId: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();

const RecoveredCountsSchema = z
  .object({
    providerOperationId: ProviderOperationIdSchema,
    finalOrderStatus: z.literal('paid'),
    sponsorGrantCount: z.number().int().min(0).max(1),
    delegationCount: z.number().int().min(0).max(1),
    orderCount: z.literal(1),
    paymentAttemptCount: z.literal(1),
    providerOperationCount: z.literal(1),
    submissionCount: z.literal(1),
    receiptCount: z.literal(1),
  })
  .strict();

function externalBlocker(reason: string): Error {
  return new Error(`EXTERNAL_BLOCKER: ${reason}`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class PlaywrightBrowserBoundary {
  private constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly browser: Browser,
    private readonly ownsBrowser: boolean,
    private readonly origin: string,
  ) {}

  static async create(environment: DriverEnvironment): Promise<PlaywrightBrowserBoundary> {
    let bundle: string;
    try {
      const result = await build({
        entryPoints: [bridgeEntry],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'iife',
        target: ['es2022'],
        sourcemap: false,
        minify: false,
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      const output = result.outputFiles[0];
      if (output === undefined) throw new Error('missing bundle');
      bundle = output.text;
    } catch {
      throw externalBlocker('The protected browser bridge could not be bundled.');
    }

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let ownsBrowser = true;
    try {
      if (environment.LIVE_ACCEPTANCE_CDP_URL !== undefined) {
        browser = await chromium.connectOverCDP(environment.LIVE_ACCEPTANCE_CDP_URL);
        const existing = browser.contexts()[0];
        if (existing === undefined) throw new Error('missing disposable context');
        context = existing;
        ownsBrowser = false;
      } else {
        browser = await chromium.launch({
          headless: environment.LIVE_ACCEPTANCE_HEADLESS === 'true',
        });
        context = await browser.newContext({ bypassCSP: true });
      }
      if (browser === undefined || context === undefined) {
        throw new Error('browser context unavailable');
      }
      await context.addInitScript({ content: bundle });
      const page = await context.newPage();
      await page.goto(environment.NEXT_PUBLIC_APP_ORIGIN, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForFunction(
        () =>
          (globalThis as { __openTabLiveAcceptanceReady?: unknown })
            .__openTabLiveAcceptanceReady === true,
        undefined,
        { timeout: 60_000 },
      );
      return new PlaywrightBrowserBoundary(
        page,
        context,
        browser,
        ownsBrowser,
        new URL(environment.NEXT_PUBLIC_APP_ORIGIN).origin,
      );
    } catch {
      if (typeof context !== 'undefined' && ownsBrowser) {
        await context.close().catch(() => undefined);
      }
      if (typeof browser !== 'undefined' && ownsBrowser) {
        await browser.close().catch(() => undefined);
      }
      throw externalBlocker(
        'A disposable Chromium session could not reach the configured OpenTab origin.',
      );
    }
  }

  async invoke(method: string, input?: unknown): Promise<unknown> {
    const raw = await this.page.evaluate(
      async ({ bridgeProperty, methodName, methodInput }) => {
        const bridge = (globalThis as Record<string, unknown>)[bridgeProperty];
        if (typeof bridge !== 'object' || bridge === null) {
          return { ok: false as const, code: 'LIVE_BROWSER_BRIDGE_MISSING' };
        }
        const operation = (bridge as Record<string, unknown>)[methodName];
        if (typeof operation !== 'function') {
          return { ok: false as const, code: 'LIVE_BROWSER_METHOD_MISSING' };
        }
        try {
          return {
            ok: true as const,
            value: await (operation as (input?: unknown) => Promise<unknown>)(methodInput),
          };
        } catch (error) {
          let code = 'LIVE_BROWSER_STAGE_FAILED';
          if (typeof error === 'object' && error !== null && 'code' in error) {
            const candidate = String((error as { code: unknown }).code);
            if (/^[A-Z0-9_]{2,100}$/.test(candidate)) code = candidate;
          } else if (error instanceof Error) {
            const candidate = error.message.split(':', 1)[0] ?? '';
            if (/^[A-Z0-9_]{2,100}$/.test(candidate)) code = candidate;
          }
          return { ok: false as const, code };
        }
      },
      { bridgeProperty: bridgeName, methodName: method, methodInput: input },
    );
    const result = BrowserResultSchema.parse(raw);
    if (!result.ok) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Protected live browser stage ${method} failed safely.`,
        {
          safeDetails: { stage: method, code: result.code },
        },
      );
    }
    return result.value;
  }

  async authenticate(environment: DriverEnvironment): Promise<unknown> {
    const restored = await this.invoke('restoreIdentity');
    if (restored !== undefined) return this.invoke('refreshIdentityProof');
    if (environment.LIVE_ACCEPTANCE_AUTH_METHOD === 'email_otp') {
      const email = environment.LIVE_ACCEPTANCE_EMAIL;
      if (email === undefined) {
        throw externalBlocker('A disposable Magic email is required for email OTP acceptance.');
      }
      return this.invoke('authenticateEmail', { email });
    }

    const callback = `${this.origin}/auth/callback`;
    try {
      await Promise.all([
        this.page.waitForURL(
          (url) => url.origin === this.origin && url.pathname === '/auth/callback',
          {
            timeout: 10 * 60_000,
          },
        ),
        this.invoke('beginGoogleAuthentication'),
      ]);
    } catch {
      if (this.page.url().startsWith(callback)) {
        // Navigation destroys the originating evaluation context after Magic
        // has safely persisted its redirect state. Continue at the callback.
      } else {
        throw externalBlocker('Interactive Magic Google authentication did not return to OpenTab.');
      }
    }
    await this.page.waitForFunction(
      () =>
        (globalThis as { __openTabLiveAcceptanceReady?: unknown }).__openTabLiveAcceptanceReady ===
        true,
      undefined,
      { timeout: 60_000 },
    );
    try {
      return await this.invoke('completeGoogleAuthentication');
    } catch {
      await this.page.waitForURL(
        (url) => url.origin === this.origin && url.pathname !== '/auth/callback',
        {
          timeout: 60_000,
        },
      );
      const identity = await this.invoke('restoreIdentity');
      if (identity === undefined) {
        throw externalBlocker('Magic Google callback did not establish an OpenTab session.');
      }
      return this.invoke('refreshIdentityProof');
    }
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.page.waitForFunction(
      () =>
        (globalThis as { __openTabLiveAcceptanceReady?: unknown }).__openTabLiveAcceptanceReady ===
        true,
      undefined,
      { timeout: 60_000 },
    );
  }

  async close(): Promise<void> {
    if (this.ownsBrowser) {
      await this.context.close().catch(() => undefined);
      await this.browser.close().catch(() => undefined);
      return;
    }
    await this.page.close().catch(() => undefined);
  }
}

interface RecoverySnapshot {
  readonly finalOrderStatus: string;
  readonly sponsorGrantCount: number;
  readonly delegationCount: number;
  readonly orderCount: number;
  readonly paymentAttemptCount: number;
  readonly providerOperationCount: number;
  readonly submissionCount: number;
  readonly receiptCount: number;
  readonly receiptId?: string;
  readonly passTokenId?: string;
  readonly providerOperation?: {
    readonly externalId: string;
    readonly kind: string;
    readonly status: string;
    readonly submissionPossible: boolean;
    readonly destinationTransactionHash: string | null;
    readonly activityUrl: string | null;
    readonly evidenceDigest: string;
    readonly observedAt: Date;
    readonly safeSummary: Record<string, string>;
  };
}

export function hasExactPersistedProviderObservation(
  snapshot: RecoverySnapshot,
  expected: z.infer<typeof ProviderOperationSchema>,
): boolean {
  const provider = snapshot.providerOperation;
  if (provider === undefined || expected.destinationTransactionHash === undefined) return false;
  const summary = provider.safeSummary;
  return (
    snapshot.providerOperationCount === 1 &&
    provider.externalId === expected.id &&
    provider.kind === 'checkout' &&
    provider.status === 'succeeded' &&
    provider.submissionPossible &&
    provider.destinationTransactionHash?.toLowerCase() ===
      expected.destinationTransactionHash.toLowerCase() &&
    (provider.activityUrl ?? undefined) === expected.activityUrl &&
    provider.evidenceDigest.toLowerCase() === expected.evidence.evidenceDigest.toLowerCase() &&
    provider.observedAt.toISOString() === expected.evidence.observedAt &&
    summary.adapter === expected.evidence.adapter &&
    summary.environment === expected.evidence.environment &&
    summary.packageVersion === expected.evidence.packageVersion &&
    summary.provenance === expected.evidence.provenance &&
    summary.schemaVersion === expected.evidence.schemaVersion.toString() &&
    summary.finalObservedAt === expected.evidence.observedAt &&
    summary.providerUpdatedAt === expected.updatedAt
  );
}

class PostgresAcceptanceSnapshotStore {
  readonly #sql: Sql;

  constructor(
    databaseUrl: string,
    private readonly startedAt: Date,
    private readonly environment: 'demo-mainnet' | 'production',
  ) {
    this.#sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
      prepare: false,
      connection: {
        application_name: 'opentab-live-acceptance-readonly',
        default_transaction_read_only: true,
        timezone: 'UTC',
      },
    });
  }

  async snapshot(input: {
    ownerAddress: EvmAddress;
    orderId: string;
    attemptId: string;
    providerOperationId: string;
  }): Promise<RecoverySnapshot> {
    const sql = this.#sql;
    const [orderRows, attemptRows, operationRows, receiptRows, sponsorRows, delegationRows] =
      await Promise.all([
        sql<{ id: string; status: string }[]>`
          select id, status from orders
          where order_key = (select order_key from orders where id = ${input.orderId})
          limit 2
        `,
        sql<{ id: string; submission_started_at: Date | null }[]>`
          select id, submission_started_at from payment_attempts
          where order_id = ${input.orderId} limit 2
        `,
        sql<
          {
            id: string;
            external_id: string;
            kind: string;
            status: string;
            submission_possible: boolean;
            destination_transaction_hash: string | null;
            activity_url: string | null;
            evidence_digest: string;
            observed_at: Date;
            safe_summary: Record<string, string>;
          }[]
        >`
          select po.id, po.external_id, po.kind, po.status, po.submission_possible,
            po.destination_transaction_hash, po.activity_url, po.evidence_digest,
            po.observed_at, po.safe_summary
          from provider_operations po
          join payment_attempts pa on pa.id = po.payment_attempt_id
          where pa.order_id = ${input.orderId}
            and po.provider = 'particle'
          limit 2
        `,
        sql<{ id: string; status: string; token_id: string | null }[]>`
          select id, status, token_id from receipts where order_id = ${input.orderId} limit 2
        `,
        sql<{ id: string }[]>`
          select id from bootstrap_grants
          where recipient_address_lower = ${input.ownerAddress.toLowerCase()}
            and environment = ${this.environment}
            and created_at >= ${this.startedAt}
          limit 2
        `,
        sql<{ id: string }[]>`
          select id from delegation_records
          where owner_address_lower = ${input.ownerAddress.toLowerCase()}
            and environment = ${this.environment}
            and created_at >= ${this.startedAt}
          limit 2
        `,
      ]);
    const receipt = receiptRows[0];
    return {
      finalOrderStatus: orderRows[0]?.status ?? 'missing',
      sponsorGrantCount: sponsorRows.length,
      delegationCount: delegationRows.length,
      orderCount: orderRows.length,
      paymentAttemptCount: attemptRows.length,
      providerOperationCount: operationRows.length,
      submissionCount: attemptRows[0]?.submission_started_at === null ? 0 : attemptRows.length,
      receiptCount: receiptRows.length,
      ...(receipt === undefined ? {} : { receiptId: receipt.id }),
      ...(receipt?.token_id === null || receipt?.token_id === undefined
        ? {}
        : { passTokenId: receipt.token_id }),
      ...(operationRows[0] === undefined
        ? {}
        : {
            providerOperation: {
              externalId: operationRows[0].external_id,
              kind: operationRows[0].kind,
              status: operationRows[0].status,
              submissionPossible: operationRows[0].submission_possible,
              destinationTransactionHash: operationRows[0].destination_transaction_hash,
              activityUrl: operationRows[0].activity_url,
              evidenceDigest: operationRows[0].evidence_digest,
              observedAt: operationRows[0].observed_at,
              safeSummary: operationRows[0].safe_summary,
            },
          }),
    };
  }

  async assertCompletedEvidence(
    artifact: LiveAcceptanceEvidence,
    completion: LiveRunCompletion,
  ): Promise<void> {
    const event = artifact.arbitrum.event;
    if (event.eventName !== 'OrderPaid') {
      throw new AppError('PAYMENT_EVENT_MISMATCH', 'Completed evidence must contain OrderPaid.');
    }
    const rows = await this.#sql<
      {
        evidence_id: string;
        payload_digest: string;
        release_id: string;
        deployment_config_digest: string;
        acceptance_environment: string;
        acceptance_chain_id: string;
        acceptance_checkout_address: string;
        order_token_address: string;
        pass_contract_address: string;
        pass_canonical: boolean;
        pass_projection_status: string;
        order_status: string;
        attempt_status: string;
        receipt_status: string;
        provider_status: string;
        provider_submission_possible: boolean;
        provider_destination_hash: string | null;
        provider_evidence_digest: string;
        acceptance_provider_evidence_digest: string;
        provider_provenance: string | null;
        acceptance_provider_provenance: string;
        delegation_status: string;
        delegation_owner: string;
        delegation_implementation: string;
        delegation_code_hash: string;
        delegation_evidence_digest: string;
        acceptance_delegation_evidence_digest: string;
        canonical: boolean;
        projection_status: string;
        canonical_block_hash: string;
      }[]
    >`
      select
        ae.id::text as evidence_id,
        ae.payload_digest,
        ae.release_id,
        ae.deployment_config_digest,
        ae.environment as acceptance_environment,
        ae.chain_id as acceptance_chain_id,
        ae.checkout_address as acceptance_checkout_address,
        o.token_address as order_token_address,
        pass_cl.contract_address as pass_contract_address,
        pass_cl.canonical as pass_canonical,
        pass_cl.projection_status as pass_projection_status,
        o.status as order_status,
        pa.status as attempt_status,
        r.status as receipt_status,
        po.status as provider_status,
        po.submission_possible as provider_submission_possible,
        po.destination_transaction_hash as provider_destination_hash,
        po.evidence_digest as provider_evidence_digest,
        ae.provider_evidence_digest as acceptance_provider_evidence_digest,
        po.safe_summary->>'provenance' as provider_provenance,
        ae.provider_provenance as acceptance_provider_provenance,
        dr.status as delegation_status,
        dr.owner_address_lower as delegation_owner,
        dr.implementation_address_lower as delegation_implementation,
        dr.implementation_code_hash as delegation_code_hash,
        dr.evidence_digest as delegation_evidence_digest,
        ae.delegation_evidence_digest as acceptance_delegation_evidence_digest,
        cl.canonical,
        cl.projection_status,
        cl.block_hash as canonical_block_hash
      from live_acceptance_evidence ae
      join orders o on o.id = ae.order_id
      join payment_attempts pa on pa.id = ae.payment_attempt_id and pa.order_id = o.id
      join receipts r on r.id = ae.receipt_id and r.order_id = o.id
      join canonical_logs pass_cl
        on pass_cl.id = r.chain_event_id
       and pass_cl.event_name = 'TransferSingle'
      join provider_operations po
        on po.payment_attempt_id = pa.id
       and po.provider = 'particle'
       and po.external_id = ae.provider_operation_id
      join delegation_records dr
        on lower(dr.transaction_hash) = lower(ae.delegation_transaction_hash)
       and dr.environment = ae.environment
       and dr.chain_id = ae.chain_id
      join canonical_logs cl
        on cl.chain_id = ae.chain_id
       and lower(cl.contract_address) = lower(ae.checkout_address)
       and lower(cl.transaction_hash) = lower(ae.settlement_transaction_hash)
       and cl.block_number = ae.settlement_block_number
       and lower(cl.block_hash) = lower(ae.settlement_block_hash)
       and cl.log_index = ae.settlement_log_index
       and cl.event_name = 'OrderPaid'
      where ae.id = ${completion.evidenceId}::uuid
        and ae.order_id = ${artifact.orderId}
        and ae.payment_attempt_id = ${artifact.paymentAttemptId}
        and ae.provider_operation_id = ${artifact.particle.providerOperationId}
        and lower(ae.payload_digest) = lower(${completion.payloadDigest})
      limit 2
    `;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.evidence_id !== completion.evidenceId ||
      row.payload_digest.toLowerCase() !== completion.payloadDigest.toLowerCase() ||
      row.release_id.toLowerCase() !== completion.scope.applicationReleaseId.toLowerCase() ||
      row.deployment_config_digest.toLowerCase() !==
        completion.scope.deploymentConfigDigest.toLowerCase() ||
      row.acceptance_environment !== completion.scope.environment ||
      row.acceptance_chain_id !== completion.scope.chainId ||
      !sameEvmAddress(
        EvmAddressSchema.parse(row.acceptance_checkout_address),
        completion.scope.checkoutAddress,
      ) ||
      !sameEvmAddress(
        EvmAddressSchema.parse(row.order_token_address),
        completion.scope.tokenAddress,
      ) ||
      !sameEvmAddress(
        EvmAddressSchema.parse(row.pass_contract_address),
        completion.scope.passAddress,
      ) ||
      !row.pass_canonical ||
      row.pass_projection_status !== 'applied' ||
      row.order_status !== 'paid' ||
      !['confirming', 'paid'].includes(row.attempt_status) ||
      row.receipt_status !== 'issued' ||
      row.provider_status !== 'succeeded' ||
      !row.provider_submission_possible ||
      row.provider_destination_hash?.toLowerCase() !== event.transactionHash.toLowerCase() ||
      row.provider_evidence_digest.toLowerCase() !==
        row.acceptance_provider_evidence_digest.toLowerCase() ||
      row.provider_provenance !== row.acceptance_provider_provenance ||
      row.delegation_status !== 'confirmed' ||
      !sameEvmAddress(EvmAddressSchema.parse(row.delegation_owner), artifact.ownerAddressBefore) ||
      !sameEvmAddress(
        EvmAddressSchema.parse(row.delegation_implementation),
        completion.scope.expectedDelegationImplementation,
      ) ||
      row.delegation_code_hash.toLowerCase() !==
        completion.scope.expectedDelegationCodeHash.toLowerCase() ||
      row.delegation_evidence_digest.toLowerCase() !==
        row.acceptance_delegation_evidence_digest.toLowerCase() ||
      !row.canonical ||
      row.projection_status !== 'applied' ||
      row.canonical_block_hash.toLowerCase() !== event.blockHash.toLowerCase()
    ) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'The completed live acceptance is no longer backed by current canonical database evidence.',
      );
    }
  }

  close(): Promise<void> {
    return this.#sql.end({ timeout: 5 });
  }
}

function sanitizedEvidence(value: LiveAcceptanceEvidence): LiveAcceptanceEvidence {
  return LiveAcceptanceArtifactSchema.parse({
    status: 'LIVE_ACCEPTANCE_EVIDENCED',
    schemaVersion: 1,
    environment: value.environment,
    releaseId: value.releaseId,
    deploymentConfigDigest: value.deploymentConfigDigest,
    orderId: value.orderId,
    paymentAttemptId: value.paymentAttemptId,
    startedAt: value.startedAt,
    capturedAt: value.capturedAt,
    ownerAddressBefore: value.ownerAddressBefore,
    ownerAddressAfter: value.ownerAddressAfter,
    authMethod: value.authMethod,
    activationPath: value.activationPath,
    providerOperation: value.providerOperation,
    delegationTransactionHash: value.delegationTransactionHash,
    ...(value.sponsorGrantTransactionHash === undefined
      ? {}
      : { sponsorGrantTransactionHash: value.sponsorGrantTransactionHash }),
    particle: {
      protocolVersion: value.particle.protocolVersion,
      useEIP7702: true,
      safeAccountIdentifiers: [...value.particle.safeAccountIdentifiers],
      providerOperationId: value.particle.providerOperationId,
      ...(value.particle.activityUrl === undefined
        ? {}
        : { activityUrl: value.particle.activityUrl }),
      sources: value.particle.sources.map((source) => ({ ...source })),
      totalUsd: value.particle.totalUsd,
      estimatedFeeUsd: value.particle.estimatedFeeUsd,
      slippageBps: value.particle.slippageBps,
      quotedAt: value.particle.quotedAt,
      expiresAt: value.particle.expiresAt,
      previewDigest: value.particle.previewDigest,
    },
    arbitrum: {
      event: value.arbitrum.event,
      receiptId: value.arbitrum.receiptId,
      passTokenId: value.arbitrum.passTokenId,
    },
    recovery: { ...value.recovery },
    timingMs: { ...value.timingMs },
  });
}

function protectedEvidenceDirectory(): string {
  const directory = path.join(root, 'artifacts', 'autonomous-build', 'evidence');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return fs.realpathSync(directory);
}

function fsyncProtectedEvidenceDirectory(): void {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(
    protectedEvidenceDirectory(),
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeProtectedEvidenceFile(target: string): void {
  if (fs.realpathSync(path.dirname(target)) !== protectedEvidenceDirectory()) {
    throw new AppError('CONFIGURATION_INVALID', 'Protected evidence parent path changed.');
  }
  if (!fs.existsSync(target)) return;
  fs.rmSync(target);
  fsyncProtectedEvidenceDirectory();
}

function sortJournalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJournalKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJournalKeys(record[key])]),
  );
}

export function serializeLiveRunJournal(value: unknown): string {
  const journal = LiveRunJournalSchema.parse(value);
  return `${JSON.stringify(sortJournalKeys(journal), null, 2)}\n`;
}

export function serializeLiveRunCompletion(value: unknown): string {
  const completion = LiveRunCompletionSchema.parse(value);
  return `${JSON.stringify(sortJournalKeys(completion), null, 2)}\n`;
}

function liveRunJournalPath(scopeDigest: EvidenceDigest): string {
  return resolveProtectedEvidencePath(
    path.join(
      'artifacts',
      'autonomous-build',
      'evidence',
      `live-acceptance-active-${scopeDigest.slice(2).toLowerCase()}.journal.json`,
    ),
  );
}

function liveRunCompletionPath(scopeDigest: EvidenceDigest): string {
  return resolveProtectedEvidencePath(
    path.join(
      'artifacts',
      'autonomous-build',
      'evidence',
      `live-acceptance-complete-${scopeDigest.slice(2).toLowerCase()}.complete.json`,
    ),
  );
}

function readLiveRunJournal(target: string): LiveRunJournal {
  const content = readProtectedEvidenceFile(target);
  const journal = LiveRunJournalSchema.parse(JSON.parse(content));
  if (content !== serializeLiveRunJournal(journal)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'The active live-acceptance recovery journal is not canonical.',
    );
  }
  return journal;
}

function readLiveRunCompletion(
  target: string,
  receiptSecret: string,
  expectedScope: z.infer<typeof LiveRunScopeSchema>,
): { readonly completion: LiveRunCompletion; readonly artifact: LiveAcceptanceEvidence } {
  const content = readProtectedEvidenceFile(target);
  const completion = verifyLiveRunCompletion(receiptSecret, JSON.parse(content));
  if (content !== serializeLiveRunCompletion(completion)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'The live-acceptance completion tombstone is not canonical.',
    );
  }
  const expectedScopeDigest = EvidenceDigestSchema.parse(digestUnknown(expectedScope));
  if (
    completion.scopeDigest.toLowerCase() !== expectedScopeDigest.toLowerCase() ||
    digestUnknown(completion.scope).toLowerCase() !== digestUnknown(expectedScope).toLowerCase()
  ) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'The live-acceptance completion tombstone belongs to another deployment scope.',
    );
  }
  const receipt = verifyLiveAcceptanceReceipt(receiptSecret, completion.receipt);
  const artifactPath = resolveProtectedEvidencePath(
    path.join('artifacts', 'autonomous-build', 'evidence', completion.artifactFileName),
  );
  const artifactContent = readProtectedEvidenceFile(artifactPath);
  const artifact = LiveAcceptanceArtifactSchema.parse(JSON.parse(artifactContent));
  const event = artifact.arbitrum.event;
  if (
    artifactContent !== serializeLiveAcceptanceArtifact(artifact) ||
    digestLiveAcceptanceFile(artifactContent).toLowerCase() !==
      completion.artifactFileDigest.toLowerCase() ||
    artifact.orderId !== completion.orderId ||
    artifact.paymentAttemptId !== completion.paymentAttemptId ||
    artifact.particle.providerOperationId !== completion.providerOperationId ||
    artifact.startedAt !== completion.startedAt ||
    artifact.releaseId.toLowerCase() !== completion.scope.applicationReleaseId.toLowerCase() ||
    artifact.deploymentConfigDigest.toLowerCase() !==
      completion.scope.deploymentConfigDigest.toLowerCase() ||
    receipt.releaseId.toLowerCase() !== completion.scope.applicationReleaseId.toLowerCase() ||
    receipt.deploymentConfigDigest.toLowerCase() !==
      completion.scope.deploymentConfigDigest.toLowerCase() ||
    artifact.environment !== completion.scope.environment ||
    event.eventName !== 'OrderPaid' ||
    event.chainId !== completion.scope.chainId ||
    !sameEvmAddress(event.contractAddress, completion.scope.checkoutAddress) ||
    !sameEvmAddress(event.fields.token, completion.scope.tokenAddress) ||
    receipt.artifactFileDigest.toLowerCase() !== completion.artifactFileDigest.toLowerCase()
  ) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'The completed live-acceptance artifact no longer matches its accepted tombstone.',
    );
  }
  return { completion, artifact };
}

function replaceProtectedEvidenceFile(target: string, content: string): void {
  const directory = protectedEvidenceDirectory();
  if (fs.realpathSync(path.dirname(target)) !== directory) {
    throw new AppError('CONFIGURATION_INVALID', 'Protected evidence parent path changed.');
  }
  const current = fs.lstatSync(target);
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new AppError('CONFIGURATION_INVALID', 'Recovery journal is not a regular file.');
  }
  if (process.platform !== 'win32' && (current.mode & 0o077) !== 0) {
    throw new AppError('CONFIGURATION_INVALID', 'Recovery journal permissions are invalid.');
  }
  const temporary = path.join(
    directory,
    `.live-journal-${process.pid}-${randomUUID()}.journal.json`,
  );
  let descriptor: number | undefined;
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
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    fsyncProtectedEvidenceDirectory();
  } catch (error) {
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
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
}

export function reserveLiveAcceptanceRun(input: {
  scope: unknown;
  artifactTarget: string;
  now?: Date;
}):
  | { readonly status: 'reserved'; readonly path: string; readonly journal: LiveRunJournal }
  | {
      readonly status: 'recovery_required';
      readonly path: string;
      readonly journal: LiveRunJournal;
    } {
  const scope = LiveRunScopeSchema.parse(input.scope);
  const scopeDigest = EvidenceDigestSchema.parse(digestUnknown(scope));
  const target = liveRunJournalPath(scopeDigest);
  if (fs.existsSync(target)) {
    const journal = readLiveRunJournal(target);
    if (journal.scopeDigest.toLowerCase() !== scopeDigest.toLowerCase()) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'The active recovery scope is inconsistent.');
    }
    return { status: 'recovery_required', path: target, journal };
  }
  const now = input.now ?? new Date();
  const artifactTarget = resolveProtectedEvidencePath(input.artifactTarget);
  const journal = LiveRunJournalSchema.parse({
    schemaVersion: 2,
    runId: randomUUID(),
    scopeDigest,
    scope,
    artifactFileName: path.basename(artifactTarget),
    stage: 'reserved',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  try {
    writeProtectedEvidenceFileExclusive(target, serializeLiveRunJournal(journal));
    return { status: 'reserved', path: target, journal };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { status: 'recovery_required', path: target, journal: readLiveRunJournal(target) };
  }
}

export function updateLiveAcceptanceRun(
  target: string,
  expectedRunId: string,
  update: (current: LiveRunJournal) => unknown,
): LiveRunJournal {
  const current = readLiveRunJournal(target);
  if (current.runId !== expectedRunId) {
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Another live-acceptance run owns this scope.');
  }
  const next = LiveRunJournalSchema.parse(update(current));
  if (
    next.runId !== current.runId ||
    next.scopeDigest.toLowerCase() !== current.scopeDigest.toLowerCase() ||
    next.startedAt !== current.startedAt ||
    next.artifactFileName !== current.artifactFileName
  ) {
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Immutable recovery journal identity changed.');
  }
  replaceProtectedEvidenceFile(target, serializeLiveRunJournal(next));
  return next;
}

export function releaseLiveAcceptanceRun(target: string, expectedRunId: string): void {
  const current = readLiveRunJournal(target);
  if (current.runId !== expectedRunId) {
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Another live-acceptance run owns this scope.');
  }
  removeProtectedEvidenceFile(target);
}

export function resolveProtectedEvidencePath(
  requestedPath?: string,
  timestamp: Date = new Date(),
): string {
  const directory = protectedEvidenceDirectory();
  const target = path.resolve(
    root,
    requestedPath ??
      path.join(
        'artifacts',
        'autonomous-build',
        'evidence',
        `live-acceptance-${timestamp.toISOString().replace(/[:.]/g, '-')}.json`,
      ),
  );
  let parent: string;
  try {
    parent = fs.realpathSync(path.dirname(target));
  } catch {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Live evidence must stay in the protected evidence directory.',
    );
  }
  if (
    parent !== directory ||
    !target.startsWith(`${directory}${path.sep}`) ||
    path.extname(target) !== '.json'
  ) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Live evidence must stay in the protected evidence directory.',
    );
  }
  return target;
}

export function writeProtectedEvidenceFileExclusive(target: string, content: string): void {
  const directory = protectedEvidenceDirectory();
  if (fs.realpathSync(path.dirname(target)) !== directory) {
    throw new AppError('CONFIGURATION_INVALID', 'Protected evidence parent path changed.');
  }
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(target, flags, 0o600);
  try {
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncProtectedEvidenceDirectory();
}

export function ensureProtectedEvidenceFile(target: string, content: string): void {
  if (!fs.existsSync(target)) {
    writeProtectedEvidenceFileExclusive(target, content);
    return;
  }
  if (readProtectedEvidenceFile(target) !== content) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'Existing protected evidence bytes differ from the interrupted live run.',
    );
  }
}

function readProtectedEvidenceFile(target: string): string {
  const resolved = resolveProtectedEvidencePath(target);
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) {
      throw new AppError('CONFIGURATION_INVALID', 'Protected evidence file is invalid.');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new AppError('CONFIGURATION_INVALID', 'Protected evidence permissions are invalid.');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

export function promotePendingLiveEvidence(
  pendingPath: string,
  receiptSecret: string,
  options: { readonly retainAcceptedReceipt?: boolean } = {},
): string {
  const pending = resolveProtectedEvidencePath(pendingPath);
  if (!pending.endsWith('.pending.json')) {
    throw new AppError('CONFIGURATION_INVALID', 'A protected pending evidence file is required.');
  }
  const target = pending.replace(/\.pending\.json$/, '.json');
  const ingestion = pending.replace(/\.pending\.json$/, '.ingest.json');
  const acceptedReceipt = pending.replace(/\.pending\.json$/, '.accepted.json');
  const content = readProtectedEvidenceFile(pending);
  const ingestionContent = readProtectedEvidenceFile(ingestion);
  const identity = LiveAcceptanceArtifactSchema.parse(JSON.parse(content));
  if (content !== serializeLiveAcceptanceArtifact(identity)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Pending live evidence must use the exact canonical public artifact serialization.',
    );
  }
  const receipt = verifyLiveAcceptanceReceipt(
    receiptSecret,
    JSON.parse(readProtectedEvidenceFile(acceptedReceipt)),
  );
  if (
    receipt.orderId !== identity.orderId ||
    receipt.releaseId.toLowerCase() !== identity.releaseId.toLowerCase() ||
    receipt.deploymentConfigDigest.toLowerCase() !==
      identity.deploymentConfigDigest.toLowerCase() ||
    receipt.paymentAttemptId !== identity.paymentAttemptId ||
    receipt.providerOperationId !== identity.particle.providerOperationId ||
    receipt.ingestionFileDigest.toLowerCase() !==
      digestLiveAcceptanceFile(ingestionContent).toLowerCase() ||
    receipt.artifactFileDigest.toLowerCase() !== digestLiveAcceptanceFile(content).toLowerCase()
  ) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'The accepted receipt does not match the pending evidence artifact.',
    );
  }
  if (fs.existsSync(target)) {
    if (readProtectedEvidenceFile(target) !== content) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'The durable evidence artifact differs.');
    }
  } else {
    writeProtectedEvidenceFileExclusive(target, content);
  }
  removeProtectedEvidenceFile(pending);
  removeProtectedEvidenceFile(ingestion);
  if (options.retainAcceptedReceipt !== true) removeProtectedEvidenceFile(acceptedReceipt);
  return target;
}

async function readRpcCode(url: string, address: EvmAddress): Promise<Hex> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getCode',
      params: [getAddress(address), 'latest'],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = z
    .object({ result: z.string().regex(/^0x[0-9a-fA-F]*$/) })
    .parse(await response.json());
  return payload.result as Hex;
}

const LiveTargetConfigSchema = z
  .object({
    environment: z.enum(['demo-mainnet', 'production']),
    applicationReleaseId: z.string().regex(/^[0-9a-fA-F]{40}$/),
    liveAcceptanceConfigDigest: EvidenceDigestSchema,
  })
  .passthrough();

async function readLiveTargetConfig(
  origin: string,
): Promise<z.infer<typeof LiveTargetConfigSchema>> {
  const endpoint = new URL('/api/v1/config/public', origin);
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || new URL(response.url).origin !== new URL(origin).origin) {
    throw externalBlocker('The deployed OpenTab public config could not be verified safely.');
  }
  const content = await response.text();
  if (content.length > 1024 * 1024) {
    throw new AppError('CONFIGURATION_INVALID', 'The public config response is too large.');
  }
  return LiveTargetConfigSchema.parse(JSON.parse(content));
}

export interface ManagedLiveAcceptanceDependencies extends LiveAcceptanceDependencies {
  readonly recoveryMode: boolean;
  readonly acceptanceStartedAt: string;
  readonly acceptanceDeploymentConfigDigest: EvidenceDigest;
  resumeInterruptedAcceptance(): Promise<LiveAcceptanceEvidence>;
  close(): Promise<void>;
}

export function runManagedLiveAcceptance(
  environment: Record<string, string | undefined>,
  dependencies: ManagedLiveAcceptanceDependencies,
): Promise<ReturnType<typeof runLiveAcceptance> extends Promise<infer Result> ? Result : never> {
  return dependencies.recoveryMode
    ? dependencies.resumeInterruptedAcceptance()
    : runLiveAcceptance(environment, dependencies);
}

function completedLiveAcceptanceDependencies(input: {
  artifact: LiveAcceptanceEvidence;
  completion: LiveRunCompletion;
  completionPath: string;
  database: PostgresAcceptanceSnapshotStore;
  acceptedReceiptPath: string;
  receiptSecret: string;
}): ManagedLiveAcceptanceDependencies {
  let verified = false;
  let closed = false;
  const blocked = async (): Promise<never> => {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This deployment scope already has accepted live evidence; retire it explicitly before another canary.',
    );
  };
  return {
    recoveryMode: true,
    acceptanceStartedAt: input.completion.startedAt,
    acceptanceDeploymentConfigDigest: input.completion.scope.deploymentConfigDigest,
    authenticateAndExchangeMagicProof: blocked,
    signMagicAddressChallenge: blocked,
    inspectEip7702Readiness: blocked,
    activateDelegation: blocked,
    verifyDelegationOnchain: blocked,
    initializeParticleEip7702: blocked,
    readPreflightBalances: blocked,
    assertDelegatedPassReceiver: blocked,
    createServerBoundCheckout: blocked,
    prepareAndValidateParticleOperation: blocked,
    signParticleRoot: blocked,
    persistProviderOperationBeforeSubmission: blocked,
    submitParticleOperationOnce: blocked,
    awaitCanonicalArbitrumPayment: blocked,
    readFinalProviderOperation: blocked,
    reloadAndReconcile: blocked,
    persistSanitizedEvidence: blocked,
    async resumeInterruptedAcceptance() {
      if (!verified) {
        await input.database.assertCompletedEvidence(input.artifact, input.completion);
        const activePath = liveRunJournalPath(input.completion.scopeDigest);
        if (fs.existsSync(activePath)) {
          const active = readLiveRunJournal(activePath);
          if (active.runId !== input.completion.runId) {
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              'The completion tombstone conflicts with another active live run.',
            );
          }
          releaseLiveAcceptanceRun(activePath, active.runId);
        }
        if (fs.existsSync(input.acceptedReceiptPath)) {
          const accepted = verifyLiveAcceptanceReceipt(
            input.receiptSecret,
            JSON.parse(readProtectedEvidenceFile(input.acceptedReceiptPath)),
          );
          if (
            accepted.evidenceId !== input.completion.evidenceId ||
            accepted.receiptMac.toLowerCase() !== input.completion.receipt.receiptMac.toLowerCase()
          ) {
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              'The retained acceptance receipt conflicts with its completion tombstone.',
            );
          }
          removeProtectedEvidenceFile(input.acceptedReceiptPath);
        }
        verified = true;
      }
      return input.artifact;
    },
    async close() {
      if (!closed) {
        closed = true;
        await input.database.close();
      }
    },
  };
}

export async function createLiveAcceptanceDependencies(
  environmentInput: Record<string, string | undefined> = process.env,
): Promise<ManagedLiveAcceptanceDependencies> {
  const gate = assessLiveAcceptanceGate(environmentInput);
  if (gate.status === 'EXTERNAL_BLOCKER') {
    throw externalBlocker(`${gate.reason} Missing: ${gate.missing.join(', ')}`);
  }
  let environment: DriverEnvironment;
  try {
    environment = DriverEnvironmentSchema.parse(environmentInput);
  } catch (error) {
    const missing =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.path.join('.')) : [];
    throw externalBlocker(`Protected driver configuration is incomplete: ${missing.join(', ')}`);
  }

  const allowedSourceChainIds = [
    ...new Set(
      environment.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS.split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort();
  const allowedSourceAssets = [
    ...new Set(
      environment.PARTICLE_ALLOWED_SOURCE_ASSETS.split(',')
        .map((value) => z.enum(['USDC', 'USDT', 'ETH']).parse(value.trim()))
        .filter((value) => value.length > 0),
    ),
  ].sort();
  const sourceCallProfiles = z
    .array(z.unknown())
    .min(1)
    .parse(JSON.parse(environment.PARTICLE_SOURCE_CALL_PROFILES_JSON));
  const particleFixtureSetDigest = digestUnknown({
    deployments: environment.PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST,
    authorization: environment.PARTICLE_AUTH_FIXTURE_DIGEST,
    submission: environment.PARTICLE_SUBMISSION_FIXTURE_DIGEST,
    status: environment.PARTICLE_STATUS_FIXTURE_DIGEST,
  });
  const deploymentConfigDigest = digestLiveAcceptanceDeploymentConfig({
    domain: 'opentab/live-acceptance-deployment-config',
    releaseId: environment.LIVE_ACCEPTANCE_RELEASE_ID,
    environment: environment.APP_ENV,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    checkoutAddress: environment.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: environment.NEXT_PUBLIC_PASS_ADDRESS,
    tokenAddress: environment.NEXT_PUBLIC_USDC_ADDRESS,
    expectedDelegationImplementation: environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
    expectedDelegationCodeHash: environment.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH,
    particleSdkVersion: '2.0.3',
    particleResponseProfileId: environment.PARTICLE_RESPONSE_PROFILE_ID,
    particleFixtureSetDigest,
    particleSourceCallProfilesDigest: digestUnknown(sourceCallProfiles),
    confirmationDepth: environment.CONFIRMATION_DEPTH,
    maximumSlippageBps: environment.PARTICLE_MAX_SLIPPAGE_BPS,
    allowedSourceChainIds,
    allowedSourceAssets,
  });
  const targetConfig = await readLiveTargetConfig(environment.NEXT_PUBLIC_APP_ORIGIN);
  if (
    targetConfig.environment !== environment.APP_ENV ||
    targetConfig.applicationReleaseId.toLowerCase() !==
      environment.LIVE_ACCEPTANCE_RELEASE_ID.toLowerCase() ||
    targetConfig.liveAcceptanceConfigDigest.toLowerCase() !== deploymentConfigDigest.toLowerCase()
  ) {
    throw externalBlocker(
      'The operator live-acceptance configuration does not match the deployed OpenTab release.',
    );
  }
  const liveRunScope = LiveRunScopeSchema.parse({
    domain: 'opentab/live-acceptance-run',
    environment: environment.APP_ENV,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    productId: environment.LIVE_ACCEPTANCE_PRODUCT_ID,
    sourceChainId: gate.sourceChainId,
    checkoutAddress: environment.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: environment.NEXT_PUBLIC_PASS_ADDRESS,
    tokenAddress: environment.NEXT_PUBLIC_USDC_ADDRESS,
    expectedDelegationImplementation: environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
    expectedDelegationCodeHash: asDigest(environment.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH),
    applicationReleaseId: environment.LIVE_ACCEPTANCE_RELEASE_ID,
    particleSdkVersion: '2.0.3',
    particleResponseProfileId: environment.PARTICLE_RESPONSE_PROFILE_ID,
    particleFixtureSetDigest,
    particleSourceCallProfilesDigest: digestUnknown(sourceCallProfiles),
    deploymentConfigDigest,
    confirmationDepth: environment.CONFIRMATION_DEPTH,
    maximumSlippageBps: environment.PARTICLE_MAX_SLIPPAGE_BPS,
    allowedSourceChainIds,
    allowedSourceAssets,
  });
  const scopeDigest = EvidenceDigestSchema.parse(digestUnknown(liveRunScope));
  const completionPath = liveRunCompletionPath(scopeDigest);
  if (fs.existsSync(completionPath)) {
    const completed = readLiveRunCompletion(
      completionPath,
      environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
      liveRunScope,
    );
    const completedDatabase = new PostgresAcceptanceSnapshotStore(
      environment.DATABASE_URL,
      new Date(completed.completion.startedAt),
      environment.APP_ENV,
    );
    const completedArtifactPath = resolveProtectedEvidencePath(
      path.join('artifacts', 'autonomous-build', 'evidence', completed.completion.artifactFileName),
    );
    return completedLiveAcceptanceDependencies({
      artifact: completed.artifact,
      completion: completed.completion,
      completionPath,
      database: completedDatabase,
      acceptedReceiptPath: completedArtifactPath.replace(/\.json$/, '.accepted.json'),
      receiptSecret: environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
    });
  }

  const requestedStartedAt = new Date();
  const requestedEvidenceTarget = resolveProtectedEvidencePath(
    environment.LIVE_ACCEPTANCE_EVIDENCE_PATH,
    requestedStartedAt,
  );
  const requestedIngestionTarget = requestedEvidenceTarget.replace(/\.json$/, '.ingest.json');
  const requestedPendingTarget = requestedEvidenceTarget.replace(/\.json$/, '.pending.json');
  const requestedAcceptedReceiptTarget = requestedEvidenceTarget.replace(
    /\.json$/,
    '.accepted.json',
  );
  const run = reserveLiveAcceptanceRun({
    scope: liveRunScope,
    artifactTarget: requestedEvidenceTarget,
    now: requestedStartedAt,
  });
  const recoveryMode = run.status === 'recovery_required';
  if (
    !recoveryMode &&
    [
      requestedEvidenceTarget,
      requestedIngestionTarget,
      requestedPendingTarget,
      requestedAcceptedReceiptTarget,
    ].some(fs.existsSync)
  ) {
    releaseLiveAcceptanceRun(run.path, run.journal.runId);
    throw externalBlocker(
      'Protected live-evidence files already exist without a matching recovery record. Inspect them; do not pay again.',
    );
  }
  const startedAt = new Date(run.journal.startedAt);
  const evidenceTarget = resolveProtectedEvidencePath(
    path.join('artifacts', 'autonomous-build', 'evidence', run.journal.artifactFileName),
  );
  const ingestionTarget = evidenceTarget.replace(/\.json$/, '.ingest.json');
  const pendingTarget = evidenceTarget.replace(/\.json$/, '.pending.json');
  const acceptedReceiptTarget = evidenceTarget.replace(/\.json$/, '.accepted.json');
  let browser: PlaywrightBrowserBoundary;
  try {
    browser = await PlaywrightBrowserBoundary.create(environment);
    const browserTarget = z
      .object({
        environment: z.enum(['demo-mainnet', 'production']),
        applicationReleaseId: z.string().regex(/^[0-9a-fA-F]{40}$/),
        liveAcceptanceConfigDigest: EvidenceDigestSchema,
      })
      .strict()
      .parse(
        await browser.invoke('assertLiveTargetConfig', {
          environment: environment.APP_ENV,
          applicationReleaseId: environment.LIVE_ACCEPTANCE_RELEASE_ID,
          liveAcceptanceConfigDigest: deploymentConfigDigest,
        }),
      );
    if (
      browserTarget.environment !== environment.APP_ENV ||
      browserTarget.applicationReleaseId.toLowerCase() !==
        environment.LIVE_ACCEPTANCE_RELEASE_ID.toLowerCase() ||
      browserTarget.liveAcceptanceConfigDigest.toLowerCase() !==
        deploymentConfigDigest.toLowerCase()
    ) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'The browser target changed after live-run reservation.',
      );
    }
  } catch (error) {
    if (!recoveryMode) releaseLiveAcceptanceRun(run.path, run.journal.runId);
    throw error;
  }
  const database = new PostgresAcceptanceSnapshotStore(
    environment.DATABASE_URL,
    startedAt,
    environment.APP_ENV,
  );
  const chain = createViemArbitrumReadAdapter({
    environment: environment.APP_ENV,
    primaryRpcUrl: environment.ARBITRUM_RPC_URL,
    fallbackRpcUrl: environment.ARBITRUM_FALLBACK_RPC_URL,
    checkoutAddress: environment.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    passAddress: environment.NEXT_PUBLIC_PASS_ADDRESS,
    expectedDelegationImplementation: environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
    deploymentBlock: BigInt(environment.INDEXER_DEPLOYMENT_BLOCK),
    maxLogRange: 2_000n,
    maxOrderLookupBlocks: BigInt(environment.LIVE_ACCEPTANCE_MAX_LOOKUP_BLOCKS),
    requestTimeoutMs: 15_000,
    resolveProductOnchainId: () => {
      throw new AppError('CONFIGURATION_INVALID', 'Product reads are outside live acceptance.');
    },
  });
  const timeoutMs = Number(environment.LIVE_ACCEPTANCE_TIMEOUT_MS);
  let checkout: z.infer<typeof CheckoutProofSchema> | undefined = run.journal.checkout;
  let identityCheckpoint: z.infer<typeof JournalIdentityResultSchema> | undefined;
  let readinessCheckpoint: z.infer<typeof JournalReadinessResultSchema> | undefined;
  let activationCheckpoint: z.infer<typeof JournalActivationResultSchema> | undefined;
  let delegationCheckpoint: z.infer<typeof JournalDelegationResultSchema> | undefined;
  let particleCheckpoint: z.infer<typeof JournalParticleAccountResultSchema> | undefined;
  let preparedCheckpoint: z.infer<typeof LiveRunPreparedSchema> | undefined =
    run.journal.context?.prepared;
  let journal = run.journal;
  let providerSubmissionStarted = recoveryMode;
  let evidenceCompleted = false;

  const requireCheckout = () => {
    if (checkout === undefined) {
      throw new AppError('INTERNAL_ERROR', 'Live checkout state is unavailable.');
    }
    return checkout;
  };

  const requireRecoveryContext = (): z.infer<typeof LiveRunContextSchema> => {
    const identity = identityCheckpoint;
    const readiness = readinessCheckpoint;
    const delegated = delegationCheckpoint;
    const particle = particleCheckpoint;
    const bound = checkout;
    const prepared = preparedCheckpoint;
    const delegationTransactionHash =
      activationCheckpoint?.transactionHash ?? delegated?.transactionHash;
    if (
      identity === undefined ||
      readiness === undefined ||
      delegated === undefined ||
      particle === undefined ||
      bound === undefined ||
      prepared === undefined ||
      delegationTransactionHash === undefined ||
      !sameEvmAddress(identity.ownerAddress, identity.serverVerifiedAddress) ||
      !sameEvmAddress(identity.ownerAddress, delegated.ownerAddress) ||
      !sameEvmAddress(identity.ownerAddress, particle.ownerAddress) ||
      !sameEvmAddress(identity.ownerAddress, particle.evmAddress)
    ) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'The live recovery context is incomplete before submission.',
      );
    }
    return LiveRunContextSchema.parse({
      ownerAddress: identity.ownerAddress,
      authMethod: identity.authMethod,
      activationPath: readiness.activationPath,
      delegationTransactionHash,
      ...(activationCheckpoint?.sponsorGrantTransactionHash === undefined
        ? {}
        : { sponsorGrantTransactionHash: activationCheckpoint.sponsorGrantTransactionHash }),
      particleProtocolVersion: particle.protocolVersion,
      checkout: bound,
      prepared,
    });
  };

  const checkpoint = (
    stage: LiveRunJournal['stage'],
    options: {
      checkout?: z.infer<typeof CheckoutProofSchema>;
      context?: z.infer<typeof LiveRunContextSchema>;
      submissionStartedAt?: string;
      evidence?: LiveAcceptanceEvidence;
    } = {},
  ): void => {
    const now = new Date().toISOString();
    journal = updateLiveAcceptanceRun(run.path, run.journal.runId, (current) =>
      LiveRunJournalSchema.parse({
        ...current,
        stage,
        updatedAt: now,
        ...(options.checkout === undefined ? {} : { checkout: options.checkout }),
        ...(options.context === undefined ? {} : { context: options.context }),
        ...(options.submissionStartedAt === undefined
          ? {}
          : { submissionStartedAt: options.submissionStartedAt }),
        ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      }),
    );
  };

  const dependencies: ManagedLiveAcceptanceDependencies = {
    recoveryMode,
    acceptanceStartedAt: run.journal.startedAt,
    acceptanceDeploymentConfigDigest: deploymentConfigDigest,
    async authenticateAndExchangeMagicProof() {
      const value = await browser.authenticate(environment);
      identityCheckpoint = JournalIdentityResultSchema.parse(value);
      return value;
    },
    signMagicAddressChallenge: (ownerAddress) =>
      browser.invoke('signAddressChallenge', { ownerAddress }),
    async inspectEip7702Readiness(ownerAddress) {
      const value = await browser.invoke('inspectReadiness', { ownerAddress });
      readinessCheckpoint = JournalReadinessResultSchema.parse(value);
      return value;
    },
    async activateDelegation(readiness) {
      const value = await browser.invoke('activateDelegation', {
        ownerAddress: readiness.ownerAddress,
      });
      activationCheckpoint = JournalActivationResultSchema.parse(value);
      return value;
    },
    async verifyDelegationOnchain(input) {
      const deadline = Date.now() + timeoutMs;
      let successfulReceipt = input.transactionHash === undefined;
      while (Date.now() < deadline) {
        try {
          if (!successfulReceipt && input.transactionHash !== undefined) {
            successfulReceipt = (await chain.getTransactionReceipt(input.transactionHash)).success;
          }
          const code = await chain.getDelegationCode(input.ownerAddress);
          if (
            successfulReceipt &&
            code.accountType === 'delegated_eoa' &&
            code.implementation !== undefined &&
            sameEvmAddress(code.implementation, environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS)
          ) {
            const implementationCode = await readRpcCode(
              environment.ARBITRUM_RPC_URL,
              environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
            ).catch(() =>
              readRpcCode(
                environment.ARBITRUM_FALLBACK_RPC_URL,
                environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
              ),
            );
            if (
              implementationCode === '0x' ||
              keccak256(implementationCode).toLowerCase() !==
                environment.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH.toLowerCase()
            ) {
              throw new AppError(
                'UA_PROVIDER_SCHEMA_INVALID',
                'The delegated implementation bytecode hash is unexpected.',
              );
            }
            const result = {
              ownerAddress: input.ownerAddress,
              delegated: true as const,
              implementationAddress: code.implementation,
              implementationCodeHash: asDigest(
                environment.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH,
              ),
              ...(input.transactionHash === undefined
                ? {}
                : { transactionHash: input.transactionHash }),
            };
            delegationCheckpoint = JournalDelegationResultSchema.parse(result);
            return result;
          }
        } catch (error) {
          if (error instanceof AppError && error.code === 'UA_PROVIDER_SCHEMA_INVALID') throw error;
        }
        await wait(2_000);
      }
      throw new AppError(
        'UA_DELEGATION_REQUIRED',
        'Canonical EIP-7702 delegation was not confirmed before timeout.',
        { retryable: true },
      );
    },
    async initializeParticleEip7702(ownerAddress) {
      const value = await browser.invoke('initializeParticle', { ownerAddress });
      particleCheckpoint = JournalParticleAccountResultSchema.parse(value);
      return value;
    },
    readPreflightBalances: ({ ownerAddress, sourceChainId }) =>
      browser.invoke('readBalances', {
        ownerAddress,
        sourceChainId,
        usdcAddress: environment.NEXT_PUBLIC_USDC_ADDRESS,
      }),
    assertDelegatedPassReceiver: (ownerAddress) =>
      chain.assertDelegatedErc1155Receiver(ownerAddress),
    async createServerBoundCheckout(ownerAddress) {
      if (recoveryMode) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'An interrupted live payment must use recovery and cannot create another checkout.',
        );
      }
      const value = await browser.invoke('createCheckout', {
        ownerAddress,
        productId: environment.LIVE_ACCEPTANCE_PRODUCT_ID,
      });
      checkout = CheckoutProofSchema.parse(value);
      checkpoint('checkout_bound', { checkout });
      return checkout;
    },
    async prepareAndValidateParticleOperation(proof) {
      if (recoveryMode) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'An interrupted live payment cannot prepare another Particle operation.',
        );
      }
      const value = await browser.invoke('prepareOperation', {
        bindingDigest: proof.bindingDigest,
      });
      preparedCheckpoint = LiveRunPreparedSchema.parse(value);
      checkpoint('operation_prepared', { context: requireRecoveryContext() });
      return value;
    },
    signParticleRoot(input) {
      if (recoveryMode) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'An interrupted live payment cannot request another Particle signature.',
        );
      }
      return browser.invoke('signRoot', input);
    },
    async persistProviderOperationBeforeSubmission(input) {
      if (recoveryMode) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'An interrupted live payment cannot persist a replacement Particle operation.',
        );
      }
      await browser.invoke('persistOperation', input);
      checkpoint('operation_persisted', { context: requireRecoveryContext() });
    },
    async submitParticleOperationOnce(input) {
      if (recoveryMode) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'An interrupted live payment cannot submit a second Particle operation.',
        );
      }
      const submissionStartedAt = new Date().toISOString();
      checkpoint('submission_started', {
        context: requireRecoveryContext(),
        submissionStartedAt,
      });
      providerSubmissionStarted = true;
      const value = await browser.invoke('submitOperation', input);
      checkpoint('submitted', {
        context: requireRecoveryContext(),
        submissionStartedAt,
      });
      return value;
    },
    async awaitCanonicalArbitrumPayment(input) {
      const bound = requireCheckout();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [workflowValue, event] = await Promise.all([
          browser.invoke('getRecovery', { paymentAttemptId: bound.attemptId }),
          chain.findOrderEvent(input.orderKey),
        ]);
        const workflow = WorkflowSchema.parse(workflowValue);
        if (
          event !== undefined &&
          workflow.order.id === bound.orderId &&
          workflow.order.status === 'paid' &&
          workflow.attempt.providerOperationId === input.providerOperationId &&
          workflow.canonicalOrderPaid?.canonical === true &&
          workflow.receipt?.status === 'issued' &&
          workflow.receipt.tokenId !== undefined &&
          BigInt(event.confirmations) >= BigInt(input.minimumConfirmations)
        ) {
          const snapshot = await database.snapshot({
            ownerAddress: bound.ownerAddress,
            orderId: bound.orderId,
            attemptId: bound.attemptId,
            providerOperationId: input.providerOperationId,
          });
          if (
            snapshot.receiptId !== undefined &&
            snapshot.passTokenId === workflow.receipt.tokenId
          ) {
            return {
              providerOperationId: input.providerOperationId,
              event,
              receiptId: ReceiptIdSchema.parse(snapshot.receiptId),
              passTokenId: workflow.receipt.tokenId,
            };
          }
        }
        await wait(3_000);
      }
      throw new AppError(
        'PAYMENT_SUBMITTED_UNKNOWN',
        'Canonical Arbitrum payment was not confirmed before timeout.',
        { retryable: true, submissionPossible: true },
      );
    },
    async readFinalProviderOperation(providerOperationId) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const operation = ProviderOperationSchema.parse(
          await browser.invoke(
            recoveryMode ? 'getProviderOperationForRecovery' : 'getProviderOperation',
            recoveryMode
              ? {
                  ownerAddress: run.journal.context?.ownerAddress,
                  providerOperationId,
                }
              : { providerOperationId },
          ),
        );
        if (operation.id !== providerOperationId) {
          throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle operation ID changed.');
        }
        if (operation.status === 'succeeded') {
          if (!operation.submissionPossible || operation.destinationTransactionHash === undefined) {
            throw new AppError(
              'UA_PROVIDER_SCHEMA_INVALID',
              'A successful Particle operation lacked canonical submission evidence.',
            );
          }
          return operation;
        }
        if (['failed', 'refunded'].includes(operation.status)) {
          throw new AppError(
            'UA_SUBMISSION_FAILED',
            'Particle reached a terminal state without a successful Arbitrum settlement.',
          );
        }
        await wait(3_000);
      }
      throw new AppError(
        'UA_STATUS_UNKNOWN',
        'Particle did not expose the final successful operation before timeout.',
        { retryable: true, submissionPossible: true },
      );
    },
    async reloadAndReconcile(providerOperationId, finalProviderOperation) {
      const bound = requireCheckout();
      await browser.reload();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const workflow = WorkflowSchema.parse(
          await browser.invoke('getRecovery', { paymentAttemptId: bound.attemptId }),
        );
        const snapshot = await database.snapshot({
          ownerAddress: bound.ownerAddress,
          orderId: bound.orderId,
          attemptId: bound.attemptId,
          providerOperationId,
        });
        if (
          snapshot.orderCount > 1 ||
          snapshot.paymentAttemptCount > 1 ||
          snapshot.providerOperationCount > 1 ||
          snapshot.submissionCount > 1 ||
          snapshot.receiptCount > 1 ||
          snapshot.sponsorGrantCount > 1 ||
          snapshot.delegationCount > 1
        ) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Refresh recovery discovered duplicate live payment state.',
          );
        }
        if (
          workflow.order.status === 'paid' &&
          workflow.attempt.providerOperationId === providerOperationId &&
          workflow.canonicalOrderPaid?.transactionHash.toLowerCase() ===
            finalProviderOperation.destinationTransactionHash.toLowerCase() &&
          snapshot.finalOrderStatus === 'paid' &&
          snapshot.orderCount === 1 &&
          snapshot.paymentAttemptCount === 1 &&
          snapshot.submissionCount === 1 &&
          snapshot.receiptCount === 1 &&
          hasExactPersistedProviderObservation(snapshot, finalProviderOperation)
        ) {
          return {
            providerOperationId,
            finalOrderStatus: 'paid' as const,
            sponsorGrantCount: snapshot.sponsorGrantCount,
            delegationCount: snapshot.delegationCount,
            orderCount: 1 as const,
            paymentAttemptCount: 1 as const,
            providerOperationCount: 1 as const,
            submissionCount: 1 as const,
            receiptCount: 1 as const,
          };
        }
        await wait(2_000);
      }
      throw new AppError(
        'UA_STATUS_UNKNOWN',
        'Canonical payment is safe, but terminal provider evidence has not reconciled yet.',
        { retryable: true, submissionPossible: true },
      );
    },
    async resumeInterruptedAcceptance() {
      if (!recoveryMode) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'No interrupted live-acceptance run is available for recovery.',
        );
      }
      if (run.journal.stage === 'evidence_ready' && run.journal.evidence !== undefined) {
        await dependencies.persistSanitizedEvidence(run.journal.evidence);
        return run.journal.evidence;
      }
      const context = run.journal.context;
      if (
        context === undefined ||
        !['operation_persisted', 'submission_started', 'submitted'].includes(run.journal.stage)
      ) {
        throw externalBlocker(
          `The interrupted run is at ${run.journal.stage}; it cannot be proven submitted. ` +
            'Keep the journal and inspect the recorded checkout before retiring this canary.',
        );
      }
      const recoveryStarted = Date.now();
      const identity = JournalIdentityResultSchema.parse(
        await dependencies.authenticateAndExchangeMagicProof(),
      );
      if (
        !sameEvmAddress(identity.ownerAddress, context.ownerAddress) ||
        identity.authMethod !== context.authMethod
      ) {
        throw new AppError(
          'WALLET_ADDRESS_MISMATCH',
          'The fresh Magic recovery identity does not own the interrupted payment.',
        );
      }
      const challenge = z
        .object({ recoveredOwner: EvmAddressSchema })
        .passthrough()
        .parse(await dependencies.signMagicAddressChallenge(identity.ownerAddress));
      if (!sameEvmAddress(challenge.recoveredOwner, context.ownerAddress)) {
        throw new AppError(
          'WALLET_ADDRESS_MISMATCH',
          'The recovery address challenge did not match the interrupted payment.',
        );
      }
      const verifiedDelegation = z
        .object({
          ownerAddress: EvmAddressSchema,
          delegated: z.literal(true),
          implementationAddress: EvmAddressSchema,
          implementationCodeHash: EvidenceDigestSchema,
          transactionHash: TransactionHashSchema.optional(),
        })
        .parse(
          await dependencies.verifyDelegationOnchain({
            ownerAddress: context.ownerAddress,
            transactionHash: context.delegationTransactionHash,
          }),
        );
      if (
        !sameEvmAddress(verifiedDelegation.ownerAddress, context.ownerAddress) ||
        !sameEvmAddress(
          verifiedDelegation.implementationAddress,
          run.journal.scope.expectedDelegationImplementation,
        ) ||
        verifiedDelegation.implementationCodeHash.toLowerCase() !==
          run.journal.scope.expectedDelegationCodeHash.toLowerCase()
      ) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'The interrupted run no longer has the configured EIP-7702 delegation.',
        );
      }
      const particle = JournalParticleAccountResultSchema.parse(
        await dependencies.initializeParticleEip7702(context.ownerAddress),
      );
      if (
        !sameEvmAddress(particle.ownerAddress, context.ownerAddress) ||
        !sameEvmAddress(particle.evmAddress, context.ownerAddress) ||
        particle.protocolVersion !== context.particleProtocolVersion
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The recovered Particle account does not match the interrupted run.',
        );
      }
      const workflow = WorkflowSchema.parse(
        await browser.invoke('getRecovery', {
          paymentAttemptId: context.checkout.attemptId,
        }),
      );
      if (
        workflow.attempt.id !== context.checkout.attemptId ||
        workflow.order.id !== context.checkout.orderId ||
        workflow.attempt.providerOperationId !== context.prepared.providerOperationId ||
        ![
          'submission_started',
          'submitted',
          'submitted_unknown',
          'executing',
          'confirming',
          'paid',
        ].includes(workflow.attempt.status)
      ) {
        throw externalBlocker(
          'The durable attempt does not prove that the interrupted operation was submitted. ' +
            'The recovery journal remains active and no new payment was started.',
        );
      }
      const finalProviderOperation = ProviderOperationSchema.extend({
        status: z.literal('succeeded'),
        submissionPossible: z.literal(true),
        destinationTransactionHash: TransactionHashSchema,
      })
        .strict()
        .parse(await dependencies.readFinalProviderOperation(context.prepared.providerOperationId));
      const payment = RecoveredCanonicalPaymentSchema.parse(
        await dependencies.awaitCanonicalArbitrumPayment({
          providerOperationId: context.prepared.providerOperationId,
          orderKey: OrderKeySchema.parse(context.checkout.orderKey),
          minimumConfirmations: environment.CONFIRMATION_DEPTH,
        }),
      );
      const fields = payment.event.eventName === 'OrderPaid' ? payment.event.fields : undefined;
      if (
        fields === undefined ||
        payment.providerOperationId !== context.prepared.providerOperationId ||
        finalProviderOperation.id !== context.prepared.providerOperationId ||
        finalProviderOperation.destinationTransactionHash.toLowerCase() !==
          payment.event.transactionHash.toLowerCase() ||
        payment.event.chainId !== ARBITRUM_ONE_CHAIN_ID ||
        !payment.event.canonical ||
        BigInt(payment.event.confirmations) < BigInt(environment.CONFIRMATION_DEPTH) ||
        !sameEvmAddress(payment.event.contractAddress, context.checkout.checkoutAddress) ||
        fields.orderKey.toLowerCase() !== context.checkout.orderKey.toLowerCase() ||
        fields.merchantOnchainId !== context.checkout.merchantOnchainId ||
        fields.productOnchainId !== context.checkout.productOnchainId ||
        !sameEvmAddress(fields.payer, context.ownerAddress) ||
        !sameEvmAddress(fields.recipient, context.checkout.recipientAddress) ||
        !sameEvmAddress(fields.token, context.checkout.tokenAddress) ||
        fields.amountBaseUnits !== context.checkout.amountBaseUnits ||
        fields.platformFeeBaseUnits !== context.checkout.platformFeeBaseUnits ||
        fields.quantity !== context.checkout.quantity ||
        fields.intentDigest.toLowerCase() !== context.checkout.intentDigest.toLowerCase() ||
        fields.refundDeadline !== context.checkout.refundDeadline ||
        fields.passTokenId !== payment.passTokenId
      ) {
        throw new AppError(
          'PAYMENT_EVENT_MISMATCH',
          'The recovered canonical payment does not match the interrupted checkout.',
        );
      }
      const recovered = RecoveredCountsSchema.parse(
        await dependencies.reloadAndReconcile(
          context.prepared.providerOperationId,
          finalProviderOperation,
        ),
      );
      const observedAt = new Date().toISOString();
      const activityUrl = finalProviderOperation.activityUrl;
      if (
        context.prepared.activityUrl !== undefined &&
        activityUrl !== context.prepared.activityUrl
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The recovered Particle activity URL changed after submission.',
        );
      }
      const evidence = LiveAcceptanceArtifactSchema.parse({
        status: 'LIVE_ACCEPTANCE_EVIDENCED',
        schemaVersion: 1,
        environment: run.journal.scope.environment,
        releaseId: run.journal.scope.applicationReleaseId,
        deploymentConfigDigest: run.journal.scope.deploymentConfigDigest,
        orderId: context.checkout.orderId,
        paymentAttemptId: context.checkout.attemptId,
        startedAt: run.journal.startedAt,
        capturedAt: observedAt,
        ownerAddressBefore: context.ownerAddress,
        ownerAddressAfter: particle.evmAddress,
        authMethod: context.authMethod,
        activationPath: context.activationPath,
        delegationTransactionHash: context.delegationTransactionHash,
        ...(context.sponsorGrantTransactionHash === undefined
          ? {}
          : { sponsorGrantTransactionHash: context.sponsorGrantTransactionHash }),
        providerOperation: finalProviderOperation,
        particle: {
          protocolVersion: context.particleProtocolVersion,
          useEIP7702: true,
          safeAccountIdentifiers: [context.ownerAddress],
          providerOperationId: context.prepared.providerOperationId,
          ...(activityUrl === undefined ? {} : { activityUrl }),
          sources: context.prepared.sources,
          totalUsd: context.prepared.totalUsd,
          estimatedFeeUsd: context.prepared.estimatedFeeUsd,
          slippageBps: context.prepared.slippageBps,
          quotedAt: context.prepared.quotedAt,
          expiresAt: context.prepared.expiresAt,
          previewDigest: context.prepared.previewDigest,
        },
        arbitrum: {
          event: payment.event,
          receiptId: payment.receiptId,
          passTokenId: payment.passTokenId,
        },
        recovery: {
          ...recovered,
          browserReloadObserved: true,
          observedAt,
        },
        timingMs: {
          hardRestartRecovery: Math.max(0, Date.now() - recoveryStarted),
        },
      });
      await dependencies.persistSanitizedEvidence(evidence);
      return evidence;
    },
    async persistSanitizedEvidence(value) {
      const safe = sanitizedEvidence(value);
      if (
        safe.releaseId.toLowerCase() !== run.journal.scope.applicationReleaseId.toLowerCase() ||
        safe.startedAt !== run.journal.startedAt
      ) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Live evidence release or start time differs from the reserved deployment scope.',
        );
      }
      if (journal.stage !== 'evidence_ready') {
        const context = journal.context ?? requireRecoveryContext();
        const submissionStartedAt = journal.submissionStartedAt;
        if (submissionStartedAt === undefined) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Live evidence cannot finalize before a durable submission checkpoint.',
          );
        }
        checkpoint('evidence_ready', { context, submissionStartedAt, evidence: safe });
      } else if (
        journal.evidence === undefined ||
        serializeLiveAcceptanceArtifact(journal.evidence) !== serializeLiveAcceptanceArtifact(safe)
      ) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Recovered live evidence differs from the canonical journal checkpoint.',
        );
      }
      const ingestion = LiveAcceptanceEvidenceInputSchema.parse({
        schemaVersion: 1,
        environment: safe.environment,
        releaseId: safe.releaseId,
        deploymentConfigDigest: safe.deploymentConfigDigest,
        orderId: safe.orderId,
        paymentAttemptId: safe.paymentAttemptId,
        providerOperationId: safe.particle.providerOperationId,
        providerOperation: safe.providerOperation,
        context: {
          ownerAddress: safe.ownerAddressBefore,
          authMethod: safe.authMethod,
          activationPath: safe.activationPath,
          delegationTransactionHash: safe.delegationTransactionHash,
          ...(safe.sponsorGrantTransactionHash === undefined
            ? {}
            : { sponsorGrantTransactionHash: safe.sponsorGrantTransactionHash }),
          particleProtocolVersion: safe.particle.protocolVersion,
          useEIP7702: true,
          safeAccountIdentifiers: safe.particle.safeAccountIdentifiers,
        },
        startedAt: safe.startedAt,
        route: {
          totalUsd: safe.particle.totalUsd,
          estimatedFeeUsd: safe.particle.estimatedFeeUsd,
          slippageBps: safe.particle.slippageBps,
          quotedAt: safe.particle.quotedAt,
          expiresAt: safe.particle.expiresAt,
          previewDigest: safe.particle.previewDigest,
          sources: safe.particle.sources,
          ...(safe.particle.activityUrl === undefined
            ? {}
            : { activityUrl: safe.particle.activityUrl }),
        },
        settlement: {
          event: safe.arbitrum.event,
          receiptId: safe.arbitrum.receiptId,
          passTokenId: safe.arbitrum.passTokenId,
        },
        recovery: {
          browserReloadObserved: true,
          finalOrderStatus: safe.recovery.finalOrderStatus,
          sponsorGrantCount: safe.recovery.sponsorGrantCount,
          delegationCount: safe.recovery.delegationCount,
          orderCount: safe.recovery.orderCount,
          paymentAttemptCount: safe.recovery.paymentAttemptCount,
          providerOperationCount: safe.recovery.providerOperationCount,
          submissionCount: safe.recovery.submissionCount,
          receiptCount: safe.recovery.receiptCount,
          observedAt: safe.recovery.observedAt,
        },
        timingMs: safe.timingMs,
        capturedAt: safe.capturedAt,
      });
      ensureProtectedEvidenceFile(ingestionTarget, `${JSON.stringify(ingestion)}\n`);
      ensureProtectedEvidenceFile(pendingTarget, serializeLiveAcceptanceArtifact(safe));
      await execFileAsync('pnpm', ['--filter', '@opentab/db', 'evidence:ingest', ingestionTarget], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PNPM_HOME: process.env.PNPM_HOME,
          NODE_OPTIONS: process.env.NODE_OPTIONS,
          APP_ENV: environment.APP_ENV,
          DATABASE_URL_EVIDENCE_WRITER: environment.DATABASE_URL_EVIDENCE_WRITER,
          LIVE_ACCEPTANCE_ATTESTATION_SECRET: environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
          LIVE_ACCEPTANCE_RELEASE_ID: environment.LIVE_ACCEPTANCE_RELEASE_ID,
          NEXT_PUBLIC_CHECKOUT_ADDRESS: environment.NEXT_PUBLIC_CHECKOUT_ADDRESS,
          NEXT_PUBLIC_PASS_ADDRESS: environment.NEXT_PUBLIC_PASS_ADDRESS,
          NEXT_PUBLIC_USDC_ADDRESS: environment.NEXT_PUBLIC_USDC_ADDRESS,
          CONFIRMATION_DEPTH: environment.CONFIRMATION_DEPTH,
          PARTICLE_MAX_SLIPPAGE_BPS: environment.PARTICLE_MAX_SLIPPAGE_BPS,
          PARTICLE_ALLOWED_SOURCE_CHAIN_IDS: environment.PARTICLE_ALLOWED_SOURCE_CHAIN_IDS,
          PARTICLE_ALLOWED_SOURCE_ASSETS: environment.PARTICLE_ALLOWED_SOURCE_ASSETS,
          PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS:
            environment.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS,
          PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH:
            environment.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH,
          PARTICLE_RESPONSE_PROFILE_ID: environment.PARTICLE_RESPONSE_PROFILE_ID,
          PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: environment.PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST,
          PARTICLE_AUTH_FIXTURE_DIGEST: environment.PARTICLE_AUTH_FIXTURE_DIGEST,
          PARTICLE_SUBMISSION_FIXTURE_DIGEST: environment.PARTICLE_SUBMISSION_FIXTURE_DIGEST,
          PARTICLE_STATUS_FIXTURE_DIGEST: environment.PARTICLE_STATUS_FIXTURE_DIGEST,
          PARTICLE_SOURCE_CALL_PROFILES_JSON: environment.PARTICLE_SOURCE_CALL_PROFILES_JSON,
        },
        timeout: 120_000,
        maxBuffer: 64 * 1024,
      });
      const receipt = verifyLiveAcceptanceReceipt(
        environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
        JSON.parse(readProtectedEvidenceFile(acceptedReceiptTarget)),
      );
      const completion = createLiveRunCompletion(environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET, {
        schemaVersion: 1,
        domain: 'opentab/live-acceptance-completion',
        scopeDigest: run.journal.scopeDigest,
        scope: run.journal.scope,
        runId: run.journal.runId,
        startedAt: run.journal.startedAt,
        artifactFileName: run.journal.artifactFileName,
        artifactFileDigest: digestLiveAcceptanceFile(serializeLiveAcceptanceArtifact(safe)),
        orderId: safe.orderId,
        paymentAttemptId: safe.paymentAttemptId,
        providerOperationId: safe.particle.providerOperationId,
        evidenceId: receipt.evidenceId,
        payloadDigest: receipt.payloadDigest,
        completedAt: receipt.acceptedAt,
        receipt,
      });
      await database.assertCompletedEvidence(safe, completion);
      promotePendingLiveEvidence(pendingTarget, environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET, {
        retainAcceptedReceipt: true,
      });
      const completionTarget = liveRunCompletionPath(run.journal.scopeDigest);
      ensureProtectedEvidenceFile(completionTarget, serializeLiveRunCompletion(completion));
      const verifiedCompletion = readLiveRunCompletion(
        completionTarget,
        environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
        run.journal.scope,
      );
      await database.assertCompletedEvidence(
        verifiedCompletion.artifact,
        verifiedCompletion.completion,
      );
      releaseLiveAcceptanceRun(run.path, run.journal.runId);
      removeProtectedEvidenceFile(acceptedReceiptTarget);
      evidenceCompleted = true;
    },
    async close() {
      await Promise.allSettled([browser.close(), database.close()]);
      if (!providerSubmissionStarted || evidenceCompleted) {
        if (fs.existsSync(run.path)) releaseLiveAcceptanceRun(run.path, run.journal.runId);
      }
    },
  };
  return dependencies;
}

function asDigest(value: string): EvidenceDigest {
  return EvidenceDigestSchema.parse(value);
}

export const LIVE_DRIVER_IMPLEMENTED = true as const;
