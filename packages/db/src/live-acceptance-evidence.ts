import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type ChainId,
  digestUnknown,
  type EvidenceDigest,
  type EvmAddress,
  LIVE_ACCEPTANCE_MAX_PAYMENT_BASE_UNITS,
  type LiveAcceptanceEvidenceInput,
  LiveAcceptanceEvidenceInputSchema,
  sameEvmAddress,
} from '@opentab/shared';
import { and, asc, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { assertEvidenceWriterDatabasePrivileges } from './evidence-writer-privileges.js';
import { parseCanonicalEventProof, type StoredDecodedEvent } from './projectors.js';
import {
  bootstrapGrants,
  canonicalLogs,
  delegationRecords,
  liveAcceptanceEvidence,
  merchants,
  orders,
  paymentAttempts,
  products,
  providerOperations,
  receipts,
  signedOrderIntents,
  userIdentities,
  walletAccounts,
} from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

export interface LiveAcceptanceEvidenceConfig {
  readonly checkoutAddress: EvmAddress;
  readonly passAddress: EvmAddress;
  readonly tokenAddress: EvmAddress;
  readonly deploymentConfigDigest: EvidenceDigest;
  readonly minimumConfirmations: bigint;
  readonly allowedSourceChainIds: readonly ChainId[];
  readonly allowedSourceSymbols: readonly ('USDC' | 'USDT' | 'ETH')[];
  readonly maximumSlippageBps: bigint;
  readonly attestationSecret: string;
}

export const LIVE_ACCEPTANCE_ATTESTATION_VERSION = 'hmac-sha256-v1' as const;

export interface LiveAcceptanceAttestationFields {
  readonly environment: string;
  readonly releaseId: string;
  readonly deploymentConfigDigest: string;
  readonly orderId: string;
  readonly paymentAttemptId: string;
  readonly providerOperationId: string;
  readonly previewDigest: string;
  readonly providerEvidenceDigest: string;
  readonly providerProvenance: string;
  readonly delegationEvidenceDigest: string;
  readonly delegationTransactionHash: string;
  readonly route: unknown;
  readonly chainId: string | bigint;
  readonly checkoutAddress: string;
  readonly settlementTransactionHash: string;
  readonly settlementBlockNumber: string | bigint;
  readonly settlementBlockHash: string;
  readonly settlementLogIndex: number;
  readonly receiptId: string;
  readonly passTokenId: string;
  readonly recovery: unknown;
  readonly timingMs: unknown;
  readonly payloadDigest: string;
  readonly startedAt: Date | string;
  readonly capturedAt: Date | string;
}

function isoTimestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function liveAcceptanceAttestationMessage(fields: LiveAcceptanceAttestationFields): string {
  return digestUnknown({
    domain: 'opentab/live-acceptance-evidence',
    version: LIVE_ACCEPTANCE_ATTESTATION_VERSION,
    environment: fields.environment,
    releaseId: fields.releaseId.toLowerCase(),
    deploymentConfigDigest: fields.deploymentConfigDigest.toLowerCase(),
    orderId: fields.orderId,
    paymentAttemptId: fields.paymentAttemptId,
    providerOperationId: fields.providerOperationId,
    previewDigest: fields.previewDigest.toLowerCase(),
    providerEvidenceDigest: fields.providerEvidenceDigest.toLowerCase(),
    providerProvenance: fields.providerProvenance,
    delegationEvidenceDigest: fields.delegationEvidenceDigest.toLowerCase(),
    delegationTransactionHash: fields.delegationTransactionHash.toLowerCase(),
    route: fields.route,
    chainId: fields.chainId.toString(),
    checkoutAddress: fields.checkoutAddress.toLowerCase(),
    settlementTransactionHash: fields.settlementTransactionHash.toLowerCase(),
    settlementBlockNumber: fields.settlementBlockNumber.toString(),
    settlementBlockHash: fields.settlementBlockHash.toLowerCase(),
    settlementLogIndex: fields.settlementLogIndex,
    receiptId: fields.receiptId,
    passTokenId: fields.passTokenId,
    recovery: fields.recovery,
    timingMs: fields.timingMs,
    payloadDigest: fields.payloadDigest.toLowerCase(),
    startedAt: isoTimestamp(fields.startedAt),
    capturedAt: isoTimestamp(fields.capturedAt),
  });
}

export function createLiveAcceptanceAttestation(
  secret: string,
  fields: LiveAcceptanceAttestationFields,
): `0x${string}` {
  if (secret.length < 32) throw new RangeError('Live acceptance attestation secret is too short');
  return `0x${createHmac('sha256', secret)
    .update(liveAcceptanceAttestationMessage(fields), 'utf8')
    .digest('hex')}`;
}

export function verifyLiveAcceptanceAttestation(
  secret: string,
  fields: LiveAcceptanceAttestationFields,
  version: string,
  suppliedMac: string,
): boolean {
  if (secret.length < 32 || version !== LIVE_ACCEPTANCE_ATTESTATION_VERSION) return false;
  const expected = createLiveAcceptanceAttestation(secret, fields);
  if (!/^0x[0-9a-fA-F]{64}$/.test(suppliedMac)) return false;
  return timingSafeEqual(
    Buffer.from(expected.slice(2), 'hex'),
    Buffer.from(suppliedMac.slice(2), 'hex'),
  );
}

function normalizeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForDigest);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, normalizeForDigest(source[key])]),
  );
}

