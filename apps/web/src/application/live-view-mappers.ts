import type { PublicJudgeProof, UnifiedBalance, ValidatedOperationPlan } from '@opentab/shared';
import type {
  CheckoutSnapshotView,
  CheckoutState,
  JudgeProofView,
  ProductAvailability,
  ProductView,
  QuoteView,
} from '../client/view-models';
import type { CheckoutSnapshotResponse, PaymentWorkflowResponse } from './browser-api-client';
import type { PublicProductRecord } from './public-session-api-client';

function productAvailability(record: PublicProductRecord): ProductAvailability {
  const { product } = record;
  const remaining =
    product.maxSupply === undefined
      ? undefined
      : (BigInt(product.maxSupply) - BigInt(product.sold)).toString();
  if (product.status === 'active') {
    if (remaining !== undefined && BigInt(remaining) <= 0n) return { state: 'sold_out' };
    return { state: 'available', ...(remaining === undefined ? {} : { remaining }) };
  }
  if (product.status === 'scheduled' || product.status === 'publishing') {
    return { state: 'scheduled', startsAt: product.startsAt };
  }
  if (product.status === 'sold_out') return { state: 'sold_out' };
  if (product.status === 'paused' || product.status === 'draft') return { state: 'paused' };
  return { state: 'ended' };
}

function monogram(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('');
}

function approvedImagePath(
  value: string | undefined,
  origin: string,
  allowedMediaOrigins: readonly string[],
): string {
  if (value === undefined) return '/images/offer-fallback.svg';
  try {
    const url = new URL(value);
    if (url.origin === origin) return `${url.pathname}${url.search}`;
    return allowedMediaOrigins.includes(url.origin) ? url.href : '/images/offer-fallback.svg';
  } catch {
    return '/images/offer-fallback.svg';
  }
}

function refundTerms(secondsValue: string): string {
  const seconds = BigInt(secondsValue);
  if (seconds === 0n) return 'This offer is non-refundable after payment is confirmed.';
  const days = (seconds + 86_399n) / 86_400n;
  return `Refund requests are accepted for ${days} ${days === 1n ? 'day' : 'days'} after the payment window closes, subject to the merchant policy.`;
}

export function mapPublicProductToView(
  record: PublicProductRecord,
  options: { origin: string; allowedMediaOrigins?: readonly string[] },
): ProductView {
  return {
    id: record.product.id,
    slug: record.product.slug,
    merchant: {
      id: record.merchant.id,
      slug: record.merchant.slug,
      displayName: record.merchant.displayName,
      monogram: monogram(record.merchant.displayName),
      supportContact: record.merchant.supportContact ?? 'support@opentab.app',
      verified: record.merchant.status === 'active',
    },
    title: record.product.title,
    description: record.product.description,
    category: 'Experience',
    imagePath: approvedImagePath(
      record.product.imageUrl,
      options.origin,
      options.allowedMediaOrigins ?? [options.origin],
    ),
    imageAlt: `${record.product.title} from ${record.merchant.displayName}`,
    unitPriceBaseUnits: record.product.unitPriceBaseUnits,
    currency: 'USDC',
    maxPerOrder: record.product.maxPerOrder,
    availability: productAvailability(record),
    availabilityCheckedAt: record.availabilityObservedAt,
    projectionStale: record.projectionStale,
    refundTerms: refundTerms(record.product.refundWindowSeconds),
    startsAt: record.product.startsAt,
    location: `See ${record.merchant.displayName} for venue details`,
    loyaltyPoints: record.product.loyaltyPoints,
  };
}

