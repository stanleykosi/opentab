import { z } from 'zod';
import { ARBITRUM_ONE_CHAIN_ID, ChainIdSchema, EvmAddressSchema } from './address.js';
import { CanonicalEventProofSchema } from './chain-events.js';
import { digestUnknown } from './evidence-digest.js';
import {
  EvidenceDigestSchema,
  OrderIdSchema,
  PaymentAttemptIdSchema,
  ProviderOperationIdSchema,
  ReceiptIdSchema,
  TransactionHashSchema,
} from './ids.js';
import { BaseUnitAmountSchema, UnsignedIntegerStringSchema } from './money.js';
import { ProviderOperationSchema } from './provider.js';

const UsdAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const TimingNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);
const ApplicationReleaseIdSchema = z.string().regex(/^[0-9a-fA-F]{40}$/);

/**
 * How the EIP-7702 delegation became active for a live acceptance run.
 * `provider_atomic` is reserved for a provider operation that was observed to
 * include the authorization atomically; an explicit Magic Type-4 transaction
 * paid by the owner is `self_funded_type4`.
 */
export const LiveAcceptanceActivationPathSchema = z.enum([
  'already_delegated',
  'provider_atomic',
  'self_funded_type4',
  'bootstrap_sponsor',
]);
export type LiveAcceptanceActivationPath = z.infer<typeof LiveAcceptanceActivationPathSchema>;

export const LiveAcceptanceDeploymentConfigSchema = z
  .object({
    domain: z.literal('opentab/live-acceptance-deployment-config'),
    releaseId: ApplicationReleaseIdSchema,
    environment: z.enum(['demo-mainnet', 'production']),
    chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
    checkoutAddress: EvmAddressSchema,
    passAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    expectedDelegationImplementation: EvmAddressSchema,
    expectedDelegationCodeHash: EvidenceDigestSchema,
    particleSdkVersion: z.literal('2.0.3'),
    particleResponseProfileId: z.string().regex(/^[A-Za-z0-9_.:/-]{3,120}$/),
    particleFixtureSetDigest: EvidenceDigestSchema,
    particleSourceCallProfilesDigest: EvidenceDigestSchema,
    confirmationDepth: z.string().regex(/^[1-9][0-9]*$/),
    maximumSlippageBps: z.string().regex(/^(0|[1-9][0-9]*)$/),
    allowedSourceChainIds: z.array(ChainIdSchema).min(1).max(30),
    allowedSourceAssets: z
      .array(z.enum(['USDC', 'USDT', 'ETH']))
      .min(1)
      .max(3),
  })
  .strict();

export function digestLiveAcceptanceDeploymentConfig(
  input: unknown,
): z.infer<typeof EvidenceDigestSchema> {
  const parsed = LiveAcceptanceDeploymentConfigSchema.parse(input);
  return EvidenceDigestSchema.parse(
    digestUnknown({
      ...parsed,
      allowedSourceChainIds: [...new Set(parsed.allowedSourceChainIds)].sort(),
      allowedSourceAssets: [...new Set(parsed.allowedSourceAssets)].sort(),
    }),
  );
}

export const LiveAcceptanceRouteSchema = z
  .object({
    totalUsd: UsdAmountSchema,
    estimatedFeeUsd: UsdAmountSchema,
    slippageBps: UnsignedIntegerStringSchema,
    quotedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    previewDigest: EvidenceDigestSchema,
    sources: z
      .array(
        z.object({
          chainId: ChainIdSchema,
          symbol: z.string().min(1).max(20),
          amount: z.string().min(1).max(100),
          amountUsd: UsdAmountSchema,
        }),
      )
      .min(1)
      .max(20),
    activityUrl: z.string().url().optional(),
  })
  .strict()
  .refine(
    (route) => route.sources.some((source) => source.chainId !== ARBITRUM_ONE_CHAIN_ID),
    'Live acceptance requires a non-Arbitrum source asset.',
  );

export const LiveAcceptanceRecoverySchema = z
  .object({
    browserReloadObserved: z.literal(true),
    finalOrderStatus: z.literal('paid'),
    sponsorGrantCount: z.number().int().min(0).max(1),
    delegationCount: z.number().int().min(0).max(1),
    orderCount: z.literal(1),
    paymentAttemptCount: z.literal(1),
    providerOperationCount: z.literal(1),
    submissionCount: z.literal(1),
    receiptCount: z.literal(1),
    observedAt: z.string().datetime(),
  })
  .strict();

/**
 * Sanitized output from the privileged live-acceptance harness. This schema is
 * deliberately not exposed by an HTTP route; the database ingestion adapter
 * revalidates every identifier against durable workflow and canonical-chain
 * records before making it eligible for Judge Mode.
 */
export const LiveAcceptanceEvidenceInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.enum(['demo-mainnet', 'production']),
    releaseId: ApplicationReleaseIdSchema,
    deploymentConfigDigest: EvidenceDigestSchema,
    orderId: OrderIdSchema,
    paymentAttemptId: PaymentAttemptIdSchema,
    providerOperationId: ProviderOperationIdSchema,
    providerOperation: ProviderOperationSchema.extend({
      status: z.literal('succeeded'),
      submissionPossible: z.literal(true),
      destinationTransactionHash: TransactionHashSchema,
    }).strict(),
    context: z
      .object({
        ownerAddress: EvmAddressSchema,
        authMethod: z.enum(['google', 'email_otp']),
        activationPath: LiveAcceptanceActivationPathSchema,
        delegationTransactionHash: TransactionHashSchema,
        sponsorGrantTransactionHash: TransactionHashSchema.optional(),
        particleProtocolVersion: z.string().min(1).max(40),
        useEIP7702: z.literal(true),
        safeAccountIdentifiers: z.array(EvmAddressSchema).length(1),
      })
      .strict(),
    startedAt: z.string().datetime(),
    route: LiveAcceptanceRouteSchema,
    settlement: z
      .object({
        event: CanonicalEventProofSchema,
        receiptId: ReceiptIdSchema,
        passTokenId: UnsignedIntegerStringSchema.refine((value) => BigInt(value) > 0n),
      })
      .strict(),
    recovery: LiveAcceptanceRecoverySchema,
    timingMs: z
      .record(TimingNameSchema, z.number().int().min(0).max(3_600_000))
      .refine((value) => Object.keys(value).length <= 30, 'Too many timing phases.'),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const event = value.settlement.event;
    if (value.providerOperation.id !== value.providerOperationId) {
      context.addIssue({
        code: 'custom',
        path: ['providerOperation', 'id'],
        message: 'Provider operation ID mismatch',
      });
    }
    if (
      event.eventName === 'OrderPaid' &&
      value.context.ownerAddress.toLowerCase() !== event.fields.payer.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['context', 'ownerAddress'],
        message: 'Acceptance owner mismatch',
      });
    }
    if (
      value.context.safeAccountIdentifiers[0]?.toLowerCase() !==
      value.context.ownerAddress.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['context', 'safeAccountIdentifiers'],
        message: 'EIP-7702 account continuity mismatch',
      });
    }
    if (
      (value.context.activationPath === 'bootstrap_sponsor') !==
      (value.context.sponsorGrantTransactionHash !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['context', 'sponsorGrantTransactionHash'],
        message: 'Sponsor evidence does not match activation path',
      });
    }
    if (
      event.eventName === 'OrderPaid' &&
      value.providerOperation.destinationTransactionHash.toLowerCase() !==
        event.transactionHash.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerOperation', 'destinationTransactionHash'],
        message: 'Provider destination transaction mismatch',
      });
    }
    if (value.providerOperation.activityUrl !== value.route.activityUrl) {
      context.addIssue({
        code: 'custom',
        path: ['providerOperation', 'activityUrl'],
        message: 'Provider activity URL mismatch',
      });
    }
    if (event.eventName !== 'OrderPaid') {
      context.addIssue({
        code: 'custom',
        path: ['settlement', 'event'],
        message: 'OrderPaid required',
      });
      return;
    }
    if (event.chainId !== ARBITRUM_ONE_CHAIN_ID) {
      context.addIssue({
        code: 'custom',
        path: ['settlement', 'event', 'chainId'],
        message: 'Arbitrum One required',
      });
    }
    if (event.fields.passTokenId !== value.settlement.passTokenId) {
      context.addIssue({
        code: 'custom',
        path: ['settlement', 'passTokenId'],
        message: 'Pass token mismatch',
      });
    }
    if (
      new Date(value.startedAt).getTime() > new Date(value.recovery.observedAt).getTime() ||
      new Date(value.recovery.observedAt).getTime() > new Date(value.capturedAt).getTime()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['capturedAt'],
        message: 'Acceptance timestamps are out of order',
      });
    }
  });

export type LiveAcceptanceEvidenceInput = z.infer<typeof LiveAcceptanceEvidenceInputSchema>;
export type LiveAcceptanceRoute = z.infer<typeof LiveAcceptanceRouteSchema>;

const LiveAcceptanceFinalProviderOperationSchema = ProviderOperationSchema.extend({
  status: z.literal('succeeded'),
  submissionPossible: z.literal(true),
  destinationTransactionHash: TransactionHashSchema,
}).strict();

