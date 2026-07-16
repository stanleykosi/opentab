import * as integrations from '@opentab/integrations/browser';
import {
  ARBITRUM_ONE_CHAIN_ID,
  type CheckoutBinding,
  EvidenceDigestSchema,
  type EvmAddress,
  EvmAddressSchema,
  type ProviderOperation,
  ProviderOperationIdSchema,
  ProviderOperationSchema,
  sameEvmAddress,
  ValidatedOperationPlanSchema,
} from '@opentab/shared';
import {
  BrowserApiClient,
  BrowserApiError,
} from '../../../apps/web/src/application/browser-api-client';
import { BrowserApplicationService } from '../../../apps/web/src/application/browser-application-service';

const api = new BrowserApiClient();
const application = new BrowserApplicationService({ api });
const idempotencyKeys = new Map<string, string>();
let wallet: ReturnType<typeof integrations.createMagicBrowserWallet> | undefined;
let binding: CheckoutBinding | undefined;
let plan: ReturnType<typeof ValidatedOperationPlanSchema.parse> | undefined;
let preparedOperationId: string | undefined;
let preparedEvidenceDigest: `0x${string}` | undefined;
let rootSignature: string | undefined;
let rootSignatureDigest: `0x${string}` | undefined;
let submittedOperation: ProviderOperation | undefined;
let sponsorGrantTransactionHash: string | undefined;
let expectedLiveTarget:
  | {
      readonly environment: 'demo-mainnet' | 'production';
      readonly applicationReleaseId: string;
      readonly liveAcceptanceConfigDigest: string;
    }
  | undefined;

function idempotencyKey(scope: string): string {
  const existing = idempotencyKeys.get(scope);
  if (existing !== undefined) return existing;
  const created = `live.${scope}.${crypto.randomUUID()}`;
  idempotencyKeys.set(scope, created);
  return created;
}

function assertOwner(expected: EvmAddress, actual: EvmAddress, stage: string): void {
  if (!sameEvmAddress(expected, actual)) {
    throw new Error(`WALLET_ADDRESS_MISMATCH:${stage}`);
  }
}

function decimalUsdToMicros(value: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) throw new Error('UA_PROVIDER_SCHEMA_INVALID:fee');
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(6, '0').slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString();
}

async function config() {
  const value = await api.getPublicConfig();
  if (
    !['demo-mainnet', 'production'].includes(value.environment) ||
    value.particle.responseProfile.provenance !== 'recorded_live' ||
    (expectedLiveTarget !== undefined &&
      (value.environment !== expectedLiveTarget.environment ||
        value.applicationReleaseId !== expectedLiveTarget.applicationReleaseId ||
        value.liveAcceptanceConfigDigest?.toLowerCase() !==
          expectedLiveTarget.liveAcceptanceConfigDigest.toLowerCase()))
  ) {
    throw new Error('CONFIGURATION_INVALID:live-browser-profile');
  }
  return value;
}

async function assertLiveTargetConfig(input: {
  environment: 'demo-mainnet' | 'production';
  applicationReleaseId: string;
  liveAcceptanceConfigDigest: string;
}) {
  expectedLiveTarget = {
    environment: input.environment,
    applicationReleaseId: input.applicationReleaseId,
    liveAcceptanceConfigDigest: EvidenceDigestSchema.parse(input.liveAcceptanceConfigDigest),
  };
  const value = await config();
  return {
    environment: value.environment,
    applicationReleaseId: value.applicationReleaseId,
    liveAcceptanceConfigDigest: value.liveAcceptanceConfigDigest,
  };
}

async function magicWallet() {
  if (wallet !== undefined) return wallet;
  const configuration = await config();
  wallet = integrations.createMagicBrowserWallet({
    publishableKey: configuration.magic.publishableKey,
    environment: configuration.environment,
    allowedRedirectUris: [`${location.origin}/auth/callback`],
    rpcNetworks: [{ chainId: 42_161, rpcUrl: configuration.magic.rpcUrl, default: true }],
  });
  return wallet;
}

function safeIdentity(
  session: Awaited<ReturnType<BrowserApiClient['restoreSession']>>,
  restored: boolean,
) {
  return {
    ownerAddress: session.user.walletAddress,
    serverVerifiedAddress: session.user.walletAddress,
    authMethod: session.user.authMethod,
    restored,
    evidenceDigest: integrations.digestUnknown({
      kind: 'magic-session-address-continuity',
      ownerAddress: session.user.walletAddress,
      authMethod: session.user.authMethod,
      restored,
    }),
  };
}