export function mapPublicJudgeProofToView(proof: PublicJudgeProof): JudgeProofView {
  const event =
    proof.settlement.event?.eventName === 'OrderPaid' ? proof.settlement.event : undefined;
  const activityUrl = (() => {
    if (proof.particle.activityUrl === undefined) return undefined;
    try {
      const parsed = new URL(proof.particle.activityUrl);
      return parsed.protocol === 'https:' ? parsed.href : undefined;
    } catch {
      return undefined;
    }
  })();
  return {
    evidenceId: proof.evidenceId,
    orderId: proof.orderId,
    provenance: proof.provenance,
    environment: proof.environment,
    capturedAt: proof.capturedAt,
    refreshedAt: proof.refreshedAt,
    versions: proof.versions,
    account: {
      authMethod: proof.account.authMethod === 'google' ? 'Google' : 'Email one-time code',
      before: proof.account.magicEoaBefore,
      after: proof.account.magicEoaAfter,
      continuous: proof.account.addressContinuous,
      continuityEvidence: proof.account.continuityEvidence,
      delegationStatus: proof.account.delegationTarget === undefined ? 'unavailable' : 'verified',
      ...(proof.account.delegationTarget === undefined
        ? {}
        : { delegationTarget: proof.account.delegationTarget }),
      ...(proof.account.delegationTransactionHash === undefined
        ? {}
        : { delegationTransaction: proof.account.delegationTransactionHash }),
    },
    route: {
      eip7702: proof.particle.eip7702Enabled,
      eip7702Evidence: proof.particle.eip7702Evidence,
      routeEvidence: proof.particle.routeEvidence,
      accountAddress: proof.particle.universalAccountAddress,
      ...(proof.particle.totalUsd === undefined ? {} : { totalUsd: proof.particle.totalUsd }),
      ...(proof.particle.sourceSummary.length === 0
        ? {}
        : {
            sources: proof.particle.sourceSummary.map((source, index) => ({
              id: `${source.chainId}-${source.symbol}-${index.toString()}`,
              chainId: source.chainId,
              label: `Chain ${source.chainId}`,
              symbol: source.symbol,
              amount: source.amount,
              amountUsd: source.amountUsd,
            })),
          }),
      ...(proof.particle.estimatedFeeUsd === undefined
        ? {}
        : { estimatedFeeUsd: proof.particle.estimatedFeeUsd }),
      ...(proof.particle.slippageBps === undefined
        ? {}
        : { slippageBps: proof.particle.slippageBps }),
      ...(proof.particle.quoteObservedAt === undefined
        ? {}
        : { quoteObservedAt: proof.particle.quoteObservedAt }),
      ...(proof.particle.previewDigest === undefined
        ? {}
        : { previewDigest: proof.particle.previewDigest }),
      ...(proof.particle.operationId === undefined
        ? {}
        : { operationId: proof.particle.operationId }),
      ...(activityUrl === undefined ? {} : { activityUrl }),
    },
    settlement: {
      chainId: proof.settlement.chainId,
      checkoutAddress: proof.settlement.checkoutAddress,
      passAddress: proof.settlement.passAddress,
      tokenAddress: proof.settlement.tokenAddress,
      amountBaseUnits: proof.settlement.amountBaseUnits,
      receiptId: proof.settlement.receiptId,
      passTokenId: proof.settlement.passTokenId,
      observedEventName: proof.settlement.event.eventName,
      ...(event === undefined
        ? {}
        : {
            event: {
              eventName: 'OrderPaid',
              chainId: event.chainId,
              contractAddress: event.contractAddress,
              canonical: event.canonical,
              confirmations: event.confirmations,
              transactionHash: event.transactionHash,
              blockNumber: event.blockNumber,
              blockHash: event.blockHash,
              logIndex: event.logIndex,
              observedAt: event.observedAt,
              fields: event.fields,
            },
          }),
    },
    recovery: {
      persistedBeforeWait: proof.recovery.submissionPersistedBeforeWait,
      persistenceEvidence: proof.recovery.submissionPersistenceEvidence,
      reloadRecovered: proof.recovery.reloadRecovered,
      reloadEvidence: proof.recovery.reloadRecoveryEvidence,
      duplicatePrevented: proof.recovery.duplicatePrevented,
      duplicateEvidence: proof.recovery.duplicatePreventionEvidence,
      timing: proof.recovery.timing,
    },
  };
}

function supportReference(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-10)
    .toUpperCase()
    .padStart(10, '0');
}