export const LiveAcceptanceArtifactSchema = z
  .object({
    status: z.literal('LIVE_ACCEPTANCE_EVIDENCED'),
    schemaVersion: z.literal(1),
    environment: z.enum(['demo-mainnet', 'production']),
    releaseId: ApplicationReleaseIdSchema,
    deploymentConfigDigest: EvidenceDigestSchema,
    orderId: OrderIdSchema,
    paymentAttemptId: PaymentAttemptIdSchema,
    startedAt: z.string().datetime(),
    capturedAt: z.string().datetime(),
    ownerAddressBefore: EvmAddressSchema,
    ownerAddressAfter: EvmAddressSchema,
    authMethod: z.enum(['google', 'email_otp']),
    activationPath: LiveAcceptanceActivationPathSchema,
    delegationTransactionHash: TransactionHashSchema,
    sponsorGrantTransactionHash: TransactionHashSchema.optional(),
    providerOperation: LiveAcceptanceFinalProviderOperationSchema,
    particle: z
      .object({
        protocolVersion: z.string().min(1).max(40),
        useEIP7702: z.literal(true),
        safeAccountIdentifiers: z.array(EvmAddressSchema).length(1),
        providerOperationId: ProviderOperationIdSchema,
        activityUrl: z.string().url().optional(),
        sources: LiveAcceptanceRouteSchema.shape.sources,
        totalUsd: LiveAcceptanceRouteSchema.shape.totalUsd,
        estimatedFeeUsd: LiveAcceptanceRouteSchema.shape.estimatedFeeUsd,
        slippageBps: LiveAcceptanceRouteSchema.shape.slippageBps,
        quotedAt: z.string().datetime(),
        expiresAt: z.string().datetime(),
        previewDigest: EvidenceDigestSchema,
      })
      .strict(),
    arbitrum: z
      .object({
        event: CanonicalEventProofSchema,
        receiptId: ReceiptIdSchema,
        passTokenId: UnsignedIntegerStringSchema.refine((value) => BigInt(value) > 0n),
      })
      .strict(),
    recovery: LiveAcceptanceRecoverySchema.extend({
      providerOperationId: ProviderOperationIdSchema,
    }).strict(),
    timingMs: z
      .record(TimingNameSchema, z.number().int().min(0).max(3_600_000))
      .refine((value) => Object.keys(value).length <= 30, 'Too many timing phases.'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ownerAddressBefore.toLowerCase() !== value.ownerAddressAfter.toLowerCase()) {
      context.addIssue({ code: 'custom', path: ['ownerAddressAfter'], message: 'Owner mismatch' });
    }
    if (
      value.particle.providerOperationId !== value.providerOperation.id ||
      value.particle.activityUrl !== value.providerOperation.activityUrl ||
      value.recovery.providerOperationId !== value.providerOperation.id
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerOperation'],
        message: 'Provider operation binding mismatch',
      });
    }
    if (
      value.particle.safeAccountIdentifiers[0]?.toLowerCase() !==
      value.ownerAddressBefore.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['particle', 'safeAccountIdentifiers'],
        message: 'EIP-7702 account continuity mismatch',
      });
    }
    if (
      (value.activationPath === 'bootstrap_sponsor') !==
      (value.sponsorGrantTransactionHash !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sponsorGrantTransactionHash'],
        message: 'Sponsor evidence does not match activation path',
      });
    }
    if (
      value.arbitrum.event.eventName !== 'OrderPaid' ||
      value.providerOperation.destinationTransactionHash.toLowerCase() !==
        value.arbitrum.event.transactionHash.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['arbitrum', 'event'],
        message: 'Settlement transaction binding mismatch',
      });
    }
    if (
      new Date(value.startedAt).getTime() > new Date(value.recovery.observedAt).getTime() ||
      new Date(value.recovery.observedAt).getTime() > new Date(value.capturedAt).getTime()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['capturedAt'],
        message: 'Timestamp order invalid',
      });
    }
  });

export type LiveAcceptanceArtifact = z.infer<typeof LiveAcceptanceArtifactSchema>;

function sortArtifactKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortArtifactKeys);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, sortArtifactKeys(object[key])]),
  );
}

export function serializeLiveAcceptanceArtifact(value: unknown): string {
  const artifact = LiveAcceptanceArtifactSchema.parse(value);
  return `${JSON.stringify(sortArtifactKeys(artifact), null, 2)}\n`;
}

export function sumAcceptanceTimingMs(timing: Readonly<Record<string, number>>): string {
  return Object.values(timing)
    .reduce((total, value) => total + BigInt(value), 0n)
    .toString();
}

export function acceptanceTimingPhaseMs(
  timing: Readonly<Record<string, number>>,
  phases: readonly string[],
): string | undefined {
  const values = phases.map((phase) => timing[phase]).filter((value) => value !== undefined);
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

export const LIVE_ACCEPTANCE_ARBITRUM_CHAIN_ID = ARBITRUM_ONE_CHAIN_ID;
export const LIVE_ACCEPTANCE_SCHEMA_VERSION = 1 as const;
export const LIVE_ACCEPTANCE_MAX_PAYMENT_BASE_UNITS = BaseUnitAmountSchema.parse('1000000');