async function restoreIdentity() {
  try {
    const session = await api.restoreSession();
    const owner = await (await magicWallet()).getOwnerAddress();
    assertOwner(session.user.walletAddress, owner, 'session-restore');
    return safeIdentity(session, true);
  } catch (error) {
    if (error instanceof BrowserApiError && error.code === 'AUTH_REQUIRED') return undefined;
    throw error;
  }
}

async function refreshIdentityProof() {
  const restored = await api.restoreSession();
  const session = await application.refreshAuthenticatedMagicSession('/');
  assertOwner(restored.user.walletAddress, session.user.walletAddress, 'fresh-proof-exchange');
  return safeIdentity(session, true);
}

async function authenticateEmail(input: { email: string }) {
  const session = await application.signInWithEmail(input.email, '/');
  return safeIdentity(session, false);
}

async function beginGoogleAuthentication(): Promise<void> {
  await application.beginGoogleSignIn('/');
}

async function completeGoogleAuthentication() {
  const session = await application.completeGoogleSignIn();
  return safeIdentity(session, false);
}

async function signAddressChallenge(input: { ownerAddress: EvmAddress }) {
  const ownerAddress = EvmAddressSchema.parse(input.ownerAddress);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const rootHash = integrations.digestUnknown({
    kind: 'opentab-live-address-challenge-v1',
    ownerAddress,
    origin: location.origin,
  });
  const challengePlan = ValidatedOperationPlanSchema.parse({
    planId: integrations.digestUnknown({ rootHash, expiresAt }),
    template: {
      kind: 'product_mutation',
      ownerAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      calls: [{ to: ownerAddress, data: '0x', valueWei: '0' }],
      bindingDigest: integrations.digestUnknown({ ownerAddress, rootHash }),
      expiresAt,
    },
    rootHash,
    quote: {
      amountBaseUnits: '0',
      estimatedFeeUsd: '0',
      totalUsd: '0',
      slippageBps: '0',
      sources: [{ chainId: ARBITRUM_ONE_CHAIN_ID, symbol: 'USDC', amount: '0', amountUsd: '0' }],
      quotedAt: now.toISOString(),
      expiresAt,
    },
    validatedAt: now.toISOString(),
    expiresAt,
  });
  const signed = await (await magicWallet()).signValidatedRoot(challengePlan);
  assertOwner(ownerAddress, signed.recoveredOwner, 'address-challenge');
  return {
    recoveredOwner: signed.recoveredOwner,
    evidenceDigest: integrations.digestUnknown({
      kind: 'magic-address-challenge',
      signature: signed.signature,
    }),
  };
}

async function inspectReadiness(input: { ownerAddress: EvmAddress }) {
  const ownerAddress = EvmAddressSchema.parse(input.ownerAddress);
  const [configuration, readiness] = await Promise.all([
    config(),
    application.checkWalletReadiness(),
  ]);
  assertOwner(ownerAddress, readiness.ownerAddress, 'readiness');
  return {
    ownerAddress,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    delegated: readiness.delegation.delegated,
    expectedImplementation: configuration.particle.expectedImplementationAddress,
    implementationCodeHash: configuration.particle.expectedImplementationCodeHash,
    activationPath: readiness.delegation.delegated
      ? ('already_delegated' as const)
      : configuration.features.bootstrapGas
        ? ('bootstrap_sponsor' as const)
        : ('self_funded_type4' as const),
  };
}

async function activateDelegation(input: { ownerAddress: EvmAddress }) {
  const ownerAddress = EvmAddressSchema.parse(input.ownerAddress);
  const configuration = await config();
  await api.restoreSession();
  if (configuration.features.bootstrapGas) {
    const eligibility = await api.evaluateBootstrapEligibility(
      idempotencyKey(`sponsor-eligibility.${ownerAddress.toLowerCase()}`),
    );
    if (eligibility.eligible && BigInt(eligibility.deficitWei) > 0n) {
      let { grant } = await api.requestBootstrapGrant(
        idempotencyKey(`sponsor-grant.${ownerAddress.toLowerCase()}`),
      );
      for (
        let poll = 0;
        poll < 60 && !['confirmed', 'failed', 'replaced'].includes(grant.status);
        poll += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        ({ grant } = await api.getBootstrapGrant(grant.id));
      }
      if (grant.status !== 'confirmed' || grant.transactionHash === undefined) {
        throw new Error('SPONSOR_SUBMISSION_UNKNOWN');
      }
      sponsorGrantTransactionHash = grant.transactionHash;
    } else if (
      !eligibility.eligible &&
      !['already_prepared', 'sufficient_balance'].includes(eligibility.reason ?? '')
    ) {
      throw new Error('SPONSOR_INELIGIBLE');
    }
  }

  const account = await application.getUniversalAccount(ownerAddress);
  const activeWallet = await magicWallet();
  await activeWallet.switchToArbitrum();
  const before = await account.getDelegation();
  if (before.delegated) throw new Error('UA_DELEGATION_RACE');
  const delegationPlan = await account.prepareDelegation();
  const authorization = await activeWallet.authorizeDelegation(delegationPlan);
  const submission = await activeWallet.submitDelegation(delegationPlan, authorization);
  if (!submission.submissionPossible) throw new Error('WALLET_TYPE4_SUBMISSION_FAILED');
  await api.recordDelegationEvidence(
    { transactionHash: submission.transactionHash, evidenceDigest: delegationPlan.bindingDigest },
    idempotencyKey(`delegation-evidence.${ownerAddress.toLowerCase()}`),
  );
  return {
    ownerAddress,
    transactionHash: submission.transactionHash,
    ...(sponsorGrantTransactionHash === undefined ? {} : { sponsorGrantTransactionHash }),
  };
}