function maskedAddress(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function stateFromAttempt(
  attempt: CheckoutSnapshotResponse['attempt'],
  canonical: PaymentWorkflowResponse['canonicalOrderPaid'] | undefined,
): CheckoutState {
  if (canonical !== undefined) return 'confirmed';
  if (attempt === undefined) return 'product_ready';
  switch (attempt.status) {
    case 'created':
    case 'prepared':
    case 'failed_pre_submission':
      // Particle's validated raw operation cache is intentionally memory-only.
      // A reloaded pre-submission attempt must start from a new checkout rather
      // than reconstructing or guessing provider state.
      return 'expired';
    case 'submission_started':
    case 'submitted_unknown':
      return 'submitted_status_unknown';
    case 'submitted':
    case 'executing':
      return 'waiting_for_particle';
    case 'confirming':
    case 'paid':
      return 'waiting_for_arbitrum';
    case 'failed_confirmed':
      return 'terminal_failure';
    case 'expired':
      return 'expired';
  }
}

function hasRequiredFinality(
  proof: PaymentWorkflowResponse['canonicalOrderPaid'] | undefined,
): proof is NonNullable<PaymentWorkflowResponse['canonicalOrderPaid']> {
  return proof !== undefined && BigInt(proof.confirmations) >= BigInt(proof.requiredConfirmations);
}

export function mapCheckoutResponseToView(
  response: CheckoutSnapshotResponse,
  options: { origin: string; workflow?: PaymentWorkflowResponse | undefined },
): CheckoutSnapshotView {
  const workflow = options.workflow;
  const attempt = workflow?.attempt ?? response.attempt;
  const order = workflow?.order ?? response.order;
  const observedCanonical = workflow?.canonicalOrderPaid;
  const canonical = hasRequiredFinality(observedCanonical) ? observedCanonical : undefined;
  const state =
    response.session.status === 'expired' || new Date(response.session.expiresAt) <= new Date()
      ? 'expired'
      : stateFromAttempt(attempt, canonical);
  const product = mapPublicProductToView(
    {
      product: response.product,
      merchant: response.merchant,
      availabilityObservedAt: response.session.updatedAt,
      projectionStale: false,
      requestId: response.requestId,
    },
    { origin: options.origin },
  );
  return {
    checkoutSessionId: response.session.id,
    ...(order === undefined ? {} : { orderId: order.id }),
    supportReference: supportReference(order?.id ?? response.session.id),
    state,
    product,
    quantity: response.session.quantity,
    ...(order === undefined ? {} : { addressMasked: maskedAddress(order.payer) }),
    ...(attempt?.providerOperationId === undefined
      ? {}
      : { providerOperationId: attempt.providerOperationId }),
    ...(canonical === undefined
      ? {}
      : {
          canonicalConfirmation: {
            eventName: canonical.eventName,
            canonical: canonical.canonical,
            confirmations: canonical.confirmations,
            requiredConfirmations: canonical.requiredConfirmations,
            transactionHash: canonical.transactionHash,
            blockNumber: canonical.blockNumber,
            observedAt: canonical.observedAt,
          },
        }),
    submissionPossible: attempt !== undefined && isSubmissionStatus(attempt.status),
    updatedAt: attempt?.updatedAt ?? order?.updatedAt ?? response.session.updatedAt,
  };
}

function slippageLabel(basisPoints: string): string {
  const value = BigInt(basisPoints);
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `Maximum route movement ${whole}${fraction.length === 0 ? '' : `.${fraction}`}%`;
}

export function mapValidatedPlanToQuote(
  plan: ValidatedOperationPlan,
  balance: UnifiedBalance,
): QuoteView {
  return {
    productBaseUnits: plan.quote.amountBaseUnits,
    estimatedFeeUsd: plan.quote.estimatedFeeUsd,
    maximumTotalUsd: plan.quote.totalUsd,
    availableUsd: balance.totalUsd,
    expiresAt: plan.quote.expiresAt,
    slippageLabel: slippageLabel(plan.quote.slippageBps),
    sources: plan.quote.sources.map((source, index) => ({
      id: `${source.chainId}-${source.symbol}-${index.toString()}`,
      label: `Network ${source.chainId}`,
      symbol: source.symbol,
      amount: source.amount,
      amountUsd: source.amountUsd,
    })),
  };
}

export function applyPaymentWorkflowToView(
  snapshot: CheckoutSnapshotView,
  workflow: PaymentWorkflowResponse,
): CheckoutSnapshotView {
  const canonical = hasRequiredFinality(workflow.canonicalOrderPaid)
    ? workflow.canonicalOrderPaid
    : undefined;
  return {
    ...snapshot,
    orderId: workflow.order.id,
    supportReference: supportReference(workflow.order.id),
    addressMasked: maskedAddress(workflow.order.payer),
    state: stateFromAttempt(workflow.attempt, canonical),
    ...(workflow.attempt.providerOperationId === undefined
      ? {}
      : { providerOperationId: workflow.attempt.providerOperationId }),
    ...(canonical === undefined
      ? {}
      : {
          canonicalConfirmation: {
            eventName: canonical.eventName,
            canonical: canonical.canonical,
            confirmations: canonical.confirmations,
            requiredConfirmations: canonical.requiredConfirmations,
            transactionHash: canonical.transactionHash,
            blockNumber: canonical.blockNumber,
            observedAt: canonical.observedAt,
          },
        }),
    submissionPossible: isSubmissionStatus(workflow.attempt.status),
    updatedAt: workflow.attempt.updatedAt,
  };
}

function isSubmissionStatus(status: PaymentWorkflowResponse['attempt']['status']): boolean {
  return [
    'submission_started',
    'submitted',
    'submitted_unknown',
    'executing',
    'confirming',
    'paid',
    'failed_confirmed',
  ].includes(status);
}
