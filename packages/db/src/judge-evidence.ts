import type { CurrentUser, PublicJudgeProof } from '@opentab/shared';
import {
  AppError,
  acceptanceTimingPhaseMs,
  type EvidenceDigest,
  LiveAcceptanceEvidenceInputSchema,
  type OrderId,
  PublicJudgeProofSchema,
  sumAcceptanceTimingMs,
} from '@opentab/shared';
import { and, asc, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { hashOpaqueSecret, opaqueId, randomSecret } from './crypto.js';
import {
  createLiveAcceptancePayloadDigest,
  verifyLiveAcceptanceAttestation,
} from './live-acceptance-evidence.js';
import { parseCanonicalEventProof, type StoredDecodedEvent } from './projectors.js';
import {
  bootstrapGrants,
  canonicalLogs,
  delegationRecords,
  judgeEvidence,
  liveAcceptanceEvidence,
  merchants,
  orders,
  paymentAttempts,
  products,
  providerOperations,
  receipts,
  userIdentities,
  walletAccounts,
} from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

export interface JudgeEvidenceRuntimeConfig {
  readonly environment: 'local' | 'test' | 'preview' | 'staging' | 'demo-mainnet' | 'production';
  readonly checkoutAddress: CurrentUser['walletAddress'];
  readonly passAddress: CurrentUser['walletAddress'];
  readonly tokenAddress: CurrentUser['walletAddress'];
  readonly applicationVersion: string;
  readonly deploymentConfigDigest?: EvidenceDigest;
  readonly particleSdkVersion: string;
  readonly magicSdkVersion: string;
  readonly contractsVersion: string;
  readonly provenance: 'deterministic' | 'recorded_live' | 'live' | 'staging';
  readonly acceptanceAttestationSecret?: string;
}

function authorizeMerchant(actor: CurrentUser, merchantId: string): void {
  const member = actor.merchantMemberships.find((entry) => entry.merchantId === merchantId);
  if (member === undefined || !['owner', 'admin', 'operator'].includes(member.role)) {
    throw new AppError('AUTH_FORBIDDEN', 'You are not authorized to publish this evidence.');
  }
}

function publicEnvironment(
  value: JudgeEvidenceRuntimeConfig['environment'],
): PublicJudgeProof['environment'] {
  return value === 'test' ? 'local' : value;
}

function decodedFields(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const nested = payload.fields;
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Readonly<Record<string, unknown>>)
    : payload;
}

function requiredDecodedString(
  fields: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = fields[name];
  return typeof value === 'string' ? value : undefined;
}

function sameAddress(left: string | undefined, right: string): boolean {
  return left !== undefined && left.toLowerCase() === right.toLowerCase();
}

function claimEvidenceMarker(
  provenance: JudgeEvidenceRuntimeConfig['provenance'],
  evidenced: boolean,
): 'evidenced' | 'not_evidenced' | 'deterministic_fixture' {
  if (!evidenced) return 'not_evidenced';
  return provenance === 'deterministic' ? 'deterministic_fixture' : 'evidenced';
}

export class PostgresJudgeEvidenceManager {
  constructor(
    private readonly uow: PostgresUnitOfWork,
    private readonly shareTokenPepper: string,
    private readonly config: JudgeEvidenceRuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (shareTokenPepper.length < 32) throw new Error('Judge share token pepper is too short');
    if (
      (config.environment === 'demo-mainnet' || config.environment === 'production') &&
      (config.provenance === 'live' || config.provenance === 'recorded_live') &&
      !/^[0-9a-fA-F]{40}$/.test(config.applicationVersion)
    ) {
      throw new Error('Live Judge evidence requires an exact 40-hex application release ID');
    }
    if (
      config.acceptanceAttestationSecret !== undefined &&
      config.acceptanceAttestationSecret.length < 32
    ) {
      throw new Error('Live acceptance attestation secret is too short');
    }
    if (
      (config.environment === 'demo-mainnet' || config.environment === 'production') &&
      (config.provenance === 'live' || config.provenance === 'recorded_live') &&
      config.acceptanceAttestationSecret !== undefined &&
      config.deploymentConfigDigest === undefined
    ) {
      throw new Error('Live Judge evidence requires the current deployment configuration digest');
    }
  }