async function initializeParticle(input: { ownerAddress: EvmAddress }) {
  const ownerAddress = EvmAddressSchema.parse(input.ownerAddress);
  const account = await application.getUniversalAccount(ownerAddress);
  const identity = await account.getAccount();
  assertOwner(ownerAddress, identity.ownerAddress, 'particle-owner');
  assertOwner(ownerAddress, identity.evmAddress, 'particle-evm-account');
  return {
    ownerAddress: identity.ownerAddress,
    evmAddress: identity.evmAddress,
    useEIP7702: identity.eip7702,
    protocolVersion: identity.protocolVersion,
    safeAccountIdentifiers: [identity.evmAddress, identity.solanaAddress].filter(
      (value): value is string => value !== undefined,
    ),
  };
}

async function readBalances(input: {
  ownerAddress: EvmAddress;
  sourceChainId: string;
  usdcAddress: EvmAddress;
}) {
  EvmAddressSchema.parse(input.ownerAddress);
  const usdcAddress = EvmAddressSchema.parse(input.usdcAddress);
  const balance = await application.loadUnifiedBalance();
  let arbitrumUsdcBaseUnits = '0';
  const sources: Array<{ chainId: string; symbol: string; rawAmount: string; amountUsd: string }> =
    [];
  for (const asset of balance.assets) {
    for (const chain of asset.chains) {
      if (
        chain.chainId === ARBITRUM_ONE_CHAIN_ID &&
        chain.tokenAddress.toLowerCase() === usdcAddress.toLowerCase()
      ) {
        arbitrumUsdcBaseUnits = chain.rawAmount;
      }
      if (chain.chainId === input.sourceChainId && BigInt(chain.rawAmount) > 0n) {
        sources.push({
          chainId: chain.chainId,
          symbol: chain.symbol.toUpperCase(),
          rawAmount: chain.rawAmount,
          amountUsd: chain.amountUsd,
        });
      }
    }
  }
  return {
    arbitrumUsdcBaseUnitsBefore: arbitrumUsdcBaseUnits,
    sources,
    evidenceDigest: balance.evidence.evidenceDigest,
  };
}

function checkoutProof(current: CheckoutBinding) {
  return {
    orderId: current.orderId,
    attemptId: current.attemptId,
    orderKey: current.orderIntent.orderKey,
    ownerAddress: current.orderIntent.payer,
    recipientAddress: current.orderIntent.recipient,
    checkoutAddress: current.checkoutAddress,
    tokenAddress: current.usdcAddress,
    merchantOnchainId: current.orderIntent.merchantOnchainId,
    productOnchainId: current.orderIntent.productOnchainId,
    amountBaseUnits: current.orderIntent.amountBaseUnits,
    platformFeeBaseUnits: current.orderIntent.platformFeeBaseUnits,
    quantity: current.orderIntent.quantity,
    intentDigest: current.orderIntentDigest,
    refundDeadline: current.orderIntent.refundDeadline,
    bindingDigest: current.bindingDigest,
  };
}

