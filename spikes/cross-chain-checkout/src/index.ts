import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  CanonicalEventProofSchema,
  type ChainId,
  ChainIdSchema,
  type EvidenceDigest,
  EvidenceDigestSchema,
  type EvmAddress,
  EvmAddressSchema,
  LiveAcceptanceActivationPathSchema,
  type LiveAcceptanceArtifact,
  LiveAcceptanceArtifactSchema,
  type OrderKey,
  OrderKeySchema,
  ProductIdSchema,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  ProviderOperationSchema,
  ReceiptIdSchema,
  sameEvmAddress,
  type TransactionHash,
  TransactionHashSchema,
} from '@opentab/shared';
import { z } from 'zod';

export const LIVE_TRANSACTION_CONFIRMATION = 'I_ACKNOWLEDGE_TINY_ARBITRUM_MAINNET_SPEND';
export const MAX_LIVE_ACCEPTANCE_USDC_BASE_UNITS = 1_000_000n;

const REQUIRED_LIVE_ENVIRONMENT = [
  'NEXT_PUBLIC_APP_ORIGIN',
  'NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY',
  'MAGIC_SECRET_KEY',
  'NEXT_PUBLIC_PARTICLE_PROJECT_ID',
  'NEXT_PUBLIC_PARTICLE_CLIENT_KEY',
  'NEXT_PUBLIC_PARTICLE_APP_UUID',
  'PARTICLE_RPC_URL',
  'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
  'PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH',
  'PARTICLE_RESPONSE_PROFILE_ID',
  'PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST',
  'PARTICLE_AUTH_FIXTURE_DIGEST',
  'PARTICLE_SUBMISSION_FIXTURE_DIGEST',
  'PARTICLE_STATUS_FIXTURE_DIGEST',
  'PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET',
  'PARTICLE_DELEGATION_PLAN_TTL_SECONDS',
  'PARTICLE_ALLOWED_SOURCE_CHAIN_IDS',
  'PARTICLE_ALLOWED_SOURCE_ASSETS',
  'PARTICLE_ALLOWED_SOURCE_TOKENS',
  'PARTICLE_SOURCE_CALL_PROFILES_JSON',
  'ARBITRUM_RPC_URL',
  'ARBITRUM_FALLBACK_RPC_URL',
  'NEXT_PUBLIC_USDC_ADDRESS',
  'NEXT_PUBLIC_CHECKOUT_ADDRESS',
  'NEXT_PUBLIC_PASS_ADDRESS',
  'DATABASE_URL',
  'DATABASE_URL_EVIDENCE_WRITER',
  'REDIS_URL',
  'SESSION_HASH_PEPPER',
  'CSRF_SECRET',
  'CAPABILITY_TOKEN_PEPPER',
  'PRIVACY_SUBJECT_HASH_SECRET',
  'ORDER_SIGNER_MODE',
  'ORDER_SIGNER_KMS_KEY_ID',
  'ORDER_SIGNER_ADDRESS',
  'AWS_KMS_REGION',
  'VERCEL_AWS_ROLE_ARN',
  'PLATFORM_FEE_BPS',
  'INDEXER_DEPLOYMENT_BLOCK',
  'LIVE_ACCEPTANCE_PRODUCT_ID',
  'LIVE_ACCEPTANCE_AUTH_METHOD',
  'LIVE_ACCEPTANCE_SOURCE_CHAIN_ID',
  'LIVE_ACCEPTANCE_MAX_USDC_BASE_UNITS',
  'LIVE_ACCEPTANCE_ATTESTATION_SECRET',
  'LIVE_ACCEPTANCE_RELEASE_ID',
] as const;

const placeholderPattern = /(?:REPLACE(?:_ME|_WITH)?|CHANGE_ME|EXAMPLE_ONLY)/i;
const zeroAddressPattern = /^0x0{40}$/i;
const RawEnvironmentSchema = z.record(z.string(), z.string().optional());