  async materialize(actor: CurrentUser, orderId: OrderId) {
    return this.uow.transaction(async () => {
      const lockedOrders = await this.uow
        .current()
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update');
      if (lockedOrders.length !== 1) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical order evidence is unavailable.');
      }

      const baseRecords = await this.uow
        .current()
        .select({
          order: orders,
          merchantOnchainId: merchants.onchainMerchantId,
          productMerchantId: products.merchantId,
          productOnchainId: products.onchainProductId,
        })
        .from(orders)
        .innerJoin(merchants, eq(merchants.id, orders.merchantId))
        .innerJoin(products, eq(products.id, orders.productId))
        .where(eq(orders.id, orderId));
      if (baseRecords.length !== 1) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical order evidence is unavailable.');
      }
      const record = baseRecords[0];
      if (record === undefined) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical order evidence is unavailable.');
      }
      authorizeMerchant(actor, record.order.merchantId);
      const orderTransactionHash = record.order.transactionHash;
      const orderBlockNumber = record.order.blockNumber;
      const orderBlockHash = record.order.blockHash;
      const orderLogIndex = record.order.logIndex;
      const orderConfirmedAt = record.order.confirmedAt;
      if (
        !['paid', 'partially_refunded', 'refunded'].includes(record.order.status) ||
        orderTransactionHash === null ||
        orderBlockNumber === null ||
        orderBlockHash === null ||
        orderLogIndex === null ||
        orderConfirmedAt === null
      ) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'The order is not canonically paid.');
      }

      const receiptRows = await this.uow
        .current()
        .select()
        .from(receipts)
        .where(eq(receipts.orderId, record.order.id));
      if (receiptRows.length !== 1) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical receipt evidence is unavailable.');
      }
      const receipt = receiptRows[0];
      if (
        receipt === undefined ||
        receipt.status !== 'issued' ||
        receipt.tokenId === null ||
        receipt.chainEventId === null ||
        receipt.issuedAt === null
      ) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'The canonical pass has not been issued yet.');
      }

      const paymentLogs = await this.uow
        .current()
        .select()
        .from(canonicalLogs)
        .where(
          and(
            eq(canonicalLogs.chainId, record.order.chainId),
            eq(canonicalLogs.contractAddress, this.config.checkoutAddress),
            eq(canonicalLogs.eventName, 'OrderPaid'),
            eq(canonicalLogs.transactionHash, orderTransactionHash),
            eq(canonicalLogs.blockNumber, orderBlockNumber),
            eq(canonicalLogs.blockHash, orderBlockHash),
            eq(canonicalLogs.logIndex, orderLogIndex),
            eq(canonicalLogs.canonical, true),
            eq(canonicalLogs.projectionStatus, 'applied'),
          ),
        );
      if (paymentLogs.length !== 1) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical payment evidence is unavailable.');
      }
      const paymentLog = paymentLogs[0];
      if (paymentLog === undefined) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical payment evidence is unavailable.');
      }

      const passLogs = await this.uow
        .current()
        .select()
        .from(canonicalLogs)
        .where(
          and(
            eq(canonicalLogs.id, receipt.chainEventId),
            eq(canonicalLogs.chainId, record.order.chainId),
            eq(canonicalLogs.contractAddress, this.config.passAddress),
            eq(canonicalLogs.eventName, 'TransferSingle'),
            eq(canonicalLogs.transactionHash, orderTransactionHash),
            eq(canonicalLogs.blockNumber, orderBlockNumber),
            eq(canonicalLogs.blockHash, orderBlockHash),
            eq(canonicalLogs.canonical, true),
            eq(canonicalLogs.projectionStatus, 'applied'),
          ),
        );
      if (passLogs.length !== 1) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical pass mint evidence is unavailable.');
      }
      const passLog = passLogs[0];
      if (passLog === undefined) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Canonical pass mint evidence is unavailable.');
      }

      const paymentPayload = paymentLog.decodedPayload;
      const normalizedPaymentFields = decodedFields(paymentPayload);
      const paymentFields = Object.fromEntries(
        Object.entries(normalizedPaymentFields).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      const decoded: StoredDecodedEvent = {
        eventName: 'OrderPaid',
        fields: paymentFields,
        decoderVersion:
          typeof paymentPayload.decoderVersion === 'string'
            ? paymentPayload.decoderVersion
            : 'legacy-canonical-record',
      };
      const confirmations =
        typeof paymentPayload.confirmations === 'string'
          ? BigInt(paymentPayload.confirmations)
          : 0n;
      const event = parseCanonicalEventProof(decoded, {
        chainId: paymentLog.chainId,
        contractAddress: paymentLog.contractAddress,
        transactionHash: paymentLog.transactionHash,
        blockNumber: paymentLog.blockNumber,
        blockHash: paymentLog.blockHash,
        logIndex: paymentLog.logIndex,
        confirmations,
        observedAt: paymentLog.observedAt,
      });
      if (event === undefined || event.eventName !== 'OrderPaid') {
        throw new AppError('PAYMENT_EVENT_MISMATCH', 'Canonical event evidence is invalid.');
      }
      const expectedRefundDeadline = (
        BigInt(record.order.refundableUntil.getTime()) / 1_000n
      ).toString();
      const passFields = decodedFields(passLog.decodedPayload);
      if (
        record.merchantOnchainId === null ||
        record.productMerchantId !== record.order.merchantId ||
        record.productOnchainId === null ||
        event.fields.orderKey.toLowerCase() !== record.order.orderKey.toLowerCase() ||
        event.fields.merchantOnchainId !== record.merchantOnchainId ||
        event.fields.productOnchainId !== record.productOnchainId ||
        !sameAddress(event.fields.payer, record.order.payer) ||
        !sameAddress(event.fields.recipient, record.order.recipient) ||
        !sameAddress(event.fields.token, record.order.tokenAddress) ||
        !sameAddress(event.fields.token, this.config.tokenAddress) ||
        event.fields.quantity !== record.order.quantity ||
        event.fields.amountBaseUnits !== record.order.paidAmountBaseUnits ||
        event.fields.intentDigest.toLowerCase() !== record.order.intentDigest.toLowerCase() ||
        event.fields.passTokenId !== receipt.tokenId ||
        event.fields.refundDeadline !== expectedRefundDeadline ||
        !sameAddress(requiredDecodedString(passFields, 'operator'), this.config.checkoutAddress) ||
        !/^0x0{40}$/i.test(requiredDecodedString(passFields, 'from') ?? '') ||
        !sameAddress(requiredDecodedString(passFields, 'to'), record.order.recipient) ||
        requiredDecodedString(passFields, 'id') !== receipt.tokenId ||
        requiredDecodedString(passFields, 'id') !== event.fields.passTokenId ||
        requiredDecodedString(passFields, 'value') !== record.order.quantity
      ) {
        throw new AppError('PAYMENT_EVENT_MISMATCH', 'Canonical event binding is invalid.');
      }

      const [identity] = await this.uow
        .current()
        .select({ authMethod: userIdentities.authMethod })
        .from(userIdentities)
        .where(
          and(eq(userIdentities.userId, record.order.userId), eq(userIdentities.provider, 'magic')),
        )
        .orderBy(desc(userIdentities.lastVerifiedAt), asc(userIdentities.id))
        .limit(1);
      if (identity === undefined) {
        throw new AppError('PAYMENT_NOT_CANONICAL', 'Magic identity evidence is unavailable.');
      }

      const walletRows = await this.uow
        .current()
        .select()
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.userId, record.order.userId),
            eq(walletAccounts.environment, this.config.environment),
          ),
        );
      if (walletRows.length > 1) {
        throw new AppError('INTERNAL_ERROR', 'Wallet evidence is ambiguous.');
      }
      const wallet = walletRows[0];
      let delegation: typeof delegationRecords.$inferSelect | undefined;
      if (
        wallet?.eip7702Enabled &&
        wallet.delegationStatus === 'confirmed' &&
        wallet.delegationTransactionHash !== null &&
        wallet.arbitrumImplementation !== null &&
        sameAddress(wallet.ownerAddressLower, record.order.payer) &&
        sameAddress(wallet.universalAccountAddressLower, record.order.payer) &&
        wallet.checkedAt <= orderConfirmedAt
      ) {
        const delegationRows = await this.uow
          .current()
          .select()
          .from(delegationRecords)
          .where(
            and(
              eq(delegationRecords.userId, record.order.userId),
              eq(delegationRecords.environment, this.config.environment),
              eq(delegationRecords.chainId, record.order.chainId),
              eq(delegationRecords.status, 'confirmed'),
              eq(delegationRecords.transactionHash, wallet.delegationTransactionHash),
              eq(delegationRecords.ownerAddressLower, wallet.ownerAddressLower),
              eq(delegationRecords.implementationAddressLower, wallet.arbitrumImplementation),
              eq(delegationRecords.evidenceDigest, wallet.evidenceDigest),
              isNotNull(delegationRecords.transactionHash),
              isNotNull(delegationRecords.blockNumber),
              isNotNull(delegationRecords.blockHash),
              lt(delegationRecords.blockNumber, orderBlockNumber),
              lte(delegationRecords.checkedAt, orderConfirmedAt),
            ),
          );
        if (delegationRows.length > 1) {
          throw new AppError('INTERNAL_ERROR', 'Delegation evidence is ambiguous.');
        }
        const candidate = delegationRows[0];
        if (
          candidate !== undefined &&
          candidate.blockNumber !== null &&
          candidate.blockNumber >= 0n &&
          candidate.blockNumber < orderBlockNumber &&
          candidate.checkedAt <= orderConfirmedAt
        ) {
          delegation = candidate;
        }
      }

      let attempt: typeof paymentAttempts.$inferSelect | undefined;
      if (record.order.providerOperationId !== null) {
        const attemptRows = await this.uow
          .current()
          .select()
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.orderId, record.order.id),
              eq(paymentAttempts.providerOperationId, record.order.providerOperationId),
              eq(paymentAttempts.status, 'paid'),
              eq(paymentAttempts.destinationTransactionHash, orderTransactionHash),
            ),
          );
        if (attemptRows.length > 1) {
          throw new AppError('INTERNAL_ERROR', 'Payment attempt evidence is ambiguous.');
        }
        attempt = attemptRows[0];
      }

      let providerOperation: typeof providerOperations.$inferSelect | undefined;
      if (attempt?.providerOperationId !== null && attempt?.providerOperationId !== undefined) {
        const providerRows = await this.uow
          .current()
          .select()
          .from(providerOperations)
          .where(
            and(
              eq(providerOperations.paymentAttemptId, attempt.id),
              eq(providerOperations.provider, 'particle'),
              eq(providerOperations.externalId, attempt.providerOperationId),
              eq(providerOperations.kind, 'checkout'),
              eq(providerOperations.status, 'succeeded'),
              eq(providerOperations.submissionPossible, true),
            ),
          );
        if (providerRows.length > 1) {
          throw new AppError('INTERNAL_ERROR', 'Provider operation evidence is ambiguous.');
        }
        const candidate = providerRows[0];
        if (
          candidate !== undefined &&
          candidate.destinationTransactionHash !== null &&
          candidate.destinationTransactionHash.toLowerCase() === orderTransactionHash.toLowerCase()
        ) {
          providerOperation = candidate;
        }
      }

      let acceptedEvidence: ReturnType<typeof LiveAcceptanceEvidenceInputSchema.parse> | undefined;
      const providerProvenance = providerOperation?.safeSummary.provenance;
      const providerEvidenceMatchesConfig = Boolean(
        providerOperation !== undefined &&
          providerProvenance === this.config.provenance &&
          providerOperation.safeSummary.environment === this.config.environment,
      );
      if (
        attempt !== undefined &&
        attempt.previewDigest !== null &&
        providerOperation !== undefined &&
        delegation?.transactionHash !== null &&
        delegation?.transactionHash !== undefined &&
        (this.config.environment === 'demo-mainnet' || this.config.environment === 'production') &&
        (providerProvenance === 'live' || providerProvenance === 'recorded_live') &&
        providerEvidenceMatchesConfig &&
        this.config.acceptanceAttestationSecret !== undefined
      ) {
        const acceptanceRows = await this.uow
          .current()
          .select()
          .from(liveAcceptanceEvidence)
          .where(
            and(
              eq(liveAcceptanceEvidence.environment, this.config.environment),
              eq(liveAcceptanceEvidence.releaseId, this.config.applicationVersion.toLowerCase()),
              eq(
                liveAcceptanceEvidence.deploymentConfigDigest,
                this.config.deploymentConfigDigest?.toLowerCase() ?? '',
              ),
              eq(liveAcceptanceEvidence.orderId, record.order.id),
              eq(liveAcceptanceEvidence.paymentAttemptId, attempt.id),
              eq(liveAcceptanceEvidence.providerOperationId, providerOperation.externalId),
              eq(liveAcceptanceEvidence.previewDigest, attempt.previewDigest.toLowerCase()),
              eq(
                liveAcceptanceEvidence.providerEvidenceDigest,
                providerOperation.evidenceDigest.toLowerCase(),
              ),
              eq(liveAcceptanceEvidence.providerProvenance, providerProvenance),
              eq(
                liveAcceptanceEvidence.delegationEvidenceDigest,
                delegation.evidenceDigest.toLowerCase(),
              ),
              eq(
                liveAcceptanceEvidence.delegationTransactionHash,
                delegation.transactionHash.toLowerCase(),
              ),
              eq(liveAcceptanceEvidence.chainId, event.chainId),
              eq(liveAcceptanceEvidence.checkoutAddress, event.contractAddress.toLowerCase()),
              eq(
                liveAcceptanceEvidence.settlementTransactionHash,
                event.transactionHash.toLowerCase(),
              ),
              eq(liveAcceptanceEvidence.settlementBlockNumber, BigInt(event.blockNumber)),
              eq(liveAcceptanceEvidence.settlementBlockHash, event.blockHash.toLowerCase()),
              eq(liveAcceptanceEvidence.settlementLogIndex, Number(event.logIndex)),
              eq(liveAcceptanceEvidence.receiptId, receipt.id),
              eq(liveAcceptanceEvidence.passTokenId, receipt.tokenId),
            ),
          );
        if (acceptanceRows.length > 1) {
          throw new AppError('INTERNAL_ERROR', 'Live acceptance evidence is ambiguous.');
        }
        const acceptance = acceptanceRows[0];
        if (
          acceptance !== undefined &&
          verifyLiveAcceptanceAttestation(
            this.config.acceptanceAttestationSecret,
            acceptance,
            acceptance.attestationVersion,
            acceptance.attestationMac,
          )
        ) {
          const [acceptanceIdentity] = await this.uow
            .current()
            .select({ authMethod: userIdentities.authMethod })
            .from(userIdentities)
            .where(
              and(
                eq(userIdentities.userId, record.order.userId),
                eq(userIdentities.provider, 'magic'),
                gte(userIdentities.lastVerifiedAt, acceptance.startedAt),
                lte(userIdentities.lastVerifiedAt, acceptance.capturedAt),
              ),
            )
            .orderBy(desc(userIdentities.lastVerifiedAt), asc(userIdentities.id))
            .limit(1);
          const providerSchemaVersion = Number(providerOperation.safeSummary.schemaVersion);
          const activationPath =
            acceptance.recovery.sponsorGrantCount === 1
              ? 'bootstrap_sponsor'
              : acceptance.recovery.delegationCount === 0
                ? 'already_delegated'
                : acceptance.recovery.delegationCount === 1
                  ? 'self_funded_type4'
                  : undefined;
          const sponsorRows =
            activationPath === 'bootstrap_sponsor'
              ? await this.uow
                  .current()
                  .select({ transactionHash: bootstrapGrants.transactionHash })
                  .from(bootstrapGrants)
                  .where(
                    and(
                      eq(bootstrapGrants.userId, record.order.userId),
                      eq(bootstrapGrants.environment, acceptance.environment),
                      eq(bootstrapGrants.status, 'confirmed'),
                      eq(bootstrapGrants.recipientAddressLower, record.order.payer),
                      isNotNull(bootstrapGrants.transactionHash),
                      isNotNull(bootstrapGrants.confirmedAt),
                      gte(bootstrapGrants.createdAt, acceptance.startedAt),
                      lte(bootstrapGrants.confirmedAt, orderConfirmedAt),
                    ),
                  )
                  .limit(2)
              : [];
          const sponsorTransactionHash =
            sponsorRows.length === 1 ? sponsorRows[0]?.transactionHash : undefined;
          const parsed = LiveAcceptanceEvidenceInputSchema.safeParse({
            schemaVersion: 1,
            environment: acceptance.environment,
            releaseId: acceptance.releaseId,
            deploymentConfigDigest: acceptance.deploymentConfigDigest,
            orderId: acceptance.orderId,
            paymentAttemptId: acceptance.paymentAttemptId,
            providerOperationId: acceptance.providerOperationId,
            providerOperation: {
              id: providerOperation.externalId,
              status: providerOperation.status,
              submissionPossible: providerOperation.submissionPossible,
              ...(providerOperation.destinationTransactionHash === null
                ? {}
                : { destinationTransactionHash: providerOperation.destinationTransactionHash }),
              ...(providerOperation.activityUrl === null
                ? {}
                : { activityUrl: providerOperation.activityUrl }),
              updatedAt: providerOperation.safeSummary.providerUpdatedAt,
              evidence: {
                adapter: providerOperation.safeSummary.adapter,
                packageVersion: providerOperation.safeSummary.packageVersion,
                schemaVersion: providerSchemaVersion,
                environment: providerOperation.safeSummary.environment,
                observedAt: providerOperation.safeSummary.finalObservedAt,
                evidenceDigest: providerOperation.evidenceDigest,
                provenance: providerOperation.safeSummary.provenance,
              },
            },
            context: {
              ownerAddress: record.order.payer,
              authMethod: acceptanceIdentity?.authMethod,
              activationPath,
              delegationTransactionHash: delegation.transactionHash,
              ...(sponsorTransactionHash === null || sponsorTransactionHash === undefined
                ? {}
                : { sponsorGrantTransactionHash: sponsorTransactionHash }),
              particleProtocolVersion: wallet?.protocolVersion,
              useEIP7702: true,
              safeAccountIdentifiers:
                wallet === undefined ? [] : [wallet.universalAccountAddressLower],
            },
            startedAt: acceptance.startedAt.toISOString(),
            route: acceptance.route,
            settlement: {
              event: acceptance.settlementEvent,
              receiptId: acceptance.receiptId,
              passTokenId: acceptance.passTokenId,
            },
            recovery: acceptance.recovery,
            timingMs: acceptance.timingMs,
            capturedAt: acceptance.capturedAt.toISOString(),
          });
          if (
            parsed.success &&
            createLiveAcceptancePayloadDigest({
              input: parsed.data,
              providerEvidenceDigest: providerOperation.evidenceDigest.toLowerCase(),
              providerProvenance,
              delegationEvidenceDigest: delegation.evidenceDigest.toLowerCase(),
              delegationTransactionHash: delegation.transactionHash.toLowerCase(),
            }) === acceptance.payloadDigest.toLowerCase() &&
            parsed.data.route.activityUrl === (providerOperation.activityUrl ?? undefined)
          ) {
            acceptedEvidence = parsed.data;
          }
        }
      }

      const capturedAt = this.now();
      const canonicalAt = record.order.confirmedAt ?? paymentLog.observedAt;
      const totalDuration =
        attempt === undefined
          ? 0
          : Math.max(0, canonicalAt.getTime() - attempt.createdAt.getTime());
      const submissionToCanonical =
        attempt?.submissionStartedAt === null || attempt?.submissionStartedAt === undefined
          ? undefined
          : Math.max(0, canonicalAt.getTime() - attempt.submissionStartedAt.getTime());
      const evidencedWallet = delegation === undefined ? undefined : wallet;
      const continuityEvidenced = evidencedWallet !== undefined;
      const submissionPersistenceEvidenced = Boolean(
        attempt !== undefined &&
          providerEvidenceMatchesConfig &&
          attempt.providerOperationId !== null &&
          attempt.preparedRootHashDigest !== null &&
          attempt.previewDigest !== null &&
          attempt.submissionStartedAt !== null,
      );
      const acceptedTiming =
        acceptedEvidence === undefined
          ? undefined
          : {
              authenticationMs: acceptanceTimingPhaseMs(acceptedEvidence.timingMs, [
                'magicAuthentication',
                'magicChallenge',
              ]),
              delegationMs: acceptanceTimingPhaseMs(acceptedEvidence.timingMs, [
                'readiness',
                'delegationActivation',
                'delegationVerification',
              ]),
              routePreparationMs: acceptanceTimingPhaseMs(acceptedEvidence.timingMs, [
                'particleInitialization',
                'balancePreflight',
                'passReceiverCompatibility',
                'checkoutBinding',
                'particlePreview',
                'magicRootSignature',
                'operationPersistence',
              ]),
              submissionToCanonicalMs: acceptanceTimingPhaseMs(acceptedEvidence.timingMs, [
                'particleSubmission',
                'canonicalArbitrumPayment',
              ]),
              recoveryVerificationMs: acceptanceTimingPhaseMs(acceptedEvidence.timingMs, [
                'restartRecovery',
              ]),
              totalDurationMs: sumAcceptanceTimingMs(acceptedEvidence.timingMs),
            };
      const existingEvidenceRows = await this.uow
        .current()
        .select({ evidenceId: judgeEvidence.evidenceId })
        .from(judgeEvidence)
        .where(eq(judgeEvidence.orderId, record.order.id));
      if (existingEvidenceRows.length > 1) {
        throw new AppError('INTERNAL_ERROR', 'Judge evidence identity is ambiguous.');
      }
      const evidenceId = existingEvidenceRows[0]?.evidenceId ?? opaqueId('evd');
      const proof = PublicJudgeProofSchema.parse({
        evidenceId,
        orderId: record.order.id,
        provenance: this.config.provenance,
        environment: publicEnvironment(this.config.environment),
        capturedAt: capturedAt.toISOString(),
        refreshedAt: capturedAt.toISOString(),
        versions: {
          application: this.config.applicationVersion,
          particleSdk: this.config.particleSdkVersion,
          magicSdk: this.config.magicSdkVersion,
          contracts: this.config.contractsVersion,
        },
        account: {
          magicEoaBefore: record.order.payer,
          magicEoaAfter: evidencedWallet?.ownerAddressLower ?? record.order.payer,
          addressContinuous: continuityEvidenced,
          continuityEvidence: claimEvidenceMarker(this.config.provenance, continuityEvidenced),
          authMethod: acceptedEvidence?.context.authMethod ?? identity.authMethod,
          ...(delegation === undefined
            ? {}
            : {
                delegationTarget: delegation.implementationAddressLower,
                delegationTransactionHash: delegation.transactionHash,
              }),
        },
        particle: {
          eip7702Enabled: continuityEvidenced,
          eip7702Evidence: claimEvidenceMarker(this.config.provenance, continuityEvidenced),
          universalAccountAddress:
            evidencedWallet?.universalAccountAddressLower ?? record.order.payer,
          routeEvidence: claimEvidenceMarker(
            this.config.provenance,
            acceptedEvidence !== undefined,
          ),
          sourceSummary: acceptedEvidence?.route.sources ?? [],
          ...(acceptedEvidence === undefined
            ? {}
            : {
                totalUsd: acceptedEvidence.route.totalUsd,
                estimatedFeeUsd: acceptedEvidence.route.estimatedFeeUsd,
                slippageBps: acceptedEvidence.route.slippageBps,
                quoteObservedAt: acceptedEvidence.route.quotedAt,
                previewDigest: acceptedEvidence.route.previewDigest,
              }),
          ...(!providerEvidenceMatchesConfig || providerOperation === undefined
            ? {}
            : { operationId: providerOperation.externalId }),
          ...(!providerEvidenceMatchesConfig ||
          providerOperation?.activityUrl === null ||
          providerOperation?.activityUrl === undefined
            ? {}
            : { activityUrl: providerOperation.activityUrl }),
        },
        settlement: {
          chainId: event.chainId,
          checkoutAddress: event.contractAddress,
          passAddress: passLog.contractAddress,
          tokenAddress: event.fields.token,
          amountBaseUnits: event.fields.amountBaseUnits,
          receiptId: receipt.id,
          passTokenId: receipt.tokenId,
          event,
        },
        recovery: {
          submissionPersistedBeforeWait: submissionPersistenceEvidenced,
          submissionPersistenceEvidence: claimEvidenceMarker(
            this.config.provenance,
            submissionPersistenceEvidenced,
          ),
          reloadRecovered: acceptedEvidence !== undefined,
          reloadRecoveryEvidence: claimEvidenceMarker(
            this.config.provenance,
            acceptedEvidence !== undefined,
          ),
          duplicatePrevented: acceptedEvidence !== undefined,
          duplicatePreventionEvidence: claimEvidenceMarker(
            this.config.provenance,
            acceptedEvidence !== undefined,
          ),
          timing:
            acceptedTiming === undefined
              ? {
                  ...(submissionToCanonical === undefined
                    ? {}
                    : { submissionToCanonicalMs: submissionToCanonical.toString() }),
                  totalDurationMs: totalDuration.toString(),
                }
              : {
                  ...(acceptedTiming.authenticationMs === undefined
                    ? {}
                    : { authenticationMs: acceptedTiming.authenticationMs }),
                  ...(acceptedTiming.delegationMs === undefined
                    ? {}
                    : { delegationMs: acceptedTiming.delegationMs }),
                  ...(acceptedTiming.routePreparationMs === undefined
                    ? {}
                    : { routePreparationMs: acceptedTiming.routePreparationMs }),
                  ...(acceptedTiming.submissionToCanonicalMs === undefined
                    ? {}
                    : {
                        submissionToCanonicalMs: acceptedTiming.submissionToCanonicalMs,
                      }),
                  ...(acceptedTiming.recoveryVerificationMs === undefined
                    ? {}
                    : {
                        recoveryVerificationMs: acceptedTiming.recoveryVerificationMs,
                      }),
                  totalDurationMs: acceptedTiming.totalDurationMs,
                },
        },
      });
      const proofDigest = createLiveAcceptancePayloadDigest(proof);
      if (existingEvidenceRows.length === 0) {
        // Deliberately avoid ON CONFLICT DO UPDATE here. PostgreSQL requires
        // UPDATE permission for that statement even when the insert does not
        // conflict, which would force the ordinary web role to hold authority
        // to rewrite immutable proof bytes. The outer idempotency boundary
        // recovers a concurrent first materialization; a direct retry is not
        // allowed to silently become a proof rewrite.
        await this.uow.current().insert(judgeEvidence).values({
          evidenceId: proof.evidenceId,
          orderId: proof.orderId,
          publicProof: proof,
          publicProofDigest: proofDigest,
          published: false,
          createdAt: capturedAt,
          updatedAt: capturedAt,
        });
      } else {
        // Rematerialization is an operator/migration credential operation. The
        // production web role is intentionally unable to execute this branch;
        // it can only create the first proof and rotate publication metadata.
        const [permission] = await this.uow.current().execute<{ canRematerialize: boolean }>(sql`
          select pg_catalog.has_column_privilege(
            current_user,
            proof_table.oid,
            'public_proof',
            'UPDATE'
          ) as "canRematerialize"
          from pg_catalog.pg_class proof_table
          inner join pg_catalog.pg_namespace proof_namespace
            on proof_namespace.oid = proof_table.relnamespace
          where proof_namespace.nspname = 'public'
            and proof_table.relname = 'judge_evidence'
            and proof_table.relkind in ('r', 'p')
        `);
        if (permission?.canRematerialize !== true) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Judge evidence already exists. Recover the original idempotent request or use the operator rematerialization path.',
          );
        }
        await this.uow
          .current()
          .update(judgeEvidence)
          .set({
            publicProof: proof,
            publicProofDigest: proofDigest,
            published: false,
            shareTokenHash: null,
            expiresAt: null,
            revokedAt: null,
            updatedAt: capturedAt,
          })
          .where(eq(judgeEvidence.orderId, proof.orderId));
      }
      return { proof, status: 'unpublished' as const };
    });
  }

  async publish(
    actor: CurrentUser,
    orderId: OrderId,
    input: { protected: boolean; expiresAt?: string },
  ) {
    const [order] = await this.uow
      .current()
      .select({ merchantId: orders.merchantId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (order === undefined) throw new AppError('NOT_FOUND', 'The order was not found.');
    authorizeMerchant(actor, order.merchantId);
    const expiresAt = input.expiresAt === undefined ? undefined : new Date(input.expiresAt);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      throw new AppError('VALIDATION_FAILED', 'Judge evidence expiry must be in the future.');
    }
    const shareToken = input.protected ? randomSecret(32) : undefined;
    const [updated] = await this.uow
      .current()
      .update(judgeEvidence)
      .set({
        published: true,
        shareTokenHash:
          shareToken === undefined
            ? null
            : hashOpaqueSecret({
                domain: 'judge-share-token',
                pepper: this.shareTokenPepper,
                value: shareToken,
              }),
        ...(expiresAt === undefined ? { expiresAt: null } : { expiresAt }),
        revokedAt: null,
        updatedAt: this.now(),
      })
      .where(eq(judgeEvidence.orderId, orderId))
      .returning({ evidenceId: judgeEvidence.evidenceId });
    if (updated === undefined)
      throw new AppError('NOT_FOUND', 'Materialize Judge evidence before publishing it.');
    return {
      evidenceId: updated.evidenceId,
      status: 'published' as const,
      protected: input.protected,
      ...(shareToken === undefined ? {} : { shareToken }),
      ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
    };
  }

  async revoke(actor: CurrentUser, orderId: OrderId) {
    const [order] = await this.uow
      .current()
      .select({ merchantId: orders.merchantId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (order === undefined) throw new AppError('NOT_FOUND', 'The order was not found.');
    authorizeMerchant(actor, order.merchantId);
    const [updated] = await this.uow
      .current()
      .update(judgeEvidence)
      .set({
        published: false,
        shareTokenHash: null,
        revokedAt: this.now(),
        updatedAt: this.now(),
      })
      .where(eq(judgeEvidence.orderId, orderId))
      .returning({ evidenceId: judgeEvidence.evidenceId });
    if (updated === undefined) throw new AppError('NOT_FOUND', 'Judge evidence was not found.');
    return { evidenceId: updated.evidenceId, status: 'revoked' as const };
  }
}