async function createCheckout(input: { ownerAddress: EvmAddress; productId: string }) {
  const ownerAddress = EvmAddressSchema.parse(input.ownerAddress);
  await api.restoreSession();
  if (binding !== undefined) return checkoutProof(binding);
  const checkout = await api.createCheckoutSession(
    { productId: input.productId, quantity: '1' },
    idempotencyKey(`checkout-session.${input.productId}`),
  );
  await api.bindCheckoutSession(
    checkout.sessionId,
    idempotencyKey(`checkout-bind.${checkout.sessionId}`),
  );
  const created = await api.createPaymentAttempt(
    checkout.sessionId,
    idempotencyKey(`payment-attempt.${checkout.sessionId}`),
  );
  assertOwner(ownerAddress, created.binding.orderIntent.payer, 'checkout-binding');
  binding = created.binding;
  return checkoutProof(created.binding);
}

async function prepareOperation(input: { bindingDigest: `0x${string}` }) {
  if (binding === undefined || binding.bindingDigest !== input.bindingDigest) {
    throw new Error('OPERATION_PLAN_INVALID:checkout-state');
  }
  if (
    plan !== undefined &&
    preparedOperationId !== undefined &&
    preparedEvidenceDigest !== undefined
  ) {
    return preparedProof();
  }
  const account = await application.getUniversalAccount(binding.orderIntent.payer);
  const template = integrations.createCheckoutOperationTemplate(binding);
  const prepared = await account.prepareOperation(template);
  if (prepared.providerOperationId === undefined)
    throw new Error('UA_PROVIDER_SCHEMA_INVALID:operation-id');
  plan = await account.validateOperation({ template, prepared });
  preparedOperationId = prepared.providerOperationId;
  preparedEvidenceDigest = integrations.digestUnknown({
    providerOperationId: prepared.providerOperationId,
    redactedPayloadDigest: prepared.redactedPayloadDigest,
    planId: plan.planId,
  });
  return preparedProof();
}

function preparedProof() {
  if (
    binding === undefined ||
    plan === undefined ||
    preparedOperationId === undefined ||
    preparedEvidenceDigest === undefined
  ) {
    throw new Error('OPERATION_PLAN_INVALID:missing-preview');
  }
  const sources = plan.quote.sources.map((source) => {
    const symbol = source.symbol.toUpperCase();
    if (!['USDC', 'USDT', 'ETH'].includes(symbol)) throw new Error('UA_ASSET_UNSUPPORTED');
    return {
      chainId: source.chainId,
      symbol: symbol as 'USDC' | 'USDT' | 'ETH',
      amount: source.amount,
      amountUsd: source.amountUsd,
    };
  });
  return {
    providerOperationId: preparedOperationId,
    ownerAddress: binding.orderIntent.payer,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    checkoutAddress: binding.checkoutAddress,
    tokenAddress: binding.usdcAddress,
    amountBaseUnits: binding.orderIntent.amountBaseUnits,
    rootHash: plan.rootHash,
    exactCallTemplateVerified: true as const,
    sources,
    totalUsd: plan.quote.totalUsd,
    estimatedFeeUsd: plan.quote.estimatedFeeUsd,
    slippageBps: plan.quote.slippageBps,
    quotedAt: plan.quote.quotedAt,
    expiresAt: plan.expiresAt,
    previewDigest: integrations.digestUnknown(plan.quote),
    preparedEvidenceDigest,
  };
}

async function signRoot(input: { ownerAddress: EvmAddress; rootHash: `0x${string}` }) {
  if (binding === undefined || plan === undefined || plan.rootHash !== input.rootHash) {
    throw new Error('OPERATION_PLAN_INVALID:root-hash');
  }
  const signed = await (await magicWallet()).signValidatedRoot(plan);
  assertOwner(input.ownerAddress, signed.recoveredOwner, 'payment-root-signature');
  rootSignature = signed.signature;
  rootSignatureDigest = integrations.digestUnknown({
    kind: 'particle-root-signature',
    signature: signed.signature,
    rootHash: input.rootHash,
  });
  return { recoveredOwner: signed.recoveredOwner, signatureDigest: rootSignatureDigest };
}

async function persistOperation(input: {
  providerOperationId: string;
  orderId: string;
  attemptId: string;
  evidenceDigest: `0x${string}`;
}) {
  if (
    binding === undefined ||
    plan === undefined ||
    input.providerOperationId !== preparedOperationId ||
    input.orderId !== binding.orderId ||
    input.attemptId !== binding.attemptId ||
    input.evidenceDigest !== preparedEvidenceDigest
  ) {
    throw new Error('OPERATION_PLAN_INVALID:persistence-binding');
  }
  await api.recordPreparedPayment(
    binding.attemptId,
    {
      providerOperationId: input.providerOperationId,
      rootHashDigest: integrations.digestUnknown(plan.rootHash),
      previewDigest: integrations.digestUnknown(plan.quote),
      expiresAt: plan.expiresAt,
      quoteSummary: {
        sourceAmountBaseUnits: plan.quote.amountBaseUnits,
        destinationAmountBaseUnits: binding.orderIntent.amountBaseUnits,
        feeBaseUnits: decimalUsdToMicros(plan.quote.estimatedFeeUsd),
        routeLabel: 'Particle Universal Account to Arbitrum One',
      },
    },
    idempotencyKey(`payment-prepared.${binding.attemptId}`),
  );
}