export type LiveAcceptanceGate =
  | {
      readonly status: 'EXTERNAL_BLOCKER';
      readonly missing: readonly string[];
      readonly reason: string;
      readonly continuationCommand: string;
    }
  | {
      readonly status: 'AUTHORIZED';
      readonly sourceChainId: ChainId;
      readonly maxUsdcBaseUnits: bigint;
      readonly confirmationDepth: bigint;
    };

function configured(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && !placeholderPattern.test(value);
}

function hasRecordedSourceCallProfile(value: string | undefined): boolean {
  if (!configured(value)) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function independentHttpsEndpoints(primary: string, fallback: string): boolean {
  try {
    const left = new URL(primary);
    const right = new URL(fallback);
    return (
      left.protocol === 'https:' &&
      right.protocol === 'https:' &&
      !left.username &&
      !left.password &&
      !right.username &&
      !right.password &&
      left.hostname.toLowerCase() !== right.hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function assessLiveAcceptanceGate(
  environmentInput: Record<string, string | undefined>,
): LiveAcceptanceGate {
  const environment = RawEnvironmentSchema.parse(environmentInput);
  const missing: string[] = REQUIRED_LIVE_ENVIRONMENT.filter(
    (name) => !configured(environment[name]),
  );
  const requireExact = (name: string, expected: string) => {
    if (environment[name] !== expected) missing.push(`${name}=${expected}`);
  };
  requireExact('APP_ENV', 'demo-mainnet');
  requireExact('NEXT_PUBLIC_APP_ENV', 'demo-mainnet');
  requireExact('PROVIDER_MODE', 'live');
  requireExact('PAYMENTS_ENABLED', 'true');
  requireExact('PARTICLE_LIVE_ENABLED', 'true');
  requireExact('PARTICLE_RESPONSE_PROFILE_PROVENANCE', 'recorded_live');
  requireExact('ORDER_SIGNER_MODE', 'kms');
  requireExact('RUN_TINY_LIVE_TESTS', 'true');
  requireExact('LIVE_TRANSACTION_CONFIRMATION', LIVE_TRANSACTION_CONFIRMATION);

  if (!hasRecordedSourceCallProfile(environment.PARTICLE_SOURCE_CALL_PROFILES_JSON)) {
    missing.push('PARTICLE_SOURCE_CALL_PROFILES_JSON=reviewed nonempty JSON array');
  }

  if (
    configured(environment.NEXT_PUBLIC_APP_ORIGIN) &&
    !environment.NEXT_PUBLIC_APP_ORIGIN.startsWith('https://')
  ) {
    missing.push('NEXT_PUBLIC_APP_ORIGIN=https://…');
  }
  if (
    configured(environment.ARBITRUM_RPC_URL) &&
    configured(environment.ARBITRUM_FALLBACK_RPC_URL) &&
    !independentHttpsEndpoints(environment.ARBITRUM_RPC_URL, environment.ARBITRUM_FALLBACK_RPC_URL)
  ) {
    missing.push('ARBITRUM_RPC_URL+ARBITRUM_FALLBACK_RPC_URL=independent HTTPS providers');
  }
  for (const name of [
    'PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS',
    'NEXT_PUBLIC_USDC_ADDRESS',
    'NEXT_PUBLIC_CHECKOUT_ADDRESS',
    'NEXT_PUBLIC_PASS_ADDRESS',
    'ORDER_SIGNER_ADDRESS',
  ]) {
    if (configured(environment[name]) && zeroAddressPattern.test(environment[name])) {
      missing.push(`${name}=nonzero address`);
    }
  }

  try {
    ProductIdSchema.parse(environment.LIVE_ACCEPTANCE_PRODUCT_ID);
  } catch {
    missing.push('LIVE_ACCEPTANCE_PRODUCT_ID=valid published product ID');
  }
  if (!['google', 'email_otp'].includes(environment.LIVE_ACCEPTANCE_AUTH_METHOD ?? '')) {
    missing.push('LIVE_ACCEPTANCE_AUTH_METHOD=google|email_otp');
  } else if (
    environment.LIVE_ACCEPTANCE_AUTH_METHOD === 'email_otp' &&
    !configured(environment.LIVE_ACCEPTANCE_EMAIL)
  ) {
    missing.push('LIVE_ACCEPTANCE_EMAIL=disposable Magic login email');
  }
  if (!/^[0-9a-fA-F]{40}$/.test(environment.LIVE_ACCEPTANCE_RELEASE_ID ?? '')) {
    missing.push('LIVE_ACCEPTANCE_RELEASE_ID=exact 40-hex deployed Git commit');
  }
  try {
    if (BigInt(environment.INDEXER_DEPLOYMENT_BLOCK ?? '0') <= 0n) {
      throw new Error('deployment block must be positive');
    }
  } catch {
    missing.push('INDEXER_DEPLOYMENT_BLOCK=positive deployment block');
  }

  let sourceChainId: ChainId | undefined;
  try {
    sourceChainId = ChainIdSchema.parse(environment.LIVE_ACCEPTANCE_SOURCE_CHAIN_ID);
    if (sourceChainId === ARBITRUM_ONE_CHAIN_ID) {
      missing.push('LIVE_ACCEPTANCE_SOURCE_CHAIN_ID=non-Arbitrum supported chain');
    }
  } catch {
    missing.push('LIVE_ACCEPTANCE_SOURCE_CHAIN_ID=valid non-Arbitrum chain ID');
  }

  let maxUsdcBaseUnits: bigint | undefined;
  try {
    maxUsdcBaseUnits = BigInt(
      BaseUnitAmountSchema.parse(environment.LIVE_ACCEPTANCE_MAX_USDC_BASE_UNITS),
    );
    if (maxUsdcBaseUnits <= 0n || maxUsdcBaseUnits > MAX_LIVE_ACCEPTANCE_USDC_BASE_UNITS) {
      missing.push('LIVE_ACCEPTANCE_MAX_USDC_BASE_UNITS=1..1000000');
    }
  } catch {
    missing.push('LIVE_ACCEPTANCE_MAX_USDC_BASE_UNITS=1..1000000');
  }

  let confirmationDepth: bigint | undefined;
  try {
    confirmationDepth = BigInt(environment.CONFIRMATION_DEPTH ?? '2');
    if (confirmationDepth < 1n || confirmationDepth > 100n) throw new Error('out of range');
  } catch {
    missing.push('CONFIRMATION_DEPTH=1..100');
  }

  if (
    missing.length > 0 ||
    sourceChainId === undefined ||
    maxUsdcBaseUnits === undefined ||
    confirmationDepth === undefined
  ) {
    return {
      status: 'EXTERNAL_BLOCKER',
      missing: [...new Set(missing)].sort(),
      reason:
        'Live acceptance remains disabled until credentials, funded disposable accounts, recorded provider schemas, deployment data, and explicit spend consent are present.',
      continuationCommand:
        'RUN_TINY_LIVE_TESTS=true LIVE_TRANSACTION_CONFIRMATION=I_ACKNOWLEDGE_TINY_ARBITRUM_MAINNET_SPEND LIVE_ACCEPTANCE_AUTH_METHOD=google pnpm --filter @opentab/cross-chain-checkout-spike test:live',
    };
  }
  return { status: 'AUTHORIZED', sourceChainId, maxUsdcBaseUnits, confirmationDepth };
}

const MagicIdentitySchema = z.object({
  ownerAddress: EvmAddressSchema,
  serverVerifiedAddress: EvmAddressSchema,
  authMethod: z.enum(['google', 'email_otp']),
  restored: z.boolean(),
  evidenceDigest: EvidenceDigestSchema,
});
const ReadinessSchema = z.object({
  ownerAddress: EvmAddressSchema,
  chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
  delegated: z.boolean(),
  expectedImplementation: EvmAddressSchema,
  implementationCodeHash: EvidenceDigestSchema,
  activationPath: LiveAcceptanceActivationPathSchema,
});
const DelegationActivationSchema = z.object({
  ownerAddress: EvmAddressSchema,
  transactionHash: TransactionHashSchema,
  sponsorGrantTransactionHash: TransactionHashSchema.optional(),
});
const VerifiedDelegationSchema = z.object({
  ownerAddress: EvmAddressSchema,
  delegated: z.literal(true),
  implementationAddress: EvmAddressSchema,
  implementationCodeHash: EvidenceDigestSchema,
  transactionHash: TransactionHashSchema.optional(),
});
const ParticleAccountSchema = z.object({
  ownerAddress: EvmAddressSchema,
  evmAddress: EvmAddressSchema,
  useEIP7702: z.literal(true),
  protocolVersion: z.string().min(1).max(40),
  safeAccountIdentifiers: z.array(z.string().min(1).max(128)).max(5),
});
const BalanceProofSchema = z.object({
  arbitrumUsdcBaseUnitsBefore: BaseUnitAmountSchema,
  sources: z
    .array(
      z.object({
        chainId: ChainIdSchema,
        symbol: z.string().min(1).max(20),
        rawAmount: BaseUnitAmountSchema,
        amountUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
      }),
    )
    .min(1),
  evidenceDigest: EvidenceDigestSchema,
});
const CheckoutProofSchema = z.object({
  orderId: z.string().min(8).max(80),
  attemptId: z.string().min(8).max(80),
  orderKey: OrderKeySchema,
  ownerAddress: EvmAddressSchema,
  recipientAddress: EvmAddressSchema,
  checkoutAddress: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  merchantOnchainId: z.string().regex(/^[1-9][0-9]*$/),
  productOnchainId: z.string().regex(/^[1-9][0-9]*$/),
  amountBaseUnits: BaseUnitAmountSchema,
  platformFeeBaseUnits: BaseUnitAmountSchema,
  quantity: z.string().regex(/^[1-9][0-9]*$/),
  intentDigest: EvidenceDigestSchema,
  refundDeadline: z.string().regex(/^(0|[1-9][0-9]*)$/),
  bindingDigest: EvidenceDigestSchema,
});
const PreparedProofSchema = z.object({
  providerOperationId: ProviderOperationIdSchema,
  ownerAddress: EvmAddressSchema,
  chainId: z.literal(ARBITRUM_ONE_CHAIN_ID),
  checkoutAddress: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  amountBaseUnits: BaseUnitAmountSchema,
  rootHash: EvidenceDigestSchema,
  exactCallTemplateVerified: z.literal(true),
  sources: z
    .array(
      z.object({
        chainId: ChainIdSchema,
        symbol: z.enum(['USDC', 'USDT', 'ETH']),
        amount: z.string().min(1).max(100),
        amountUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
      }),
    )
    .min(1)
    .max(20),
  totalUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  estimatedFeeUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  slippageBps: z.string().regex(/^(0|[1-9][0-9]*)$/),
  quotedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  previewDigest: EvidenceDigestSchema,
  preparedEvidenceDigest: EvidenceDigestSchema,
  activityUrl: z.string().url().optional(),
});
const RootSignatureProofSchema = z.object({
  recoveredOwner: EvmAddressSchema,
  signatureDigest: EvidenceDigestSchema,
});
const SubmissionSchema = z.object({
  providerOperationId: ProviderOperationIdSchema,
  status: z.enum(['preparing', 'moving_funds', 'executing', 'succeeded', 'unknown']),
  activityUrl: z.string().url().optional(),
});
const FinalProviderOperationSchema = ProviderOperationSchema.extend({
  status: z.literal('succeeded'),
  submissionPossible: z.literal(true),
  destinationTransactionHash: TransactionHashSchema,
}).strict();
const CanonicalPaymentSchema = z.object({
  providerOperationId: ProviderOperationIdSchema,
  event: CanonicalEventProofSchema,
  receiptId: ReceiptIdSchema,
  passTokenId: z.string().regex(/^[1-9][0-9]*$/),
});
const RecoverySchema = z.object({
  providerOperationId: ProviderOperationIdSchema,
  finalOrderStatus: z.literal('paid'),
  sponsorGrantCount: z.number().int().min(0).max(1),
  delegationCount: z.number().int().min(0).max(1),
  orderCount: z.literal(1),
  paymentAttemptCount: z.literal(1),
  providerOperationCount: z.literal(1),
  submissionCount: z.literal(1),
  receiptCount: z.literal(1),
});

export { LiveAcceptanceArtifactSchema };

export interface LiveAcceptanceDependencies {
  readonly acceptanceStartedAt?: string;
  readonly acceptanceDeploymentConfigDigest?: EvidenceDigest;
  authenticateAndExchangeMagicProof(): Promise<unknown>;
  signMagicAddressChallenge(ownerAddress: EvmAddress): Promise<unknown>;
  inspectEip7702Readiness(ownerAddress: EvmAddress): Promise<unknown>;
  activateDelegation(readiness: z.infer<typeof ReadinessSchema>): Promise<unknown>;
  verifyDelegationOnchain(input: {
    ownerAddress: EvmAddress;
    transactionHash?: TransactionHash;
  }): Promise<unknown>;
  initializeParticleEip7702(ownerAddress: EvmAddress): Promise<unknown>;
  readPreflightBalances(input: {
    ownerAddress: EvmAddress;
    sourceChainId: ChainId;
  }): Promise<unknown>;
  assertDelegatedPassReceiver(ownerAddress: EvmAddress): Promise<void>;
  createServerBoundCheckout(ownerAddress: EvmAddress): Promise<unknown>;
  prepareAndValidateParticleOperation(
    checkout: z.infer<typeof CheckoutProofSchema>,
  ): Promise<unknown>;
  signParticleRoot(input: { ownerAddress: EvmAddress; rootHash: EvidenceDigest }): Promise<unknown>;
  persistProviderOperationBeforeSubmission(input: {
    providerOperationId: ProviderOperationId;
    orderId: string;
    attemptId: string;
    evidenceDigest: EvidenceDigest;
  }): Promise<void>;
  submitParticleOperationOnce(input: {
    providerOperationId: ProviderOperationId;
    signatureDigest: EvidenceDigest;
  }): Promise<unknown>;
  awaitCanonicalArbitrumPayment(input: {
    providerOperationId: ProviderOperationId;
    orderKey: OrderKey;
    minimumConfirmations: string;
  }): Promise<unknown>;
  readFinalProviderOperation(providerOperationId: ProviderOperationId): Promise<unknown>;
  reloadAndReconcile(
    providerOperationId: ProviderOperationId,
    finalProviderOperation: z.infer<typeof FinalProviderOperationSchema>,
  ): Promise<unknown>;
  persistSanitizedEvidence(evidence: LiveAcceptanceEvidence): Promise<void>;
}

export type LiveAcceptanceEvidence = LiveAcceptanceArtifact;

function assertSameOwner(expected: EvmAddress, actual: EvmAddress, stage: string): void {
  if (!sameEvmAddress(expected, actual)) {
    throw new AppError('WALLET_ADDRESS_MISMATCH', `Wallet continuity failed at ${stage}.`);
  }
}

function externalStageError(stage: string): AppError {
  return new AppError('INTERNAL_ERROR', `Live acceptance failed during ${stage}.`, {
    safeDetails: { stage },
  });
}

export async function runLiveAcceptance(
  environment: Record<string, string | undefined>,
  dependencies: LiveAcceptanceDependencies,
): Promise<LiveAcceptanceGate | LiveAcceptanceEvidence> {
  const gate = assessLiveAcceptanceGate(environment);
  if (gate.status === 'EXTERNAL_BLOCKER') return gate;
  const acceptanceEnvironment = z.enum(['demo-mainnet', 'production']).parse(environment.APP_ENV);
  const acceptanceReleaseId = z
    .string()
    .regex(/^[0-9a-fA-F]{40}$/)
    .parse(environment.LIVE_ACCEPTANCE_RELEASE_ID);
  const acceptanceDeploymentConfigDigest = EvidenceDigestSchema.parse(
    dependencies.acceptanceDeploymentConfigDigest ??
      environment.LIVE_ACCEPTANCE_DEPLOYMENT_CONFIG_DIGEST,
  );
  const startedAt = new Date(dependencies.acceptanceStartedAt ?? Date.now());
  if (Number.isNaN(startedAt.getTime())) {
    throw new AppError('CONFIGURATION_INVALID', 'Live acceptance start time is invalid.');
  }

  const timingMs: Record<string, number> = {};
  const step = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw externalStageError(name);
    } finally {
      timingMs[name] = Math.max(0, Math.round(performance.now() - started));
    }
  };

  const identity = MagicIdentitySchema.parse(
    await step('magicAuthentication', () => dependencies.authenticateAndExchangeMagicProof()),
  );
  assertSameOwner(identity.ownerAddress, identity.serverVerifiedAddress, 'Magic proof exchange');
  const challenge = z
    .object({ recoveredOwner: EvmAddressSchema, evidenceDigest: EvidenceDigestSchema })
    .parse(
      await step('magicChallenge', () =>
        dependencies.signMagicAddressChallenge(identity.ownerAddress),
      ),
    );
  assertSameOwner(identity.ownerAddress, challenge.recoveredOwner, 'Magic challenge');

  const readiness = ReadinessSchema.parse(
    await step('readiness', () => dependencies.inspectEip7702Readiness(identity.ownerAddress)),
  );
  assertSameOwner(identity.ownerAddress, readiness.ownerAddress, 'readiness');
  let activation: z.infer<typeof DelegationActivationSchema> | undefined;
  if (!readiness.delegated) {
    activation = DelegationActivationSchema.parse(
      await step('delegationActivation', () => dependencies.activateDelegation(readiness)),
    );
    assertSameOwner(identity.ownerAddress, activation.ownerAddress, 'delegation activation');
  }
  const verifiedDelegation = VerifiedDelegationSchema.parse(
    await step('delegationVerification', () =>
      dependencies.verifyDelegationOnchain({
        ownerAddress: identity.ownerAddress,
        ...(activation?.transactionHash === undefined
          ? {}
          : { transactionHash: activation.transactionHash }),
      }),
    ),
  );
  assertSameOwner(
    identity.ownerAddress,
    verifiedDelegation.ownerAddress,
    'delegation verification',
  );
  if (
    !sameEvmAddress(verifiedDelegation.implementationAddress, readiness.expectedImplementation) ||
    verifiedDelegation.implementationCodeHash !== readiness.implementationCodeHash
  ) {
    throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Onchain delegation evidence is unexpected.');
  }

  const particleAccount = ParticleAccountSchema.parse(
    await step('particleInitialization', () =>
      dependencies.initializeParticleEip7702(identity.ownerAddress),
    ),
  );
  assertSameOwner(identity.ownerAddress, particleAccount.ownerAddress, 'Particle owner');
  assertSameOwner(identity.ownerAddress, particleAccount.evmAddress, 'Particle account');
  const balance = BalanceProofSchema.parse(
    await step('balancePreflight', () =>
      dependencies.readPreflightBalances({
        ownerAddress: identity.ownerAddress,
        sourceChainId: gate.sourceChainId,
      }),
    ),
  );
  if (
    !balance.sources.some(
      (source) => source.chainId === gate.sourceChainId && BigInt(source.rawAmount) > 0n,
    )
  ) {
    throw new AppError('UA_INSUFFICIENT_BALANCE', 'No non-Arbitrum source value was evidenced.');
  }
  await step('passReceiverCompatibility', () =>
    dependencies.assertDelegatedPassReceiver(identity.ownerAddress),
  );

  const checkout = CheckoutProofSchema.parse(
    await step('checkoutBinding', () =>
      dependencies.createServerBoundCheckout(identity.ownerAddress),
    ),
  );
  assertSameOwner(identity.ownerAddress, checkout.ownerAddress, 'checkout binding');
  const checkoutAmount = BigInt(checkout.amountBaseUnits);
  if (checkoutAmount <= 0n || checkoutAmount > gate.maxUsdcBaseUnits) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'Checkout amount exceeds explicit live-test consent.',
    );
  }
  if (BigInt(balance.arbitrumUsdcBaseUnitsBefore) >= checkoutAmount) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'The account already had sufficient Arbitrum checkout liquidity.',
    );
  }

  const prepared = PreparedProofSchema.parse(
    await step('particlePreview', () => dependencies.prepareAndValidateParticleOperation(checkout)),
  );
  assertSameOwner(identity.ownerAddress, prepared.ownerAddress, 'Particle preview');
  if (
    !sameEvmAddress(prepared.checkoutAddress, checkout.checkoutAddress) ||
    !sameEvmAddress(prepared.tokenAddress, checkout.tokenAddress) ||
    prepared.amountBaseUnits !== checkout.amountBaseUnits ||
    !prepared.sources.some((source) => source.chainId === gate.sourceChainId) ||
    new Date(prepared.expiresAt).getTime() <= Date.now()
  ) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'Particle preview does not match live checkout consent.',
    );
  }
  const signature = RootSignatureProofSchema.parse(
    await step('magicRootSignature', () =>
      dependencies.signParticleRoot({
        ownerAddress: identity.ownerAddress,
        rootHash: prepared.rootHash,
      }),
    ),
  );
  assertSameOwner(identity.ownerAddress, signature.recoveredOwner, 'Particle root signature');

  await step('operationPersistence', () =>
    dependencies.persistProviderOperationBeforeSubmission({
      providerOperationId: prepared.providerOperationId,
      orderId: checkout.orderId,
      attemptId: checkout.attemptId,
      evidenceDigest: prepared.preparedEvidenceDigest,
    }),
  );
  const submitted = SubmissionSchema.parse(
    await step('particleSubmission', () =>
      dependencies.submitParticleOperationOnce({
        providerOperationId: prepared.providerOperationId,
        signatureDigest: signature.signatureDigest,
      }),
    ),
  );
  if (submitted.providerOperationId !== prepared.providerOperationId) {
    throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle submission ID changed.');
  }

  const payment = CanonicalPaymentSchema.parse(
    await step('canonicalArbitrumPayment', () =>
      dependencies.awaitCanonicalArbitrumPayment({
        providerOperationId: prepared.providerOperationId,
        orderKey: checkout.orderKey,
        minimumConfirmations: gate.confirmationDepth.toString(),
      }),
    ),
  );
  if (payment.providerOperationId !== prepared.providerOperationId) {
    throw new AppError('PAYMENT_EVENT_MISMATCH', 'Payment operation linkage is invalid.');
  }
  if (payment.event.eventName !== 'OrderPaid') {
    throw new AppError('PAYMENT_EVENT_MISMATCH', 'Expected OrderPaid evidence was not found.');
  }
  const fields = payment.event.fields;
  if (
    payment.event.chainId !== ARBITRUM_ONE_CHAIN_ID ||
    !payment.event.canonical ||
    BigInt(payment.event.confirmations) < gate.confirmationDepth ||
    !sameEvmAddress(payment.event.contractAddress, checkout.checkoutAddress) ||
    fields.orderKey !== checkout.orderKey ||
    fields.merchantOnchainId !== checkout.merchantOnchainId ||
    fields.productOnchainId !== checkout.productOnchainId ||
    !sameEvmAddress(fields.payer, identity.ownerAddress) ||
    !sameEvmAddress(fields.recipient, checkout.recipientAddress) ||
    !sameEvmAddress(fields.token, checkout.tokenAddress) ||
    fields.amountBaseUnits !== checkout.amountBaseUnits ||
    fields.platformFeeBaseUnits !== checkout.platformFeeBaseUnits ||
    fields.quantity !== checkout.quantity ||
    fields.intentDigest !== checkout.intentDigest ||
    fields.refundDeadline !== checkout.refundDeadline ||
    fields.passTokenId !== payment.passTokenId
  ) {
    throw new AppError('PAYMENT_EVENT_MISMATCH', 'Canonical Arbitrum payment fields do not match.');
  }

  const finalProviderOperation = FinalProviderOperationSchema.parse(
    await step('particleFinalObservation', () =>
      dependencies.readFinalProviderOperation(prepared.providerOperationId),
    ),
  );
  if (
    finalProviderOperation.id !== prepared.providerOperationId ||
    finalProviderOperation.destinationTransactionHash.toLowerCase() !==
      payment.event.transactionHash.toLowerCase()
  ) {
    throw new AppError(
      'PAYMENT_EVENT_MISMATCH',
      'The final Particle operation does not link to the canonical Arbitrum payment.',
    );
  }
  for (const earlierActivityUrl of [submitted.activityUrl, prepared.activityUrl]) {
    if (
      earlierActivityUrl !== undefined &&
      finalProviderOperation.activityUrl !== undefined &&
      earlierActivityUrl !== finalProviderOperation.activityUrl
    ) {
      throw new AppError(
        'UA_PROVIDER_SCHEMA_INVALID',
        'Particle changed the public operation activity URL.',
      );
    }
  }

  const recoverySnapshot = RecoverySchema.parse(
    await step('restartRecovery', () =>
      dependencies.reloadAndReconcile(prepared.providerOperationId, finalProviderOperation),
    ),
  );
  if (recoverySnapshot.providerOperationId !== prepared.providerOperationId) {
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Recovery loaded another provider operation.');
  }
  const recovery = {
    ...recoverySnapshot,
    browserReloadObserved: true as const,
    observedAt: new Date().toISOString(),
  };
  const activityUrl = finalProviderOperation.activityUrl;
  const capturedAt = new Date();
  const delegationTransactionHash = TransactionHashSchema.safeParse(
    activation?.transactionHash ?? verifiedDelegation.transactionHash,
  );
  if (!delegationTransactionHash.success) {
    throw new AppError(
      'UA_DELEGATION_REQUIRED',
      'Live acceptance requires a durable EIP-7702 delegation transaction hash.',
    );
  }

  const evidence = LiveAcceptanceArtifactSchema.parse({
    status: 'LIVE_ACCEPTANCE_EVIDENCED',
    schemaVersion: 1,
    environment: acceptanceEnvironment,
    releaseId: acceptanceReleaseId,
    deploymentConfigDigest: acceptanceDeploymentConfigDigest,
    orderId: checkout.orderId,
    paymentAttemptId: checkout.attemptId,
    startedAt: startedAt.toISOString(),
    capturedAt: capturedAt.toISOString(),
    ownerAddressBefore: identity.ownerAddress,
    ownerAddressAfter: particleAccount.evmAddress,
    authMethod: identity.authMethod,
    activationPath: readiness.activationPath,
    providerOperation: finalProviderOperation,
    delegationTransactionHash: delegationTransactionHash.data,
    ...(activation?.sponsorGrantTransactionHash === undefined
      ? {}
      : { sponsorGrantTransactionHash: activation.sponsorGrantTransactionHash }),
    particle: {
      protocolVersion: particleAccount.protocolVersion,
      useEIP7702: true,
      safeAccountIdentifiers: [particleAccount.evmAddress],
      providerOperationId: prepared.providerOperationId,
      ...(activityUrl === undefined ? {} : { activityUrl }),
      sources: prepared.sources,
      totalUsd: prepared.totalUsd,
      estimatedFeeUsd: prepared.estimatedFeeUsd,
      slippageBps: prepared.slippageBps,
      quotedAt: prepared.quotedAt,
      expiresAt: prepared.expiresAt,
      previewDigest: prepared.previewDigest,
    },
    arbitrum: {
      event: payment.event,
      receiptId: payment.receiptId,
      passTokenId: payment.passTokenId,
    },
    recovery,
    timingMs,
  });
  await step('evidencePersistence', () => dependencies.persistSanitizedEvidence(evidence));
  return evidence;
}

export const SPIKE_IMPLEMENTED = true as const;