export function createLiveAcceptancePayloadDigest(value: unknown): `0x${string}` {
  return `0x${createHash('sha256')
    .update(JSON.stringify(normalizeForDigest(value)), 'utf8')
    .digest('hex')}`;
}

function decodedFields(value: Record<string, unknown>): Record<string, string> {
  const candidate =
    typeof value.fields === 'object' && value.fields !== null ? value.fields : value;
  return Object.fromEntries(
    Object.entries(candidate as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function sameText(left: string | null | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function decimalUsdToMicros(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    throw new AppError('VALIDATION_FAILED', 'USD evidence exceeds six-decimal precision.');
  }
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0');
}

function isPositiveDecimal(value: string): boolean {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return false;
  return BigInt(value.replace('.', '')) > 0n;
}

function assertExactEvent(
  stored: Extract<
    NonNullable<ReturnType<typeof parseCanonicalEventProof>>,
    { eventName: 'OrderPaid' }
  >,
  supplied: Extract<LiveAcceptanceEvidenceInput['settlement']['event'], { eventName: 'OrderPaid' }>,
): void {
  const positionMatches =
    stored.chainId === supplied.chainId &&
    sameText(stored.contractAddress, supplied.contractAddress) &&
    sameText(stored.transactionHash, supplied.transactionHash) &&
    stored.blockNumber === supplied.blockNumber &&
    sameText(stored.blockHash, supplied.blockHash) &&
    stored.logIndex === supplied.logIndex &&
    stored.canonical &&
    supplied.canonical;
  const addressFields = ['payer', 'recipient', 'token'] as const;
  const exactFields = [
    'orderKey',
    'merchantOnchainId',
    'productOnchainId',
    'quantity',
    'amountBaseUnits',
    'platformFeeBaseUnits',
    'intentDigest',
    'passTokenId',
    'refundDeadline',
  ] as const;
  if (
    !positionMatches ||
    addressFields.some((field) => !sameText(stored.fields[field], supplied.fields[field])) ||
    exactFields.some(
      (field) => stored.fields[field].toLowerCase() !== supplied.fields[field].toLowerCase(),
    )
  ) {
    throw new AppError(
      'PAYMENT_EVENT_MISMATCH',
      'The acceptance event does not match the canonical indexed event.',
    );
  }
}

/**
 * The only production writer for append-only live acceptance evidence. It is
 * intentionally absent from the HTTP application ports and validates a
 * privileged harness observation against current canonical database facts.
 */
export class PostgresLiveAcceptanceEvidenceStore {
  constructor(
    private readonly uow: PostgresUnitOfWork,
    private readonly config: LiveAcceptanceEvidenceConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (config.attestationSecret.length < 32) {
      throw new RangeError('Live acceptance attestation secret is too short');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.deploymentConfigDigest)) {
      throw new RangeError('Live acceptance deployment configuration digest is invalid');
    }
    if (config.minimumConfirmations < 1n || config.minimumConfirmations > 100n) {
      throw new RangeError('Live acceptance confirmation depth is invalid');
    }
    if (
      config.allowedSourceChainIds.length === 0 ||
      config.allowedSourceSymbols.length === 0 ||
      config.maximumSlippageBps < 0n ||
      config.maximumSlippageBps > 500n
    ) {
      throw new RangeError('Live acceptance route policy is invalid');
    }
  }

  async accept(inputValue: unknown): Promise<{ readonly id: string; readonly digest: string }> {
    const input = LiveAcceptanceEvidenceInputSchema.parse(inputValue);
    const startedAt = new Date(input.startedAt);
    const recoveredAt = new Date(input.recovery.observedAt);
    const capturedAt = new Date(input.capturedAt);
    if (capturedAt.getTime() > this.now().getTime() + 60_000) {
      throw new AppError('VALIDATION_FAILED', 'Live acceptance evidence is future-dated.');
    }

    return this.uow.serializableTransaction(async () => {
      await assertEvidenceWriterDatabasePrivileges(this.uow.current());
      const baseRows = await this.uow
        .current()
        .select({
          order: orders,
          merchantOnchainId: merchants.onchainMerchantId,
          productMerchantId: products.merchantId,
          productOnchainId: products.onchainProductId,
          receipt: receipts,
          signedIntentDigest: signedOrderIntents.digest,
          signedIntent: signedOrderIntents.intent,
        })
        .from(orders)
        .innerJoin(merchants, eq(merchants.id, orders.merchantId))
        .innerJoin(products, eq(products.id, orders.productId))
        .innerJoin(receipts, eq(receipts.orderId, orders.id))
        .innerJoin(signedOrderIntents, eq(signedOrderIntents.orderKey, orders.orderKey))
        .where(eq(orders.id, input.orderId));
      if (baseRows.length !== 1) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'The canonical order is unavailable.');
      }
      const base = baseRows[0];
      if (
        base === undefined ||
        !['paid', 'partially_refunded', 'refunded'].includes(base.order.status) ||
        base.order.confirmedAt === null ||
        base.order.transactionHash === null ||
        base.order.blockNumber === null ||
        base.order.blockHash === null ||
        base.order.logIndex === null ||
        base.receipt.status !== 'issued' ||
        base.receipt.issuedAt === null ||
        base.receipt.tokenId === null ||
        base.receipt.chainEventId === null ||
        base.merchantOnchainId === null ||
        base.productOnchainId === null ||
        base.productMerchantId !== base.order.merchantId ||
        base.signedIntentDigest.toLowerCase() !== base.order.intentDigest.toLowerCase()
      ) {
        throw new AppError(
          'PAYMENT_NOT_CANONICAL',
          'The paid order and issued pass are incomplete.',
        );
      }
      if (
        base.order.chainId !== ARBITRUM_ONE_CHAIN_ID ||
        input.deploymentConfigDigest.toLowerCase() !==
          this.config.deploymentConfigDigest.toLowerCase() ||
        !sameEvmAddress(base.order.tokenAddress as EvmAddress, this.config.tokenAddress) ||
        BigInt(base.order.paidAmountBaseUnits) > BigInt(LIVE_ACCEPTANCE_MAX_PAYMENT_BASE_UNITS) ||
        startedAt > base.order.createdAt ||
        capturedAt < base.order.confirmedAt ||
        recoveredAt < base.order.confirmedAt
      ) {
        throw new AppError('PAYMENT_EVENT_MISMATCH', 'The acceptance order binding is invalid.');
      }

      const canonicalRows = await this.uow
        .current()
        .select()
        .from(canonicalLogs)
        .where(
          and(
            eq(canonicalLogs.chainId, base.order.chainId),
            eq(canonicalLogs.contractAddress, this.config.checkoutAddress),
            eq(canonicalLogs.transactionHash, base.order.transactionHash),
            eq(canonicalLogs.blockNumber, base.order.blockNumber),
            eq(canonicalLogs.blockHash, base.order.blockHash),
            eq(canonicalLogs.logIndex, base.order.logIndex),
            eq(canonicalLogs.eventName, 'OrderPaid'),
            eq(canonicalLogs.canonical, true),
            eq(canonicalLogs.projectionStatus, 'applied'),
          ),
        )
        .limit(2);
      if (canonicalRows.length !== 1) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical OrderPaid evidence is ambiguous.');
      }
      const canonical = canonicalRows[0];
      if (canonical === undefined) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical OrderPaid evidence is unavailable.');
      }
      const canonicalPayload = canonical.decodedPayload;
      const decoded: StoredDecodedEvent = {
        eventName: 'OrderPaid',
        fields: decodedFields(canonicalPayload),
        decoderVersion:
          typeof canonicalPayload.decoderVersion === 'string'
            ? canonicalPayload.decoderVersion
            : 'live-acceptance-v1',
      };
      const confirmations =
        typeof canonicalPayload.confirmations === 'string'
          ? BigInt(canonicalPayload.confirmations)
          : 0n;
      const canonicalProof = parseCanonicalEventProof(decoded, {
        chainId: canonical.chainId,
        contractAddress: canonical.contractAddress,
        transactionHash: canonical.transactionHash,
        blockNumber: canonical.blockNumber,
        blockHash: canonical.blockHash,
        logIndex: canonical.logIndex,
        confirmations,
        observedAt: canonical.observedAt,
      });
      const suppliedEvent = input.settlement.event;
      if (
        canonicalProof?.eventName !== 'OrderPaid' ||
        suppliedEvent.eventName !== 'OrderPaid' ||
        confirmations < this.config.minimumConfirmations ||
        BigInt(suppliedEvent.confirmations) < this.config.minimumConfirmations
      ) {
        throw new AppError(
          'PAYMENT_NOT_CANONICAL',
          'OrderPaid confirmation evidence is insufficient.',
        );
      }
      const storedObservedAt = new Date(canonicalProof.observedAt).getTime();
      const suppliedObservedAt = new Date(suppliedEvent.observedAt).getTime();
      if (
        storedObservedAt < startedAt.getTime() ||
        storedObservedAt > capturedAt.getTime() ||
        suppliedObservedAt < startedAt.getTime() ||
        suppliedObservedAt > capturedAt.getTime()
      ) {
        throw new AppError(
          'PAYMENT_NOT_CANONICAL',
          'OrderPaid observation timestamps are outside the acceptance window.',
        );
      }
      assertExactEvent(canonicalProof, suppliedEvent);
      const expectedPlatformFee = base.signedIntent.platformFeeBaseUnits;
      const expectedRefundDeadline = (
        BigInt(base.order.refundableUntil.getTime()) / 1_000n
      ).toString();
      if (
        canonicalProof.fields.orderKey.toLowerCase() !== base.order.orderKey.toLowerCase() ||
        canonicalProof.fields.merchantOnchainId !== base.merchantOnchainId ||
        canonicalProof.fields.productOnchainId !== base.productOnchainId ||
        !sameText(canonicalProof.fields.payer, base.order.payer) ||
        !sameText(canonicalProof.fields.recipient, base.order.recipient) ||
        !sameText(canonicalProof.fields.token, base.order.tokenAddress) ||
        canonicalProof.fields.quantity !== base.order.quantity ||
        canonicalProof.fields.amountBaseUnits !== base.order.paidAmountBaseUnits ||
        canonicalProof.fields.platformFeeBaseUnits !== expectedPlatformFee ||
        canonicalProof.fields.intentDigest.toLowerCase() !==
          base.order.intentDigest.toLowerCase() ||
        canonicalProof.fields.passTokenId !== base.receipt.tokenId ||
        canonicalProof.fields.refundDeadline !== expectedRefundDeadline ||
        input.settlement.receiptId !== base.receipt.id ||
        input.settlement.passTokenId !== base.receipt.tokenId
      ) {
        throw new AppError('PAYMENT_EVENT_MISMATCH', 'The acceptance payment fields are invalid.');
      }

      const transferRows = await this.uow
        .current()
        .select()
        .from(canonicalLogs)
        .where(
          and(
            eq(canonicalLogs.id, base.receipt.chainEventId),
            eq(canonicalLogs.chainId, base.order.chainId),
            eq(canonicalLogs.contractAddress, this.config.passAddress),
            eq(canonicalLogs.transactionHash, base.order.transactionHash),
            eq(canonicalLogs.blockNumber, base.order.blockNumber),
            eq(canonicalLogs.blockHash, base.order.blockHash),
            eq(canonicalLogs.eventName, 'TransferSingle'),
            eq(canonicalLogs.canonical, true),
            eq(canonicalLogs.projectionStatus, 'applied'),
          ),
        )
        .limit(2);
      const transfer = transferRows[0];
      const transferFields = transfer === undefined ? {} : decodedFields(transfer.decodedPayload);
      if (
        transferRows.length !== 1 ||
        transfer === undefined ||
        !/^0x0{40}$/i.test(transferFields.from ?? '') ||
        !sameText(transferFields.operator, this.config.checkoutAddress) ||
        !sameText(transferFields.to, base.order.recipient) ||
        transferFields.id !== base.receipt.tokenId ||
        transferFields.value !== base.order.quantity
      ) {
        throw new AppError('PAYMENT_EVENT_MISMATCH', 'The receipt mint evidence is invalid.');
      }

      const attemptRows = await this.uow
        .current()
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.id, input.paymentAttemptId),
            eq(paymentAttempts.orderId, base.order.id),
            eq(paymentAttempts.status, 'paid'),
            eq(paymentAttempts.providerOperationId, input.providerOperationId),
            eq(paymentAttempts.destinationTransactionHash, base.order.transactionHash),
            eq(paymentAttempts.previewDigest, input.route.previewDigest),
            isNotNull(paymentAttempts.preparedRootHashDigest),
            isNotNull(paymentAttempts.submissionStartedAt),
          ),
        );
      if (attemptRows.length !== 1) {
        throw new AppError('PAYMENT_EVENT_MISMATCH', 'The paid attempt binding is invalid.');
      }
      const attempt = attemptRows[0];
      if (
        attempt === undefined ||
        base.order.providerOperationId !== input.providerOperationId ||
        startedAt > attempt.createdAt ||
        attempt.preparedExpiresAt === null ||
        attempt.preparedExpiresAt.getTime() !== new Date(input.route.expiresAt).getTime()
      ) {
        throw new AppError('PAYMENT_EVENT_MISMATCH', 'The paid attempt binding is invalid.');
      }
      const quoteSummary = attempt.quoteSummary ?? {};
      const feeMicros = decimalUsdToMicros(input.route.estimatedFeeUsd);
      const totalMicros = decimalUsdToMicros(input.route.totalUsd);
      const sourceUsdMicros = input.route.sources.reduce(
        (total, source) => total + decimalUsdToMicros(source.amountUsd),
        0n,
      );
      const quotedAt = new Date(input.route.quotedAt);
      const expiresAt = new Date(input.route.expiresAt);
      const recomputedPreviewDigest = digestUnknown({
        amountBaseUnits: base.order.amountBaseUnits,
        estimatedFeeUsd: input.route.estimatedFeeUsd,
        totalUsd: input.route.totalUsd,
        slippageBps: input.route.slippageBps,
        sources: input.route.sources,
        quotedAt: input.route.quotedAt,
        expiresAt: input.route.expiresAt,
      });
      const sourcePolicyValid = input.route.sources.every(
        (source) =>
          this.config.allowedSourceChainIds.includes(source.chainId) &&
          this.config.allowedSourceSymbols.some((symbol) => symbol === source.symbol) &&
          isPositiveDecimal(source.amount) &&
          decimalUsdToMicros(source.amountUsd) > 0n,
      );
      if (
        quoteSummary.destinationAmountBaseUnits !== base.order.amountBaseUnits ||
        quoteSummary.sourceAmountBaseUnits !== base.order.amountBaseUnits ||
        quoteSummary.feeBaseUnits !== feeMicros.toString() ||
        quoteSummary.routeLabel !== 'Particle Universal Account to Arbitrum One' ||
        recomputedPreviewDigest.toLowerCase() !== input.route.previewDigest.toLowerCase() ||
        totalMicros !== BigInt(base.order.amountBaseUnits) + feeMicros ||
        sourceUsdMicros !== totalMicros ||
        !sourcePolicyValid ||
        BigInt(input.route.slippageBps) > this.config.maximumSlippageBps ||
        quotedAt < startedAt ||
        quotedAt >= expiresAt ||
        quotedAt > capturedAt
      ) {
        throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'The accepted route summary is invalid.');
      }

      const finalProvider = input.providerOperation;
      const finalProviderObservedAt = new Date(finalProvider.evidence.observedAt);
      const finalProviderUpdatedAt = new Date(finalProvider.updatedAt);
      if (
        finalProvider.id !== input.providerOperationId ||
        finalProvider.status !== 'succeeded' ||
        !finalProvider.submissionPossible ||
        !sameText(finalProvider.destinationTransactionHash, base.order.transactionHash) ||
        finalProvider.activityUrl !== input.route.activityUrl ||
        finalProvider.evidence.adapter !== 'particle-get-transaction' ||
        finalProvider.evidence.environment !== input.environment ||
        !['live', 'recorded_live'].includes(finalProvider.evidence.provenance) ||
        finalProviderObservedAt < startedAt ||
        finalProviderObservedAt > capturedAt ||
        finalProviderUpdatedAt < startedAt ||
        finalProviderUpdatedAt > capturedAt
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The final Particle observation is invalid.',
        );
      }

      const existingProviderRows = await this.uow
        .current()
        .select()
        .from(providerOperations)
        .where(
          and(
            eq(providerOperations.provider, 'particle'),
            eq(providerOperations.externalId, input.providerOperationId),
          ),
        )
        .limit(2);
      if (existingProviderRows.length > 1) {
        throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle evidence is ambiguous.');
      }
      const existingProvider = existingProviderRows[0];
      if (
        existingProvider === undefined ||
        existingProvider.paymentAttemptId !== attempt.id ||
        existingProvider.kind !== 'checkout' ||
        existingProvider.status !== 'succeeded' ||
        !existingProvider.submissionPossible ||
        !sameText(existingProvider.destinationTransactionHash, base.order.transactionHash) ||
        existingProvider.activityUrl !== input.route.activityUrl ||
        existingProvider.evidenceDigest.toLowerCase() !==
          finalProvider.evidence.evidenceDigest.toLowerCase() ||
        existingProvider.safeSummary.environment !== input.environment ||
        existingProvider.safeSummary.provenance !== finalProvider.evidence.provenance ||
        existingProvider.safeSummary.adapter !== finalProvider.evidence.adapter ||
        existingProvider.safeSummary.packageVersion !== finalProvider.evidence.packageVersion ||
        existingProvider.safeSummary.schemaVersion !==
          finalProvider.evidence.schemaVersion.toString() ||
        existingProvider.safeSummary.finalObservedAt !== finalProvider.evidence.observedAt ||
        existingProvider.safeSummary.providerUpdatedAt !== finalProvider.updatedAt ||
        existingProvider.createdAt > recoveredAt ||
        existingProvider.observedAt.getTime() !== finalProviderObservedAt.getTime() ||
        existingProvider.observedAt > recoveredAt ||
        existingProvider.updatedAt > recoveredAt ||
        finalProviderUpdatedAt > recoveredAt
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The persisted Particle operation binding is invalid.',
        );
      }

      const providerRows = await this.uow
        .current()
        .select()
        .from(providerOperations)
        .where(
          and(
            eq(providerOperations.paymentAttemptId, attempt.id),
            eq(providerOperations.provider, 'particle'),
            eq(providerOperations.externalId, input.providerOperationId),
            eq(providerOperations.kind, 'checkout'),
            eq(providerOperations.status, 'succeeded'),
            eq(providerOperations.submissionPossible, true),
            eq(providerOperations.destinationTransactionHash, base.order.transactionHash),
            eq(providerOperations.evidenceDigest, finalProvider.evidence.evidenceDigest),
          ),
        )
        .limit(2);
      const provider = providerRows[0];
      const providerProvenance = provider?.safeSummary.provenance;
      if (
        providerRows.length !== 1 ||
        provider === undefined ||
        !['live', 'recorded_live'].includes(providerProvenance ?? '') ||
        providerProvenance !== finalProvider.evidence.provenance ||
        provider.safeSummary.environment !== input.environment ||
        provider.safeSummary.adapter !== finalProvider.evidence.adapter ||
        provider.safeSummary.packageVersion !== finalProvider.evidence.packageVersion ||
        provider.safeSummary.schemaVersion !== finalProvider.evidence.schemaVersion.toString() ||
        provider.safeSummary.finalObservedAt !== finalProvider.evidence.observedAt ||
        provider.safeSummary.providerUpdatedAt !== finalProvider.updatedAt ||
        (provider.activityUrl ?? undefined) !== input.route.activityUrl ||
        provider.observedAt < startedAt ||
        provider.observedAt > recoveredAt
      ) {
        throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Live Particle evidence is unavailable.');
      }
      const verifiedProviderProvenance =
        providerProvenance === 'live' || providerProvenance === 'recorded_live'
          ? providerProvenance
          : undefined;
      if (verifiedProviderProvenance === undefined) {
        throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle provenance is invalid.');
      }

      const walletRows = await this.uow
        .current()
        .select()
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.userId, base.order.userId),
            eq(walletAccounts.environment, input.environment),
            eq(walletAccounts.delegationStatus, 'confirmed'),
            eq(walletAccounts.eip7702Enabled, true),
          ),
        )
        .limit(2);
      const wallet = walletRows[0];
      if (
        walletRows.length !== 1 ||
        wallet === undefined ||
        wallet.delegationTransactionHash === null ||
        wallet.arbitrumImplementation === null ||
        !sameText(wallet.ownerAddressLower, base.order.payer) ||
        !sameText(wallet.universalAccountAddressLower, base.order.payer) ||
        !sameText(input.context.ownerAddress, base.order.payer) ||
        !sameText(input.context.safeAccountIdentifiers[0], base.order.payer) ||
        !sameText(input.context.delegationTransactionHash, wallet.delegationTransactionHash) ||
        input.context.particleProtocolVersion !== wallet.protocolVersion ||
        wallet.checkedAt > base.order.confirmedAt
      ) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'Exact EIP-7702 wallet evidence is unavailable.',
        );
      }
      const delegationRows = await this.uow
        .current()
        .select()
        .from(delegationRecords)
        .where(
          and(
            eq(delegationRecords.userId, base.order.userId),
            eq(delegationRecords.environment, input.environment),
            eq(delegationRecords.chainId, ARBITRUM_ONE_CHAIN_ID),
            eq(delegationRecords.status, 'confirmed'),
            eq(delegationRecords.transactionHash, wallet.delegationTransactionHash),
            eq(delegationRecords.ownerAddressLower, wallet.ownerAddressLower),
            eq(delegationRecords.implementationAddressLower, wallet.arbitrumImplementation),
            eq(delegationRecords.evidenceDigest, wallet.evidenceDigest),
            isNotNull(delegationRecords.blockNumber),
            isNotNull(delegationRecords.blockHash),
            gte(delegationRecords.blockNumber, 0n),
            lt(delegationRecords.blockNumber, base.order.blockNumber),
            lte(delegationRecords.checkedAt, base.order.confirmedAt),
          ),
        )
        .limit(2);
      const delegation = delegationRows[0];
      if (delegationRows.length !== 1 || delegation === undefined) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'Immutable delegation evidence is unavailable.',
        );
      }

      const [
        orderCount,
        attemptCount,
        operationCount,
        submissionCount,
        receiptCount,
        grantCount,
        delegationCount,
      ] = await Promise.all([
        this.uow
          .current()
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(eq(orders.orderKey, base.order.orderKey)),
        this.uow
          .current()
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.orderId, base.order.id)),
        this.uow
          .current()
          .select({ count: sql<number>`count(*)::int` })
          .from(providerOperations)
          .innerJoin(paymentAttempts, eq(paymentAttempts.id, providerOperations.paymentAttemptId))
          .where(eq(paymentAttempts.orderId, base.order.id)),
        this.uow
          .current()
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.orderId, base.order.id),
              isNotNull(paymentAttempts.submissionStartedAt),
            ),
          ),
        this.uow
          .current()
          .select({ count: sql<number>`count(*)::int` })
          .from(receipts)
          .where(eq(receipts.orderId, base.order.id)),
        this.uow
          .current()
          .select({ count: sql<number>`count(*)::int` })
          .from(bootstrapGrants)
          .where(
            and(
              eq(bootstrapGrants.userId, base.order.userId),
              eq(bootstrapGrants.environment, input.environment),
              gte(bootstrapGrants.createdAt, startedAt),
            ),
          ),
        this.uow
          .current()
          .select({ count: sql<number>`count(*)::int` })
          .from(delegationRecords)
          .where(
            and(
              eq(delegationRecords.userId, base.order.userId),
              eq(delegationRecords.environment, input.environment),
              gte(delegationRecords.createdAt, startedAt),
            ),
          ),
      ]);
      const actualRecovery = {
        orderCount: orderCount[0]?.count ?? 0,
        paymentAttemptCount: attemptCount[0]?.count ?? 0,
        providerOperationCount: operationCount[0]?.count ?? 0,
        submissionCount: submissionCount[0]?.count ?? 0,
        receiptCount: receiptCount[0]?.count ?? 0,
        sponsorGrantCount: grantCount[0]?.count ?? 0,
        delegationCount: delegationCount[0]?.count ?? 0,
      };
      if (
        Object.entries(actualRecovery).some(
          ([key, value]) => input.recovery[key as keyof typeof actualRecovery] !== value,
        )
      ) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Recovery counts do not match durable state.');
      }

      const expectedActivationPath =
        actualRecovery.sponsorGrantCount === 1
          ? 'bootstrap_sponsor'
          : actualRecovery.delegationCount === 0
            ? 'already_delegated'
            : actualRecovery.delegationCount === 1
              ? 'self_funded_type4'
              : undefined;
      const [identity] = await this.uow
        .current()
        .select({ authMethod: userIdentities.authMethod })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.userId, base.order.userId),
            eq(userIdentities.provider, 'magic'),
            gte(userIdentities.lastVerifiedAt, startedAt),
            lte(userIdentities.lastVerifiedAt, recoveredAt),
          ),
        )
        .orderBy(desc(userIdentities.lastVerifiedAt), asc(userIdentities.id))
        .limit(1);
      const sponsorTransactionHash = input.context.sponsorGrantTransactionHash;
      const sponsorRows =
        expectedActivationPath === 'bootstrap_sponsor' && sponsorTransactionHash !== undefined
          ? await this.uow
              .current()
              .select({ id: bootstrapGrants.id })
              .from(bootstrapGrants)
              .where(
                and(
                  eq(bootstrapGrants.userId, base.order.userId),
                  eq(bootstrapGrants.environment, input.environment),
                  eq(bootstrapGrants.status, 'confirmed'),
                  eq(bootstrapGrants.recipientAddressLower, base.order.payer),
                  eq(bootstrapGrants.transactionHash, sponsorTransactionHash),
                  isNotNull(bootstrapGrants.confirmedAt),
                  gte(bootstrapGrants.createdAt, startedAt),
                  lte(bootstrapGrants.confirmedAt, base.order.confirmedAt),
                ),
              )
              .limit(2)
          : [];
      if (
        expectedActivationPath === undefined ||
        input.context.activationPath !== expectedActivationPath ||
        identity?.authMethod !== input.context.authMethod ||
        (expectedActivationPath === 'bootstrap_sponsor' && sponsorRows.length !== 1) ||
        (expectedActivationPath !== 'bootstrap_sponsor' && sponsorTransactionHash !== undefined)
      ) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'The authenticated EIP-7702 activation context is not durably evidenced.',
        );
      }

      const digest = createLiveAcceptancePayloadDigest({
        input,
        providerEvidenceDigest: provider.evidenceDigest.toLowerCase(),
        providerProvenance: verifiedProviderProvenance,
        delegationEvidenceDigest: delegation.evidenceDigest.toLowerCase(),
        delegationTransactionHash: delegation.transactionHash?.toLowerCase(),
      });
      const attestationFields: LiveAcceptanceAttestationFields = {
        environment: input.environment,
        releaseId: input.releaseId,
        deploymentConfigDigest: input.deploymentConfigDigest,
        orderId: input.orderId,
        paymentAttemptId: input.paymentAttemptId,
        providerOperationId: input.providerOperationId,
        previewDigest: input.route.previewDigest,
        providerEvidenceDigest: provider.evidenceDigest,
        providerProvenance: verifiedProviderProvenance,
        delegationEvidenceDigest: delegation.evidenceDigest,
        delegationTransactionHash: wallet.delegationTransactionHash,
        route: input.route,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        checkoutAddress: this.config.checkoutAddress,
        settlementTransactionHash: base.order.transactionHash,
        settlementBlockNumber: base.order.blockNumber,
        settlementBlockHash: base.order.blockHash,
        settlementLogIndex: base.order.logIndex,
        receiptId: base.receipt.id,
        passTokenId: base.receipt.tokenId,
        recovery: input.recovery,
        timingMs: input.timingMs,
        payloadDigest: digest,
        startedAt,
        capturedAt,
      };
      const attestationMac = createLiveAcceptanceAttestation(
        this.config.attestationSecret,
        attestationFields,
      );
      const [inserted] = await this.uow
        .current()
        .insert(liveAcceptanceEvidence)
        .values({
          environment: input.environment,
          releaseId: input.releaseId.toLowerCase(),
          deploymentConfigDigest: input.deploymentConfigDigest.toLowerCase(),
          orderId: input.orderId,
          paymentAttemptId: input.paymentAttemptId,
          providerOperationId: input.providerOperationId,
          previewDigest: input.route.previewDigest.toLowerCase(),
          providerEvidenceDigest: provider.evidenceDigest.toLowerCase(),
          providerProvenance: verifiedProviderProvenance,
          delegationEvidenceDigest: delegation.evidenceDigest.toLowerCase(),
          delegationTransactionHash: wallet.delegationTransactionHash.toLowerCase(),
          route: input.route,
          settlementEvent: input.settlement.event,
          chainId: ARBITRUM_ONE_CHAIN_ID,
          checkoutAddress: this.config.checkoutAddress.toLowerCase(),
          settlementTransactionHash: base.order.transactionHash.toLowerCase(),
          settlementBlockNumber: base.order.blockNumber,
          settlementBlockHash: base.order.blockHash.toLowerCase(),
          settlementLogIndex: base.order.logIndex,
          receiptId: base.receipt.id,
          passTokenId: base.receipt.tokenId,
          recovery: input.recovery,
          timingMs: input.timingMs,
          payloadDigest: digest,
          attestationVersion: LIVE_ACCEPTANCE_ATTESTATION_VERSION,
          attestationMac,
          startedAt,
          capturedAt,
        })
        .onConflictDoNothing()
        .returning({ id: liveAcceptanceEvidence.id });
      if (inserted !== undefined) return { id: inserted.id, digest };
      const [existing] = await this.uow
        .current()
        .select({
          id: liveAcceptanceEvidence.id,
          digest: liveAcceptanceEvidence.payloadDigest,
          attestationVersion: liveAcceptanceEvidence.attestationVersion,
          attestationMac: liveAcceptanceEvidence.attestationMac,
        })
        .from(liveAcceptanceEvidence)
        .where(eq(liveAcceptanceEvidence.orderId, input.orderId))
        .limit(1);
      if (
        existing?.digest === digest &&
        existing.attestationVersion === LIVE_ACCEPTANCE_ATTESTATION_VERSION &&
        existing.attestationMac.toLowerCase() === attestationMac.toLowerCase()
      ) {
        return { id: existing.id, digest: existing.digest };
      }
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'This order is already bound to different live acceptance evidence.',
      );
    });
  }
}