async function submitOperation(input: {
  providerOperationId: string;
  signatureDigest: `0x${string}`;
}) {
  if (
    binding === undefined ||
    plan === undefined ||
    rootSignature === undefined ||
    rootSignatureDigest === undefined ||
    input.providerOperationId !== preparedOperationId ||
    input.signatureDigest !== rootSignatureDigest
  ) {
    throw new Error('OPERATION_PLAN_INVALID:submission-binding');
  }
  if (submittedOperation !== undefined) {
    return {
      providerOperationId: submittedOperation.id,
      status: submittedOperation.status,
      ...(submittedOperation.activityUrl === undefined
        ? {}
        : { activityUrl: submittedOperation.activityUrl }),
    };
  }
  const started = await api.startPaymentSubmission(
    binding.attemptId,
    binding.bindingDigest,
    idempotencyKey(`payment-start.${binding.attemptId}`),
  );
  if (started.attempt.status !== 'submission_started') {
    throw new Error('PAYMENT_ALREADY_SUBMITTED');
  }
  const account = await application.getUniversalAccount(binding.orderIntent.payer);
  try {
    submittedOperation = await account.submitValidated({ plan, rootSignature });
    await api.registerPaymentSubmission(
      binding.attemptId,
      { status: 'submitted', providerOperationId: preparedOperationId },
      idempotencyKey(`payment-submitted.${binding.attemptId}`),
    );
  } catch {
    await api.registerPaymentSubmission(
      binding.attemptId,
      { status: 'submitted_unknown' },
      idempotencyKey(`payment-unknown.${binding.attemptId}`),
    );
    rootSignature = undefined;
    return { providerOperationId: preparedOperationId, status: 'unknown' as const };
  }
  rootSignature = undefined;
  return {
    providerOperationId: submittedOperation.id,
    status: submittedOperation.status,
    ...(submittedOperation.activityUrl === undefined
      ? {}
      : { activityUrl: submittedOperation.activityUrl }),
  };
}

async function getProviderOperation(input: { providerOperationId: string }) {
  if (binding === undefined) throw new Error('OPERATION_PLAN_INVALID:checkout-state');
  const providerOperationId = ProviderOperationIdSchema.parse(input.providerOperationId);
  if (preparedOperationId !== providerOperationId) {
    throw new Error('OPERATION_PLAN_INVALID:operation-id');
  }
  const account = await application.getUniversalAccount(binding.orderIntent.payer);
  return ProviderOperationSchema.parse(await account.getOperation(providerOperationId));
}

async function getProviderOperationForRecovery(input: {
  ownerAddress: EvmAddress;
  providerOperationId: string;
}) {
  const ownerAddress = EvmAddressSchema.parse(input.ownerAddress);
  const providerOperationId = ProviderOperationIdSchema.parse(input.providerOperationId);
  const session = await api.restoreSession();
  assertOwner(ownerAddress, session.user.walletAddress, 'recovery-session-owner');
  const account = await application.getUniversalAccount(ownerAddress);
  return ProviderOperationSchema.parse(await account.getOperation(providerOperationId));
}

async function getRecovery(input: { paymentAttemptId: string }) {
  await api.restoreSession();
  return api.getPaymentRecovery(input.paymentAttemptId);
}

export const openTabLiveAcceptanceBridge = {
  assertLiveTargetConfig,
  restoreIdentity,
  refreshIdentityProof,
  authenticateEmail,
  beginGoogleAuthentication,
  completeGoogleAuthentication,
  signAddressChallenge,
  inspectReadiness,
  activateDelegation,
  initializeParticle,
  readBalances,
  createCheckout,
  prepareOperation,
  signRoot,
  persistOperation,
  submitOperation,
  getProviderOperation,
  getProviderOperationForRecovery,
  getRecovery,
};

Object.defineProperty(globalThis, '__openTabLiveAcceptanceBridge', {
  value: openTabLiveAcceptanceBridge,
  configurable: true,
  enumerable: false,
  writable: false,
});

Object.defineProperty(globalThis, '__openTabLiveAcceptanceReady', {
  value: true,
  configurable: true,
  enumerable: false,
  writable: false,
});
