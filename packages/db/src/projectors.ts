import { type CanonicalEventProof, CanonicalEventProofSchema } from '@opentab/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { opaqueId } from './crypto.js';
import {
  canonicalLogs,
  contractOperations,
  loyaltyAwards,
  loyaltyBalances,
  loyaltyPrograms,
  merchants,
  orders,
  outboxEvents,
  paymentAttempts,
  products,
  receipts,
  refunds,
  settlementCredits,
  signedOrderIntents,
  splitInvitations,
  splitParticipants,
  splitPayments,
  splits,
  users,
  withdrawals,
} from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

export interface StoredDecodedEvent {
  readonly eventName: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly decoderVersion: string;
}

export interface StoredEventPosition {
  readonly chainId: string;
  readonly contractAddress: string;
  readonly transactionHash: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly logIndex: number;
  readonly confirmations: bigint;
  readonly observedAt: Date;
}

function positionFromProof(proof: CanonicalEventProof): StoredEventPosition {
  return {
    chainId: proof.chainId,
    contractAddress: proof.contractAddress,
    transactionHash: proof.transactionHash,
    blockNumber: BigInt(proof.blockNumber),
    blockHash: proof.blockHash,
    logIndex: Number(proof.logIndex),
    confirmations: BigInt(proof.confirmations),
    observedAt: new Date(proof.observedAt),
  };
}

export type ProjectionResult =
  | { readonly kind: 'applied' }
  | {
      readonly kind: 'quarantined';
      readonly reasonCode: string;
      readonly safeDetails: Readonly<Record<string, string>>;
    };

function required(fields: Readonly<Record<string, string>>, key: string): string {
  const value = fields[key];
  if (value === undefined) throw new Error(`Decoded event is missing ${key}`);
  return value;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function seconds(date: Date): string {
  return (BigInt(date.getTime()) / 1_000n).toString();
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function operationExpectation(eventName: string): { kind: string; action?: string } | undefined {
  switch (eventName) {
    case 'MerchantCreated':
      return { kind: 'merchant_mutation', action: 'create_merchant' };
    case 'MerchantPayoutUpdated':
      return { kind: 'merchant_mutation', action: 'update_merchant_payout' };
    case 'MerchantMetadataUpdated':
      return { kind: 'merchant_mutation', action: 'update_merchant_metadata' };
    case 'MerchantStatusChanged':
      return { kind: 'merchant_mutation', action: 'set_merchant_active' };
    case 'ProductCreated':
      return { kind: 'product_mutation', action: 'create_product' };
    case 'ProductUpdated':
      return { kind: 'product_mutation', action: 'update_product' };
    case 'ProductStatusChanged':
      return { kind: 'product_mutation', action: 'set_product_active' };
    case 'OrderRefunded':
      return { kind: 'refund' };
    case 'MerchantWithdrawal':
      return { kind: 'withdrawal' };
    case 'SplitReimbursed':
      return { kind: 'split_reimbursement' };
    case 'SplitPaymentRevoked':
      return { kind: 'split_revocation' };
    default:
      return undefined;
  }
}

export function selectOperationForCanonicalTransaction<
  T extends { readonly transactionHash: string | null; readonly status?: string },
>(candidates: readonly T[], transactionHash: string): T | undefined {
  const exact = candidates.filter((candidate) => candidate.transactionHash === transactionHash);
  if (exact.length === 1) return exact[0];
  const retryable = candidates.filter(
    (candidate) => candidate.transactionHash === null || candidate.status === 'orphaned',
  );
  return exact.length === 0 && candidates.length === 1 && retryable.length === 1
    ? retryable[0]
    : undefined;
}

type OrderPaidProof = Extract<CanonicalEventProof, { eventName: 'OrderPaid' }>;
type SplitReimbursedProof = Extract<CanonicalEventProof, { eventName: 'SplitReimbursed' }>;

export interface ExpectedOrderPaidProjection {
  readonly merchantOnchainId: string | null;
  readonly productOnchainId: string | null;
  readonly payer: string;
  readonly recipient: string;
  readonly token: string;
  readonly quantity: string;
  readonly amountBaseUnits: string;
  readonly platformFeeBaseUnits: string | undefined;
  readonly intentDigest: string;
  readonly refundDeadline: string;
}

export function findOrderPaidMismatches(
  expected: ExpectedOrderPaidProjection,
  proof: OrderPaidProof,
): readonly string[] {
  return [
    expected.merchantOnchainId !== proof.fields.merchantOnchainId ? 'merchant' : undefined,
    expected.productOnchainId !== proof.fields.productOnchainId ? 'product' : undefined,
    !sameAddress(expected.payer, proof.fields.payer) ? 'payer' : undefined,
    !sameAddress(expected.recipient, proof.fields.recipient) ? 'recipient' : undefined,
    !sameAddress(expected.token, proof.fields.token) ? 'token' : undefined,
    expected.quantity !== proof.fields.quantity ? 'quantity' : undefined,
    expected.amountBaseUnits !== proof.fields.amountBaseUnits ? 'amount' : undefined,
    expected.intentDigest.toLowerCase() !== proof.fields.intentDigest.toLowerCase()
      ? 'intentDigest'
      : undefined,
    expected.refundDeadline !== proof.fields.refundDeadline ? 'refundDeadline' : undefined,
    expected.platformFeeBaseUnits !== proof.fields.platformFeeBaseUnits ? 'platformFee' : undefined,
  ].filter((value): value is string => value !== undefined);
}

export interface ExpectedSplitReimbursementProjection {
  readonly paymentKey: string;
  readonly splitDigest: string | null;
  readonly originalOrderKey: string | null;
  readonly orderKey: string;
  readonly payer: string;
  readonly beneficiary: string;
  readonly token: string | null;
  readonly amountBaseUnits: string;
  readonly intentDigest: string | null;
}

export function findSplitReimbursementMismatches(
  expected: ExpectedSplitReimbursementProjection,
  proof: SplitReimbursedProof,
): readonly string[] {
  return [
    expected.paymentKey.toLowerCase() !== proof.fields.paymentKey.toLowerCase()
      ? 'paymentKey'
      : undefined,
    expected.splitDigest?.toLowerCase() !== proof.fields.splitDigest.toLowerCase()
      ? 'splitDigest'
      : undefined,
    expected.originalOrderKey?.toLowerCase() !== proof.fields.originalOrderKey.toLowerCase()
      ? 'storedOriginalOrderKey'
      : undefined,
    expected.orderKey.toLowerCase() !== proof.fields.originalOrderKey.toLowerCase()
      ? 'orderKey'
      : undefined,
    !sameAddress(expected.payer, proof.fields.payer) ? 'payer' : undefined,
    !sameAddress(expected.beneficiary, proof.fields.beneficiary) ? 'beneficiary' : undefined,
    !sameAddress(expected.token ?? '', proof.fields.token) ? 'token' : undefined,
    expected.amountBaseUnits !== proof.fields.amountBaseUnits ? 'amount' : undefined,
    expected.intentDigest?.toLowerCase() !== proof.fields.intentDigest.toLowerCase()
      ? 'intentDigest'
      : undefined,
  ].filter((value): value is string => value !== undefined);
}

export interface RefundProjectionInput {
  readonly paidAmountBaseUnits: string;
  readonly previouslyRefundedBaseUnits: string;
  readonly refundAmountBaseUnits: string;
  readonly cumulativeRefundedBaseUnits: string;
  readonly signedPlatformFeeBaseUnits: string;
  readonly platformFeeRefundedBaseUnits: string;
  readonly merchantCreditBaseUnits: string;
}

export type RefundProjectionDecision =
  | {
      readonly kind: 'apply';
      readonly merchantRefundBaseUnits: string;
      readonly remainingMerchantCreditBaseUnits: string;
    }
  | { readonly kind: 'mismatch'; readonly fields: readonly string[] };

export function evaluateRefundProjection(input: RefundProjectionInput): RefundProjectionDecision {
  const paid = BigInt(input.paidAmountBaseUnits);
  const previous = BigInt(input.previouslyRefundedBaseUnits);
  const amount = BigInt(input.refundAmountBaseUnits);
  const cumulative = BigInt(input.cumulativeRefundedBaseUnits);
  const fee = BigInt(input.signedPlatformFeeBaseUnits);
  const actualFeeDelta = BigInt(input.platformFeeRefundedBaseUnits);
  const merchantCredit = BigInt(input.merchantCreditBaseUnits);
  const expectedFeeBefore = paid === 0n ? 0n : (fee * previous) / paid;
  const expectedFeeAfter = paid === 0n ? 0n : (fee * cumulative) / paid;
  const expectedFeeDelta = expectedFeeAfter - expectedFeeBefore;
  const merchantRefund = amount - actualFeeDelta;
  const mismatches = [
    amount <= 0n ? 'amount' : undefined,
    paid <= 0n ? 'paidAmount' : undefined,
    cumulative !== previous + amount ? 'cumulativeRefunded' : undefined,
    cumulative > paid ? 'refundExceedsPaid' : undefined,
    actualFeeDelta !== expectedFeeDelta ? 'platformFeeRefunded' : undefined,
    merchantRefund < 0n || merchantRefund > merchantCredit ? 'merchantCredit' : undefined,
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) return { kind: 'mismatch', fields: mismatches };
  return {
    kind: 'apply',
    merchantRefundBaseUnits: merchantRefund.toString(),
    remainingMerchantCreditBaseUnits: (merchantCredit - merchantRefund).toString(),
  };
}

export function expectedFinalizationCredits(input: {
  readonly paidAmountBaseUnits: string;
  readonly refundedAmountBaseUnits: string;
  readonly signedPlatformFeeBaseUnits: string;
}): { readonly merchantBaseUnits: string; readonly platformBaseUnits: string } {
  const paid = BigInt(input.paidAmountBaseUnits);
  const refunded = BigInt(input.refundedAmountBaseUnits);
  const fee = BigInt(input.signedPlatformFeeBaseUnits);
  if (paid <= 0n || refunded < 0n || refunded > paid || fee < 0n || fee > paid) {
    throw new RangeError('Finalization inputs are outside the paid-order accounting bounds');
  }
  const refundedFee = (fee * refunded) / paid;
  const platform = fee - refundedFee;
  return {
    merchantBaseUnits: (paid - refunded - platform).toString(),
    platformBaseUnits: platform.toString(),
  };
}

export interface WithdrawalCredit {
  readonly id: string;
  readonly amountBaseUnits: string;
  readonly withdrawnBaseUnits: string;
}

export interface WithdrawalDebit {
  readonly creditId: string;
  readonly debitBaseUnits: string;
  readonly withdrawnBaseUnits: string;
  readonly fullyWithdrawn: boolean;
}

export function planWithdrawalDebits(
  credits: readonly WithdrawalCredit[],
  requestedBaseUnits: string,
): readonly WithdrawalDebit[] | undefined {
  let remaining = BigInt(requestedBaseUnits);
  if (remaining <= 0n) return undefined;
  const available = credits.reduce(
    (sum, credit) => sum + BigInt(credit.amountBaseUnits) - BigInt(credit.withdrawnBaseUnits),
    0n,
  );
  if (available < remaining) return undefined;
  const debits: WithdrawalDebit[] = [];
  for (const credit of credits) {
    if (remaining === 0n) break;
    const amount = BigInt(credit.amountBaseUnits);
    const previouslyWithdrawn = BigInt(credit.withdrawnBaseUnits);
    const creditAvailable = amount - previouslyWithdrawn;
    const debit = creditAvailable < remaining ? creditAvailable : remaining;
    if (debit <= 0n) continue;
    const withdrawn = previouslyWithdrawn + debit;
    debits.push({
      creditId: credit.id,
      debitBaseUnits: debit.toString(),
      withdrawnBaseUnits: withdrawn.toString(),
      fullyWithdrawn: withdrawn === amount,
    });
    remaining -= debit;
  }
  return debits;
}

export function parseCanonicalEventProof(
  decoded: StoredDecodedEvent,
  position: StoredEventPosition,
): CanonicalEventProof | undefined {
  const base = {
    eventName: decoded.eventName,
    chainId: position.chainId,
    contractAddress: position.contractAddress,
    transactionHash: position.transactionHash,
    blockNumber: position.blockNumber.toString(),
    blockHash: position.blockHash,
    logIndex: position.logIndex.toString(),
    confirmations: position.confirmations.toString(),
    canonical: true,
    observedAt: position.observedAt.toISOString(),
  };
  const fields = decoded.fields;
  const candidate = (() => {
    try {
      switch (decoded.eventName) {
        case 'OrderPaid':
          return {
            ...base,
            fields: {
              orderKey: required(fields, 'orderKey'),
              merchantOnchainId: required(fields, 'merchantId'),
              productOnchainId: required(fields, 'productId'),
              payer: required(fields, 'payer'),
              recipient: required(fields, 'recipient'),
              token: required(fields, 'token'),
              quantity: required(fields, 'quantity'),
              amountBaseUnits: required(fields, 'amount'),
              platformFeeBaseUnits: required(fields, 'platformFee'),
              intentDigest: required(fields, 'intentDigest'),
              passTokenId: required(fields, 'passTokenId'),
              refundDeadline: required(fields, 'refundDeadline'),
            },
          };
        case 'OrderRefunded':
          return {
            ...base,
            fields: {
              orderKey: required(fields, 'orderKey'),
              amountBaseUnits: required(fields, 'amount'),
              cumulativeRefundedBaseUnits: required(fields, 'cumulativeRefunded'),
            },
          };
        case 'OrderFinalized':
          return {
            ...base,
            fields: {
              orderKey: required(fields, 'orderKey'),
              merchantOnchainId: required(fields, 'merchantId'),
              merchantCreditBaseUnits: required(fields, 'merchantCredit'),
              platformCreditBaseUnits: required(fields, 'platformCredit'),
            },
          };
        case 'MerchantWithdrawal':
          return {
            ...base,
            fields: {
              merchantOnchainId: required(fields, 'merchantId'),
              recipient: required(fields, 'payout'),
              amountBaseUnits: required(fields, 'amount'),
            },
          };
        case 'SplitReimbursed':
          return {
            ...base,
            fields: {
              paymentKey: required(fields, 'paymentKey'),
              splitDigest: required(fields, 'splitDigest'),
              originalOrderKey: required(fields, 'originalOrderKey'),
              payer: required(fields, 'payer'),
              beneficiary: required(fields, 'beneficiary'),
              token: required(fields, 'token'),
              amountBaseUnits: required(fields, 'amount'),
              intentDigest: required(fields, 'intentDigest'),
            },
          };
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  })();
  if (candidate === undefined) return undefined;
  const parsed = CanonicalEventProofSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export class PostgresCanonicalProjector {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async apply(input: {
    canonicalLogId: string;
    decoded: StoredDecodedEvent;
    position: StoredEventPosition;
  }): Promise<ProjectionResult> {
    const proof = parseCanonicalEventProof(input.decoded, input.position);
    if (
      [
        'OrderPaid',
        'OrderRefunded',
        'OrderFinalized',
        'MerchantWithdrawal',
        'SplitReimbursed',
      ].includes(input.decoded.eventName) &&
      proof === undefined
    ) {
      return {
        kind: 'quarantined',
        reasonCode: 'CANONICAL_EVENT_SCHEMA_INVALID',
        safeDetails: {
          eventName: input.decoded.eventName,
          decoderVersion: input.decoded.decoderVersion,
        },
      };
    }

    switch (input.decoded.eventName) {
      case 'MerchantCreated':
        return this.#merchantCreated(input.decoded, input.position);
      case 'MerchantPayoutUpdated':
        return this.#merchantPayoutUpdated(input.decoded, input.position);
      case 'MerchantStatusChanged':
        return this.#merchantStatusChanged(input.decoded, input.position);
      case 'MerchantSuspensionChanged':
        return this.#merchantSuspensionChanged(input.decoded, input.position);
      case 'MerchantMetadataUpdated':
        return this.#merchantMetadataUpdated(input.decoded, input.position);
      case 'ProductCreated':
      case 'ProductUpdated':
        return this.#productUpsert(input.decoded, input.position);
      case 'ProductStatusChanged':
        return this.#productStatusChanged(input.decoded, input.position);
      case 'OrderPaid':
        return this.#orderPaid(
          input.canonicalLogId,
          proof as Extract<CanonicalEventProof, { eventName: 'OrderPaid' }>,
        );
      case 'OrderRefunded':
        return this.#orderRefunded(
          input.canonicalLogId,
          proof as Extract<CanonicalEventProof, { eventName: 'OrderRefunded' }>,
          input.decoded,
        );
      case 'OrderFinalized':
        return this.#orderFinalized(
          input.canonicalLogId,
          proof as Extract<CanonicalEventProof, { eventName: 'OrderFinalized' }>,
        );
      case 'MerchantWithdrawal':
        return this.#merchantWithdrawal(
          input.canonicalLogId,
          proof as Extract<CanonicalEventProof, { eventName: 'MerchantWithdrawal' }>,
          input.decoded,
        );
      case 'LoyaltyAwarded':
        return this.#loyaltyAwarded(input.canonicalLogId, input.decoded, input.position);
      case 'LoyaltyAdjusted':
        return this.#loyaltyAdjusted(input.decoded, input.position);
      case 'TransferSingle':
        return this.#passTransfer(input.canonicalLogId, input.decoded, input.position);
      case 'PassRevoked':
        return this.#passRevoked(input.decoded, input.position);
      case 'ProductPassConfigured':
        return { kind: 'applied' };
      case 'SplitReimbursed':
        return this.#splitReimbursed(
          input.canonicalLogId,
          proof as Extract<CanonicalEventProof, { eventName: 'SplitReimbursed' }>,
        );
      case 'SplitPaymentRevoked':
        return this.#splitPaymentRevoked(input.decoded, input.position);
      case 'FeeRecipientUpdated':
      case 'PlatformFeeUpdated':
      case 'PlatformWithdrawal':
      case 'CheckoutBound':
      case 'ApprovalForAll':
      case 'URI':
      case 'Paused':
      case 'Unpaused':
      case 'RoleAdminChanged':
      case 'RoleGranted':
      case 'RoleRevoked':
      case 'DefaultAdminDelayChangeCanceled':
      case 'DefaultAdminDelayChangeScheduled':
      case 'DefaultAdminTransferCanceled':
      case 'DefaultAdminTransferScheduled':
      case 'EIP712DomainChanged':
        return { kind: 'applied' };
      default:
        return {
          kind: 'quarantined',
          reasonCode: 'EVENT_HANDLER_UNKNOWN',
          safeDetails: { eventName: input.decoded.eventName },
        };
    }
  }

  async #merchantCreated(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const owner = required(fields, 'owner');
    const payout = required(fields, 'payout');
    const metadataHash = required(fields, 'metadataHash');
    const candidates = await this.uow
      .current()
      .select({ id: merchants.id })
      .from(merchants)
      .innerJoin(users, eq(users.id, merchants.ownerUserId))
      .where(
        and(
          isNull(merchants.onchainMerchantId),
          sql`lower(${users.walletAddressLower}) = ${owner.toLowerCase()}`,
          sql`lower(${merchants.payoutAddressLower}) = ${payout.toLowerCase()}`,
        ),
      )
      .limit(2);
    if (candidates.length !== 1) {
      return {
        kind: 'quarantined',
        reasonCode: candidates.length === 0 ? 'MERCHANT_NOT_FOUND' : 'MERCHANT_AMBIGUOUS',
        safeDetails: { merchantOnchainId: required(fields, 'merchantId') },
      };
    }
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error('Merchant candidate disappeared');
    await this.uow
      .current()
      .update(merchants)
      .set({
        onchainMerchantId: required(fields, 'merchantId'),
        payoutAddress: payout,
        payoutAddressLower: payout.toLowerCase(),
        profile: {
          chainMetadataHash: metadataHash,
          chainActive: 'true',
          chainSuspended: 'false',
        },
        status: 'active',
        chainSyncStatus: 'confirmed',
        updatedAt: position.observedAt,
        version: sql`${merchants.version} + 1`,
      })
      .where(eq(merchants.id, candidate.id));
    await this.#confirmContractOperation('merchant', candidate.id, decoded.eventName, position);
    return { kind: 'applied' };
  }

  async #merchantPayoutUpdated(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const [updated] = await this.uow
      .current()
      .update(merchants)
      .set({
        payoutAddress: required(fields, 'newPayout'),
        payoutAddressLower: required(fields, 'newPayout').toLowerCase(),
        updatedAt: position.observedAt,
        version: sql`${merchants.version} + 1`,
      })
      .where(eq(merchants.onchainMerchantId, required(fields, 'merchantId')))
      .returning({ id: merchants.id });
    if (updated !== undefined) {
      await this.#confirmContractOperation('merchant', updated.id, decoded.eventName, position);
    }
    return updated === undefined
      ? {
          kind: 'quarantined',
          reasonCode: 'MERCHANT_NOT_FOUND',
          safeDetails: { merchantOnchainId: required(fields, 'merchantId') },
        }
      : { kind: 'applied' };
  }

  async #merchantStatusChanged(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const [record] = await this.uow
      .current()
      .select({ id: merchants.id, profile: merchants.profile })
      .from(merchants)
      .where(eq(merchants.onchainMerchantId, required(fields, 'merchantId')))
      .limit(1);
    if (record === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'MERCHANT_NOT_FOUND',
        safeDetails: { merchantOnchainId: required(fields, 'merchantId') },
      };
    }
    const active = required(fields, 'active') === 'true';
    const suspended = record.profile['chainSuspended'] === 'true';
    const [updated] = await this.uow
      .current()
      .update(merchants)
      .set({
        status: active && !suspended ? 'active' : 'paused',
        profile: { ...record.profile, chainActive: active ? 'true' : 'false' },
        chainSyncStatus: 'confirmed',
        updatedAt: position.observedAt,
        version: sql`${merchants.version} + 1`,
      })
      .where(eq(merchants.id, record.id))
      .returning({ id: merchants.id });
    if (updated !== undefined) {
      await this.#confirmContractOperation('merchant', updated.id, decoded.eventName, position);
    }
    return updated === undefined
      ? {
          kind: 'quarantined',
          reasonCode: 'MERCHANT_NOT_FOUND',
          safeDetails: { merchantOnchainId: required(fields, 'merchantId') },
        }
      : { kind: 'applied' };
  }

  async #merchantSuspensionChanged(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const [record] = await this.uow
      .current()
      .select({ id: merchants.id, profile: merchants.profile })
      .from(merchants)
      .where(eq(merchants.onchainMerchantId, required(fields, 'merchantId')))
      .limit(1);
    if (record === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'MERCHANT_NOT_FOUND',
        safeDetails: { merchantOnchainId: required(fields, 'merchantId') },
      };
    }
    const suspended = required(fields, 'suspended') === 'true';
    const active = record.profile['chainActive'] !== 'false';
    await this.uow
      .current()
      .update(merchants)
      .set({
        status: active && !suspended ? 'active' : 'paused',
        profile: { ...record.profile, chainSuspended: suspended ? 'true' : 'false' },
        chainSyncStatus: 'confirmed',
        updatedAt: position.observedAt,
        version: sql`${merchants.version} + 1`,
      })
      .where(eq(merchants.id, record.id));
    return { kind: 'applied' };
  }

  async #merchantMetadataUpdated(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const [record] = await this.uow
      .current()
      .select({ id: merchants.id, profile: merchants.profile })
      .from(merchants)
      .where(eq(merchants.onchainMerchantId, required(fields, 'merchantId')))
      .limit(1);
    if (record === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'MERCHANT_NOT_FOUND',
        safeDetails: { merchantOnchainId: required(fields, 'merchantId') },
      };
    }
    const previous = record.profile['chainMetadataHash'];
    if (previous !== undefined && previous !== required(fields, 'previousMetadataHash')) {
      return {
        kind: 'quarantined',
        reasonCode: 'MERCHANT_METADATA_MISMATCH',
        safeDetails: { merchantId: record.id },
      };
    }
    await this.uow
      .current()
      .update(merchants)
      .set({
        profile: { ...record.profile, chainMetadataHash: required(fields, 'newMetadataHash') },
        chainSyncStatus: 'confirmed',
        updatedAt: position.observedAt,
        version: sql`${merchants.version} + 1`,
      })
      .where(eq(merchants.id, record.id));
    await this.#confirmContractOperation('merchant', record.id, decoded.eventName, position);
    return { kind: 'applied' };
  }

  async #productUpsert(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const merchantOnchainId = required(fields, 'merchantId');
    const [merchant] = await this.uow
      .current()
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.onchainMerchantId, merchantOnchainId))
      .limit(1);
    if (merchant === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'MERCHANT_NOT_FOUND',
        safeDetails: { merchantOnchainId },
      };
    }
    const productOnchainId = required(fields, 'productId');
    let [product] = await this.uow
      .current()
      .select({ id: products.id, merchantId: products.merchantId, status: products.status })
      .from(products)
      .where(eq(products.onchainProductId, productOnchainId))
      .limit(1);
    if (product === undefined && decoded.eventName === 'ProductCreated') {
      const candidates = await this.uow
        .current()
        .select({ id: products.id, merchantId: products.merchantId, status: products.status })
        .from(products)
        .where(
          and(
            eq(products.merchantId, merchant.id),
            isNull(products.onchainProductId),
            eq(products.metadataHash, required(fields, 'metadataHash')),
          ),
        )
        .limit(2);
      if (candidates.length === 1) product = candidates[0];
    }
    if (product === undefined || product.merchantId !== merchant.id) {
      return {
        kind: 'quarantined',
        reasonCode: 'PRODUCT_NOT_FOUND',
        safeDetails: { productOnchainId },
      };
    }
    const startsAt = new Date(Number(BigInt(required(fields, 'startsAt')) * 1_000n));
    const ends = BigInt(required(fields, 'endsAt'));
    const maxSupply = required(fields, 'maxSupply');
    await this.uow
      .current()
      .update(products)
      .set({
        onchainProductId: productOnchainId,
        version: Number(required(fields, 'version')),
        unitPriceBaseUnits: required(fields, 'unitPrice'),
        startsAt,
        endsAt: ends === 0n ? null : new Date(Number(ends * 1_000n)),
        maxSupply: maxSupply === '0' ? null : maxSupply,
        maxPerOrder: required(fields, 'maxPerWallet'),
        loyaltyPoints: required(fields, 'loyaltyPoints'),
        refundWindowSeconds: required(fields, 'refundWindow'),
        metadataHash: required(fields, 'metadataHash'),
        status: decoded.eventName === 'ProductCreated' ? 'publishing' : product.status,
        chainSyncStatus: 'confirmed',
        sourceBlockNumber: position.blockNumber,
        sourceBlockHash: position.blockHash,
        updatedAt: position.observedAt,
      })
      .where(eq(products.id, product.id));
    await this.#confirmContractOperation('product', product.id, decoded.eventName, position);
    return { kind: 'applied' };
  }

  async #productStatusChanged(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const [updated] = await this.uow
      .current()
      .update(products)
      .set({
        status: required(fields, 'active') === 'true' ? 'active' : 'paused',
        chainSyncStatus: 'confirmed',
        sourceBlockNumber: position.blockNumber,
        sourceBlockHash: position.blockHash,
        updatedAt: position.observedAt,
      })
      .where(eq(products.onchainProductId, required(fields, 'productId')))
      .returning({ id: products.id });
    if (updated !== undefined) {
      await this.#confirmContractOperation('product', updated.id, decoded.eventName, position);
    }
    return updated === undefined
      ? {
          kind: 'quarantined',
          reasonCode: 'PRODUCT_NOT_FOUND',
          safeDetails: { productOnchainId: required(fields, 'productId') },
        }
      : { kind: 'applied' };
  }

  async #orderPaid(
    canonicalLogId: string,
    proof: Extract<CanonicalEventProof, { eventName: 'OrderPaid' }>,
  ): Promise<ProjectionResult> {
    const [order] = await this.uow
      .current()
      .select({
        order: orders,
        productOnchainId: products.onchainProductId,
        productMetadataHash: products.metadataHash,
        merchantOnchainId: merchants.onchainMerchantId,
      })
      .from(orders)
      .innerJoin(products, eq(products.id, orders.productId))
      .innerJoin(merchants, eq(merchants.id, orders.merchantId))
      .where(eq(orders.orderKey, proof.fields.orderKey))
      .for('update')
      .limit(1);
    if (order === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'ORDER_NOT_FOUND',
        safeDetails: { orderKey: proof.fields.orderKey },
      };
    }
    const [intent] = await this.uow
      .current()
      .select({ intent: signedOrderIntents.intent })
      .from(signedOrderIntents)
      .where(eq(signedOrderIntents.orderKey, order.order.orderKey))
      .limit(1);
    const expectedFee = intent?.intent['platformFeeBaseUnits'];
    const mismatches = findOrderPaidMismatches(
      {
        merchantOnchainId: order.merchantOnchainId,
        productOnchainId: order.productOnchainId,
        payer: order.order.payer,
        recipient: order.order.recipient,
        token: order.order.tokenAddress,
        quantity: order.order.quantity,
        amountBaseUnits: order.order.amountBaseUnits,
        platformFeeBaseUnits: expectedFee,
        intentDigest: order.order.intentDigest,
        refundDeadline: seconds(order.order.refundableUntil),
      },
      proof,
    );
    if (mismatches.length > 0) {
      await this.uow
        .current()
        .update(orders)
        .set({ status: 'mismatch', updatedAt: new Date(proof.observedAt) })
        .where(eq(orders.id, order.order.id));
      return {
        kind: 'quarantined',
        reasonCode: 'PAYMENT_EVENT_MISMATCH',
        safeDetails: { orderId: order.order.id, fields: mismatches.join(',') },
      };
    }
    if (['paid', 'partially_refunded', 'refunded'].includes(order.order.status))
      return { kind: 'applied' };
    await this.uow
      .current()
      .update(orders)
      .set({
        status: 'paid',
        paidAmountBaseUnits: proof.fields.amountBaseUnits,
        transactionHash: proof.transactionHash,
        blockNumber: BigInt(proof.blockNumber),
        blockHash: proof.blockHash,
        logIndex: Number(proof.logIndex),
        confirmedAt: new Date(proof.observedAt),
        updatedAt: new Date(proof.observedAt),
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, order.order.id));
    await this.uow
      .current()
      .update(paymentAttempts)
      .set({
        status: 'paid',
        destinationTransactionHash: proof.transactionHash,
        submissionStartedAt: sql`coalesce(${paymentAttempts.submissionStartedAt}, ${proof.observedAt}::timestamptz)`,
        terminalAt: new Date(proof.observedAt),
        reconciliationRequired: false,
        updatedAt: new Date(proof.observedAt),
        version: sql`${paymentAttempts.version} + 1`,
      })
      .where(
        and(
          eq(paymentAttempts.orderId, order.order.id),
          inArray(paymentAttempts.status, [
            'created',
            'prepared',
            'submission_started',
            'submitted',
            'submitted_unknown',
            'executing',
            'confirming',
            'failed_confirmed',
          ]),
        ),
      );
    await this.uow
      .current()
      .update(products)
      .set({
        sold: sql`${products.sold} + ${proof.fields.quantity}::numeric`,
        updatedAt: new Date(proof.observedAt),
      })
      .where(eq(products.id, order.order.productId));
    const merchantLiability =
      BigInt(proof.fields.amountBaseUnits) - BigInt(proof.fields.platformFeeBaseUnits);
    await this.uow
      .current()
      .insert(settlementCredits)
      .values({
        merchantId: order.order.merchantId,
        orderId: order.order.id,
        amountBaseUnits: merchantLiability.toString(),
        withdrawnBaseUnits: '0',
        status: 'refundable',
        maturesAt: order.order.refundableUntil,
        finalizedEventId: null,
        createdAt: new Date(proof.observedAt),
        updatedAt: new Date(proof.observedAt),
      })
      .onConflictDoUpdate({
        target: settlementCredits.orderId,
        set: {
          amountBaseUnits: merchantLiability.toString(),
          withdrawnBaseUnits: '0',
          status: 'refundable',
          finalizedEventId: null,
          updatedAt: new Date(proof.observedAt),
        },
      });
    await this.uow
      .current()
      .insert(receipts)
      .values({
        id: opaqueId('rcp'),
        orderId: order.order.id,
        tokenId: proof.fields.passTokenId,
        metadataHash: order.productMetadataHash,
        status: 'expected',
        chainEventId: canonicalLogId,
        createdAt: new Date(proof.observedAt),
        updatedAt: new Date(proof.observedAt),
      })
      .onConflictDoUpdate({
        target: receipts.orderId,
        set: {
          tokenId: proof.fields.passTokenId,
          metadataHash: order.productMetadataHash,
          status: 'expected',
          chainEventId: canonicalLogId,
          issuedAt: null,
          updatedAt: new Date(proof.observedAt),
        },
      });
    await this.uow
      .current()
      .insert(outboxEvents)
      .values({
        eventKey: `order-paid:${canonicalLogId}`,
        eventType: 'order_paid',
        aggregateType: 'order',
        aggregateId: order.order.id,
        safePayload: { orderId: order.order.id, amountBaseUnits: proof.fields.amountBaseUnits },
        createdAt: new Date(proof.observedAt),
      })
      .onConflictDoNothing();
    return { kind: 'applied' };
  }

  async #orderRefunded(
    canonicalLogId: string,
    proof: Extract<CanonicalEventProof, { eventName: 'OrderRefunded' }>,
    decoded: StoredDecodedEvent,
  ): Promise<ProjectionResult> {
    const [record] = await this.uow
      .current()
      .select({
        order: orders,
        merchantOnchainId: merchants.onchainMerchantId,
        merchantCreditBaseUnits: settlementCredits.amountBaseUnits,
        signedIntent: signedOrderIntents.intent,
      })
      .from(orders)
      .innerJoin(merchants, eq(merchants.id, orders.merchantId))
      .innerJoin(settlementCredits, eq(settlementCredits.orderId, orders.id))
      .innerJoin(signedOrderIntents, eq(signedOrderIntents.orderKey, orders.orderKey))
      .where(eq(orders.orderKey, proof.fields.orderKey))
      .for('update')
      .limit(1);
    if (record === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'ORDER_NOT_FOUND',
        safeDetails: { orderKey: proof.fields.orderKey },
      };
    }
    const platformFeeRefunded = decoded.fields['platformFeeRefunded'];
    const signedPlatformFee = record.signedIntent['platformFeeBaseUnits'];
    const eventIdentityMismatch =
      record.merchantOnchainId !== decoded.fields['merchantId'] ||
      !sameAddress(record.order.payer, decoded.fields['payer'] ?? '') ||
      platformFeeRefunded === undefined ||
      signedPlatformFee === undefined;
    if (eventIdentityMismatch) {
      return {
        kind: 'quarantined',
        reasonCode: 'REFUND_EVENT_MISMATCH',
        safeDetails: { orderId: record.order.id, fields: 'identity' },
      };
    }
    const decision = evaluateRefundProjection({
      paidAmountBaseUnits: record.order.paidAmountBaseUnits,
      previouslyRefundedBaseUnits: record.order.refundedAmountBaseUnits,
      refundAmountBaseUnits: proof.fields.amountBaseUnits,
      cumulativeRefundedBaseUnits: proof.fields.cumulativeRefundedBaseUnits,
      signedPlatformFeeBaseUnits: signedPlatformFee,
      platformFeeRefundedBaseUnits: platformFeeRefunded,
      merchantCreditBaseUnits: record.merchantCreditBaseUnits,
    });
    if (decision.kind === 'mismatch') {
      return {
        kind: 'quarantined',
        reasonCode: 'REFUND_EVENT_MISMATCH',
        safeDetails: { orderId: record.order.id, fields: decision.fields.join(',') },
      };
    }
    const cumulative = BigInt(proof.fields.cumulativeRefundedBaseUnits);
    const status =
      cumulative === BigInt(record.order.paidAmountBaseUnits) ? 'refunded' : 'partially_refunded';
    await this.uow
      .current()
      .update(orders)
      .set({
        refundedAmountBaseUnits: cumulative.toString(),
        status,
        updatedAt: new Date(proof.observedAt),
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, record.order.id));
    const refundOperationId = await this.#findBoundFinancialOperation(
      'refund',
      {
        orderKey: proof.fields.orderKey,
        amountBaseUnits: proof.fields.amountBaseUnits,
      },
      positionFromProof(proof),
    );
    const boundRefunds =
      refundOperationId === undefined
        ? []
        : await this.uow
            .current()
            .select()
            .from(refunds)
            .where(
              and(
                eq(refunds.id, refundOperationId),
                eq(refunds.orderId, record.order.id),
                eq(refunds.amountBaseUnits, proof.fields.amountBaseUnits),
                inArray(refunds.status, [
                  'created',
                  'prepared',
                  'submission_started',
                  'submitted',
                  'submitted_unknown',
                  'confirming',
                  'orphaned',
                ]),
              ),
            )
            .limit(1);
    const orphanedRefunds =
      refundOperationId !== undefined
        ? []
        : await this.uow
            .current()
            .select()
            .from(refunds)
            .where(
              and(
                eq(refunds.orderId, record.order.id),
                eq(refunds.amountBaseUnits, proof.fields.amountBaseUnits),
                eq(refunds.status, 'orphaned'),
              ),
            )
            .limit(2);
    const workflow =
      boundRefunds[0] ?? (orphanedRefunds.length === 1 ? orphanedRefunds[0] : undefined);
    if (workflow !== undefined) {
      await this.uow
        .current()
        .update(refunds)
        .set({
          status: 'confirmed',
          transactionHash: proof.transactionHash,
          blockNumber: BigInt(proof.blockNumber),
          blockHash: proof.blockHash,
          logIndex: Number(proof.logIndex),
          confirmedAt: new Date(proof.observedAt),
          updatedAt: new Date(proof.observedAt),
        })
        .where(eq(refunds.id, workflow.id));
      await this.#confirmContractOperation('refund', workflow.id, decoded.eventName, {
        chainId: proof.chainId,
        contractAddress: proof.contractAddress,
        transactionHash: proof.transactionHash,
        blockNumber: BigInt(proof.blockNumber),
        blockHash: proof.blockHash,
        logIndex: Number(proof.logIndex),
        confirmations: BigInt(proof.confirmations),
        observedAt: new Date(proof.observedAt),
      });
    }
    await this.uow
      .current()
      .update(settlementCredits)
      .set({
        amountBaseUnits: decision.remainingMerchantCreditBaseUnits,
        updatedAt: new Date(proof.observedAt),
      })
      .where(eq(settlementCredits.orderId, record.order.id));
    await this.uow
      .current()
      .insert(outboxEvents)
      .values({
        eventKey: `order-refunded:${canonicalLogId}`,
        eventType: 'order_refunded',
        aggregateType: 'order',
        aggregateId: record.order.id,
        safePayload: { orderId: record.order.id, amountBaseUnits: proof.fields.amountBaseUnits },
        createdAt: new Date(proof.observedAt),
      })
      .onConflictDoNothing();
    return { kind: 'applied' };
  }

  async #orderFinalized(
    canonicalLogId: string,
    proof: Extract<CanonicalEventProof, { eventName: 'OrderFinalized' }>,
  ): Promise<ProjectionResult> {
    const [record] = await this.uow
      .current()
      .select({
        id: orders.id,
        status: orders.status,
        paidAmountBaseUnits: orders.paidAmountBaseUnits,
        refundedAmountBaseUnits: orders.refundedAmountBaseUnits,
        onchainMerchantId: merchants.onchainMerchantId,
        merchantCreditBaseUnits: settlementCredits.amountBaseUnits,
        signedIntent: signedOrderIntents.intent,
      })
      .from(orders)
      .innerJoin(merchants, eq(merchants.id, orders.merchantId))
      .innerJoin(settlementCredits, eq(settlementCredits.orderId, orders.id))
      .innerJoin(signedOrderIntents, eq(signedOrderIntents.orderKey, orders.orderKey))
      .where(eq(orders.orderKey, proof.fields.orderKey))
      .for('update')
      .limit(1);
    const signedPlatformFee = record?.signedIntent['platformFeeBaseUnits'];
    if (
      record === undefined ||
      record.onchainMerchantId !== proof.fields.merchantOnchainId ||
      signedPlatformFee === undefined ||
      !['paid', 'partially_refunded', 'refunded'].includes(record.status)
    ) {
      return {
        kind: 'quarantined',
        reasonCode: 'FINALIZATION_EVENT_MISMATCH',
        safeDetails: { orderKey: proof.fields.orderKey },
      };
    }
    const expected = expectedFinalizationCredits({
      paidAmountBaseUnits: record.paidAmountBaseUnits,
      refundedAmountBaseUnits: record.refundedAmountBaseUnits,
      signedPlatformFeeBaseUnits: signedPlatformFee,
    });
    if (
      expected.merchantBaseUnits !== proof.fields.merchantCreditBaseUnits ||
      expected.platformBaseUnits !== proof.fields.platformCreditBaseUnits ||
      record.merchantCreditBaseUnits !== expected.merchantBaseUnits
    ) {
      return {
        kind: 'quarantined',
        reasonCode: 'FINALIZATION_EVENT_MISMATCH',
        safeDetails: { orderKey: proof.fields.orderKey, fields: 'credits' },
      };
    }
    await this.uow
      .current()
      .update(settlementCredits)
      .set({
        status: 'matured',
        finalizedEventId: canonicalLogId,
        updatedAt: new Date(proof.observedAt),
      })
      .where(eq(settlementCredits.orderId, record.id));
    return { kind: 'applied' };
  }

  async #merchantWithdrawal(
    canonicalLogId: string,
    proof: Extract<CanonicalEventProof, { eventName: 'MerchantWithdrawal' }>,
    decoded: StoredDecodedEvent,
  ): Promise<ProjectionResult> {
    const [merchant] = await this.uow
      .current()
      .select()
      .from(merchants)
      .where(eq(merchants.onchainMerchantId, proof.fields.merchantOnchainId))
      .limit(1);
    if (merchant === undefined || !sameAddress(merchant.payoutAddress, proof.fields.recipient)) {
      return {
        kind: 'quarantined',
        reasonCode: 'WITHDRAWAL_EVENT_MISMATCH',
        safeDetails: { merchantOnchainId: proof.fields.merchantOnchainId },
      };
    }
    const credits = await this.uow
      .current()
      .select()
      .from(settlementCredits)
      .where(
        and(
          eq(settlementCredits.merchantId, merchant.id),
          inArray(settlementCredits.status, ['matured', 'withdrawn']),
        ),
      )
      .orderBy(asc(settlementCredits.createdAt))
      .for('update')
      .limit(1_000);
    const cumulativeWithdrawn = decoded.fields['cumulativeWithdrawn'];
    const previouslyWithdrawn = credits.reduce(
      (sum, credit) => sum + BigInt(credit.withdrawnBaseUnits),
      0n,
    );
    if (
      cumulativeWithdrawn === undefined ||
      BigInt(cumulativeWithdrawn) !== previouslyWithdrawn + BigInt(proof.fields.amountBaseUnits)
    ) {
      return {
        kind: 'quarantined',
        reasonCode: 'WITHDRAWAL_EVENT_MISMATCH',
        safeDetails: { merchantId: merchant.id, fields: 'cumulativeWithdrawn' },
      };
    }
    const debits = planWithdrawalDebits(credits, proof.fields.amountBaseUnits);
    if (debits === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'WITHDRAWAL_EXCEEDS_CREDIT',
        safeDetails: { merchantId: merchant.id },
      };
    }
    for (const debit of debits) {
      await this.uow
        .current()
        .update(settlementCredits)
        .set({
          withdrawnBaseUnits: debit.withdrawnBaseUnits,
          status: debit.fullyWithdrawn ? 'withdrawn' : 'matured',
          updatedAt: new Date(proof.observedAt),
        })
        .where(eq(settlementCredits.id, debit.creditId));
    }
    const withdrawalOperationId = await this.#findBoundFinancialOperation(
      'withdrawal',
      {
        merchantOnchainId: proof.fields.merchantOnchainId,
        payoutAddress: required(decoded.fields, 'payout'),
        amountBaseUnits: proof.fields.amountBaseUnits,
      },
      positionFromProof(proof),
      new Set(['payoutAddress']),
    );
    const boundWithdrawals =
      withdrawalOperationId === undefined
        ? []
        : await this.uow
            .current()
            .select()
            .from(withdrawals)
            .where(
              and(
                eq(withdrawals.id, withdrawalOperationId),
                eq(withdrawals.merchantId, merchant.id),
                eq(withdrawals.amountBaseUnits, proof.fields.amountBaseUnits),
                inArray(withdrawals.status, [
                  'created',
                  'prepared',
                  'submission_started',
                  'submitted',
                  'submitted_unknown',
                  'confirming',
                  'orphaned',
                ]),
              ),
            )
            .limit(1);
    const orphanedWithdrawals =
      withdrawalOperationId !== undefined
        ? []
        : await this.uow
            .current()
            .select()
            .from(withdrawals)
            .where(
              and(
                eq(withdrawals.merchantId, merchant.id),
                eq(withdrawals.amountBaseUnits, proof.fields.amountBaseUnits),
                eq(withdrawals.status, 'orphaned'),
              ),
            )
            .limit(2);
    const workflow =
      boundWithdrawals[0] ??
      (orphanedWithdrawals.length === 1 ? orphanedWithdrawals[0] : undefined);
    if (workflow !== undefined) {
      await this.uow
        .current()
        .update(withdrawals)
        .set({
          status: 'confirmed',
          transactionHash: proof.transactionHash,
          blockNumber: BigInt(proof.blockNumber),
          blockHash: proof.blockHash,
          logIndex: Number(proof.logIndex),
          confirmedAt: new Date(proof.observedAt),
          updatedAt: new Date(proof.observedAt),
        })
        .where(eq(withdrawals.id, workflow.id));
      await this.#confirmContractOperation('withdrawal', workflow.id, decoded.eventName, {
        chainId: proof.chainId,
        contractAddress: proof.contractAddress,
        transactionHash: proof.transactionHash,
        blockNumber: BigInt(proof.blockNumber),
        blockHash: proof.blockHash,
        logIndex: Number(proof.logIndex),
        confirmations: BigInt(proof.confirmations),
        observedAt: new Date(proof.observedAt),
      });
    }
    await this.uow
      .current()
      .insert(outboxEvents)
      .values({
        eventKey: `merchant-withdrawal:${canonicalLogId}`,
        eventType: 'merchant_withdrawal_confirmed',
        aggregateType: 'merchant',
        aggregateId: merchant.id,
        safePayload: { merchantId: merchant.id, amountBaseUnits: proof.fields.amountBaseUnits },
        createdAt: new Date(proof.observedAt),
      })
      .onConflictDoNothing();
    return { kind: 'applied' };
  }

  async #loyaltyAwarded(
    canonicalLogId: string,
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const [order] = await this.uow
      .current()
      .select({
        id: orders.id,
        userId: orders.userId,
        merchantId: orders.merchantId,
        recipient: orders.recipient,
        quantity: orders.quantity,
        loyaltyPointsPerUnit: products.loyaltyPoints,
        merchantOnchainId: merchants.onchainMerchantId,
      })
      .from(orders)
      .innerJoin(merchants, eq(merchants.id, orders.merchantId))
      .innerJoin(products, eq(products.id, orders.productId))
      .where(eq(orders.orderKey, required(fields, 'orderKey')))
      .limit(1);
    if (order === undefined)
      return {
        kind: 'quarantined',
        reasonCode: 'ORDER_NOT_FOUND',
        safeDetails: { orderKey: required(fields, 'orderKey') },
      };
    if (
      order.merchantOnchainId !== fields['merchantId'] ||
      !sameAddress(order.recipient, fields['account'] ?? '')
    ) {
      return {
        kind: 'quarantined',
        reasonCode: 'LOYALTY_EVENT_MISMATCH',
        safeDetails: { orderId: order.id },
      };
    }
    const [program] = await this.uow
      .current()
      .select()
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.merchantId, order.merchantId))
      .limit(1);
    if (program === undefined)
      return {
        kind: 'quarantined',
        reasonCode: 'LOYALTY_PROGRAM_NOT_FOUND',
        safeDetails: { merchantId: order.merchantId },
      };
    const points = required(fields, 'points');
    const expectedPoints = (BigInt(order.loyaltyPointsPerUnit) * BigInt(order.quantity)).toString();
    if (points !== expectedPoints) {
      return {
        kind: 'quarantined',
        reasonCode: 'LOYALTY_EVENT_MISMATCH',
        safeDetails: { orderId: order.id },
      };
    }
    await this.uow
      .current()
      .insert(loyaltyAwards)
      .values({
        programId: program.id,
        userId: order.userId,
        orderId: order.id,
        points,
        canonicalEventId: canonicalLogId,
        canonical: true,
      })
      .onConflictDoUpdate({
        target: [loyaltyAwards.programId, loyaltyAwards.orderId],
        set: { points, canonicalEventId: canonicalLogId, canonical: true },
      });
    await this.#refreshLoyaltyBalance(program.id, order.userId, position.observedAt);
    return { kind: 'applied' };
  }

  async #loyaltyAdjusted(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    const [order] = await this.uow
      .current()
      .select({
        id: orders.id,
        recipient: orders.recipient,
        merchantOnchainId: merchants.onchainMerchantId,
      })
      .from(orders)
      .innerJoin(merchants, eq(merchants.id, orders.merchantId))
      .where(eq(orders.orderKey, required(fields, 'orderKey')))
      .limit(1);
    if (order === undefined)
      return {
        kind: 'quarantined',
        reasonCode: 'ORDER_NOT_FOUND',
        safeDetails: { orderKey: required(fields, 'orderKey') },
      };
    const [award] = await this.uow
      .current()
      .select()
      .from(loyaltyAwards)
      .where(eq(loyaltyAwards.orderId, order.id))
      .limit(1);
    if (award === undefined)
      return {
        kind: 'quarantined',
        reasonCode: 'LOYALTY_AWARD_NOT_FOUND',
        safeDetails: { orderId: order.id },
      };
    const removed = BigInt(required(fields, 'pointsRemoved'));
    const remaining = BigInt(required(fields, 'remainingOrderPoints'));
    if (
      removed > BigInt(award.points) ||
      remaining + removed !== BigInt(award.points) ||
      order.merchantOnchainId !== fields['merchantId'] ||
      !sameAddress(order.recipient, fields['account'] ?? '')
    ) {
      return {
        kind: 'quarantined',
        reasonCode: 'LOYALTY_EVENT_MISMATCH',
        safeDetails: { orderId: order.id },
      };
    }
    await this.uow
      .current()
      .update(loyaltyAwards)
      .set({ points: remaining.toString() })
      .where(eq(loyaltyAwards.id, award.id));
    await this.#refreshLoyaltyBalance(award.programId, award.userId, position.observedAt);
    return { kind: 'applied' };
  }

  async #refreshLoyaltyBalance(programId: string, userId: string, observedAt: Date): Promise<void> {
    await this.uow
      .current()
      .insert(loyaltyBalances)
      .values({ programId, userId, points: '0', updatedAt: observedAt })
      .onConflictDoNothing();
    await this.uow
      .current()
      .update(loyaltyBalances)
      .set({
        points: sql`coalesce((select sum(${loyaltyAwards.points}) from ${loyaltyAwards} where ${loyaltyAwards.programId} = ${programId} and ${loyaltyAwards.userId} = ${userId} and ${loyaltyAwards.canonical} = true), 0)`,
        version: sql`${loyaltyBalances.version} + 1`,
        updatedAt: observedAt,
      })
      .where(and(eq(loyaltyBalances.programId, programId), eq(loyaltyBalances.userId, userId)));
  }

  async #passTransfer(
    canonicalLogId: string,
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const fields = decoded.fields;
    if (!/^0x0{40}$/i.test(required(fields, 'from'))) return { kind: 'applied' };
    const [paidLog] = await this.uow
      .current()
      .select({ payload: canonicalLogs.decodedPayload })
      .from(canonicalLogs)
      .where(
        and(
          eq(canonicalLogs.chainId, position.chainId),
          eq(canonicalLogs.transactionHash, position.transactionHash),
          eq(canonicalLogs.eventName, 'OrderPaid'),
          eq(canonicalLogs.canonical, true),
        ),
      )
      .limit(1);
    const payload = paidLog?.payload as { fields?: Record<string, string> } | undefined;
    const orderKey = payload?.fields?.['orderKey'];
    if (orderKey === undefined)
      return {
        kind: 'quarantined',
        reasonCode: 'PASS_WITHOUT_ORDER',
        safeDetails: { transactionHash: position.transactionHash },
      };
    const [order] = await this.uow
      .current()
      .select({ id: orders.id, recipient: orders.recipient })
      .from(orders)
      .where(eq(orders.orderKey, orderKey))
      .limit(1);
    if (
      order === undefined ||
      !sameAddress(order.recipient, required(fields, 'to')) ||
      payload?.fields?.['passTokenId'] !== required(fields, 'id') ||
      payload?.fields?.['quantity'] !== required(fields, 'value')
    )
      return { kind: 'quarantined', reasonCode: 'PASS_EVENT_MISMATCH', safeDetails: { orderKey } };
    await this.uow
      .current()
      .update(receipts)
      .set({
        tokenId: required(fields, 'id'),
        status: 'issued',
        chainEventId: canonicalLogId,
        issuedAt: position.observedAt,
        updatedAt: position.observedAt,
      })
      .where(eq(receipts.orderId, order.id));
    return { kind: 'applied' };
  }

  async #passRevoked(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const [order] = await this.uow
      .current()
      .select({
        id: orders.id,
        recipient: orders.recipient,
        quantity: orders.quantity,
        tokenId: receipts.tokenId,
      })
      .from(orders)
      .leftJoin(receipts, eq(receipts.orderId, orders.id))
      .where(eq(orders.orderKey, required(decoded.fields, 'orderKey')))
      .limit(1);
    if (order === undefined)
      return {
        kind: 'quarantined',
        reasonCode: 'ORDER_NOT_FOUND',
        safeDetails: { orderKey: required(decoded.fields, 'orderKey') },
      };
    if (
      !sameAddress(order.recipient, required(decoded.fields, 'account')) ||
      order.quantity !== required(decoded.fields, 'quantity') ||
      order.tokenId !== required(decoded.fields, 'tokenId')
    ) {
      return {
        kind: 'quarantined',
        reasonCode: 'PASS_EVENT_MISMATCH',
        safeDetails: { orderKey: required(decoded.fields, 'orderKey') },
      };
    }
    await this.uow
      .current()
      .update(receipts)
      .set({ status: 'revoked', updatedAt: position.observedAt })
      .where(eq(receipts.orderId, order.id));
    return { kind: 'applied' };
  }

  async #splitReimbursed(
    canonicalLogId: string,
    proof: Extract<CanonicalEventProof, { eventName: 'SplitReimbursed' }>,
  ): Promise<ProjectionResult> {
    const [payment] = await this.uow
      .current()
      .select({
        payment: splitPayments,
        invitationStatus: splitInvitations.status,
        expectedAmount: splitParticipants.amountBaseUnits,
        participantId: splitParticipants.id,
        beneficiary: splits.beneficiary,
        splitId: splits.id,
        splitTotal: splits.totalBaseUnits,
        splitConfirmed: splits.confirmedBaseUnits,
        payerAddress: users.walletAddressChecksum,
        originalOrderKey: orders.orderKey,
      })
      .from(splitPayments)
      .innerJoin(splitInvitations, eq(splitInvitations.id, splitPayments.invitationId))
      .innerJoin(splitParticipants, eq(splitParticipants.id, splitInvitations.participantId))
      .innerJoin(splits, eq(splits.id, splitPayments.splitId))
      .innerJoin(orders, eq(orders.id, splits.orderId))
      .innerJoin(users, eq(users.id, splitPayments.payerUserId))
      .where(eq(splitPayments.paymentKey, proof.fields.paymentKey))
      .for('update')
      .limit(1);
    if (payment === undefined)
      return {
        kind: 'quarantined',
        reasonCode: 'SPLIT_PAYMENT_NOT_FOUND',
        safeDetails: { paymentKey: proof.fields.paymentKey },
      };
    const mismatches = findSplitReimbursementMismatches(
      {
        paymentKey: payment.payment.paymentKey,
        splitDigest: payment.payment.splitDigest,
        originalOrderKey: payment.payment.originalOrderKey,
        orderKey: payment.originalOrderKey,
        payer: payment.payerAddress,
        beneficiary: payment.beneficiary,
        token: payment.payment.tokenAddress,
        amountBaseUnits:
          payment.expectedAmount === payment.payment.amountBaseUnits
            ? payment.payment.amountBaseUnits
            : '__stored_amount_mismatch__',
        intentDigest: payment.payment.intentDigest,
      },
      proof,
    );
    if (mismatches.length > 0)
      return {
        kind: 'quarantined',
        reasonCode: 'SPLIT_EVENT_MISMATCH',
        safeDetails: { splitId: payment.splitId, fields: mismatches.join(',') },
      };
    if (payment.payment.status === 'paid') return { kind: 'applied' };
    const newConfirmed = BigInt(payment.splitConfirmed) + BigInt(proof.fields.amountBaseUnits);
    if (newConfirmed > BigInt(payment.splitTotal))
      return {
        kind: 'quarantined',
        reasonCode: 'SPLIT_OVERPAYMENT',
        safeDetails: { splitId: payment.splitId },
      };
    await this.uow
      .current()
      .update(splitPayments)
      .set({
        status: 'paid',
        transactionHash: proof.transactionHash,
        blockNumber: BigInt(proof.blockNumber),
        blockHash: proof.blockHash,
        logIndex: Number(proof.logIndex),
        confirmedAt: new Date(proof.observedAt),
        updatedAt: new Date(proof.observedAt),
      })
      .where(eq(splitPayments.id, payment.payment.id));
    await this.uow
      .current()
      .update(splitInvitations)
      .set({ status: 'paid', updatedAt: new Date(proof.observedAt) })
      .where(eq(splitInvitations.id, payment.payment.invitationId));
    await this.uow
      .current()
      .update(splitParticipants)
      .set({
        confirmedBaseUnits: proof.fields.amountBaseUnits,
        updatedAt: new Date(proof.observedAt),
      })
      .where(eq(splitParticipants.id, payment.participantId));
    await this.uow
      .current()
      .update(splits)
      .set({
        confirmedBaseUnits: newConfirmed.toString(),
        status: newConfirmed === BigInt(payment.splitTotal) ? 'complete' : 'partially_paid',
        updatedAt: new Date(proof.observedAt),
        version: sql`${splits.version} + 1`,
      })
      .where(eq(splits.id, payment.splitId));
    await this.uow
      .current()
      .insert(outboxEvents)
      .values({
        eventKey: `split-reimbursed:${canonicalLogId}`,
        eventType: 'split_reimbursed',
        aggregateType: 'split',
        aggregateId: payment.splitId,
        safePayload: { splitId: payment.splitId, amountBaseUnits: proof.fields.amountBaseUnits },
        createdAt: new Date(proof.observedAt),
      })
      .onConflictDoNothing();
    await this.#confirmContractOperation('split_payment', payment.payment.id, proof.eventName, {
      chainId: proof.chainId,
      contractAddress: proof.contractAddress,
      transactionHash: proof.transactionHash,
      blockNumber: BigInt(proof.blockNumber),
      blockHash: proof.blockHash,
      logIndex: Number(proof.logIndex),
      confirmations: BigInt(proof.confirmations),
      observedAt: new Date(proof.observedAt),
    });
    return { kind: 'applied' };
  }

  async #splitPaymentRevoked(
    decoded: StoredDecodedEvent,
    position: StoredEventPosition,
  ): Promise<ProjectionResult> {
    const paymentKey = required(decoded.fields, 'paymentKey');
    const splitDigest = required(decoded.fields, 'splitDigest');
    const [payment] = await this.uow
      .current()
      .select()
      .from(splitPayments)
      .where(
        and(eq(splitPayments.paymentKey, paymentKey), eq(splitPayments.splitDigest, splitDigest)),
      )
      .for('update')
      .limit(1);
    if (payment === undefined) {
      return {
        kind: 'quarantined',
        reasonCode: 'SPLIT_PAYMENT_NOT_FOUND',
        safeDetails: { paymentKey },
      };
    }
    if (payment.status === 'paid') {
      return {
        kind: 'quarantined',
        reasonCode: 'SPLIT_REVOCATION_AFTER_PAYMENT',
        safeDetails: { splitId: payment.splitId },
      };
    }
    await this.uow
      .current()
      .update(splitPayments)
      .set({
        status: 'revoked',
        transactionHash: position.transactionHash,
        blockNumber: position.blockNumber,
        blockHash: position.blockHash,
        logIndex: position.logIndex,
        confirmedAt: position.observedAt,
        updatedAt: position.observedAt,
      })
      .where(eq(splitPayments.id, payment.id));
    await this.uow
      .current()
      .update(splitInvitations)
      .set({
        status: 'revoked',
        revokedAt: position.observedAt,
        updatedAt: position.observedAt,
      })
      .where(eq(splitInvitations.id, payment.invitationId));
    const remaining = await this.uow
      .current()
      .select({ id: splitPayments.id })
      .from(splitPayments)
      .where(
        and(
          eq(splitPayments.splitId, payment.splitId),
          inArray(splitPayments.status, [
            'unpaid',
            'submission_started',
            'submitted_unknown',
            'confirming',
            'failed',
            'orphaned',
          ]),
        ),
      )
      .limit(1);
    if (remaining.length === 0) {
      await this.uow
        .current()
        .update(splits)
        .set({
          status: 'revoked',
          revokedAt: position.observedAt,
          version: sql`${splits.version} + 1`,
          updatedAt: position.observedAt,
        })
        .where(and(eq(splits.id, payment.splitId), eq(splits.confirmedBaseUnits, '0')));
      await this.uow
        .current()
        .update(splitInvitations)
        .set({
          status: 'revoked',
          revokedAt: position.observedAt,
          updatedAt: position.observedAt,
        })
        .where(
          and(
            eq(splitInvitations.splitId, payment.splitId),
            inArray(splitInvitations.status, [
              'unpaid',
              'submission_started',
              'submitted_unknown',
              'confirming',
            ]),
          ),
        );
    }
    await this.#confirmContractOperation('split_payment', payment.id, decoded.eventName, position);
    return { kind: 'applied' };
  }

  async #findBoundFinancialOperation(
    kind: 'refund' | 'withdrawal',
    expectedBinding: Readonly<Record<string, string>>,
    position: StoredEventPosition,
    caseInsensitiveFields: ReadonlySet<string> = new Set(),
  ): Promise<string | undefined> {
    const candidates = await this.uow
      .current()
      .select()
      .from(contractOperations)
      .where(
        and(
          eq(contractOperations.kind, kind),
          eq(contractOperations.aggregateType, kind),
          inArray(contractOperations.status, [
            'prepared',
            'submission_started',
            'submitted',
            'submitted_unknown',
            'confirming',
            'orphaned',
          ]),
        ),
      )
      .orderBy(asc(contractOperations.createdAt))
      .limit(500);
    const bindingMatches = candidates.filter((candidate) => {
      const binding = objectValue(candidate.binding);
      if (binding === undefined) return false;
      return Object.entries(expectedBinding).every(([key, expected]) => {
        const actual = binding[key];
        if (typeof actual !== 'string') return false;
        return caseInsensitiveFields.has(key)
          ? actual.toLowerCase() === expected.toLowerCase()
          : actual === expected;
      });
    });
    return selectOperationForCanonicalTransaction(bindingMatches, position.transactionHash)
      ?.aggregateId;
  }

  async #confirmContractOperation(
    aggregateType: string,
    aggregateId: string,
    eventName: string,
    position: StoredEventPosition,
  ): Promise<boolean> {
    const expectation = operationExpectation(eventName);
    if (expectation === undefined) return false;
    const candidates = await this.uow
      .current()
      .select()
      .from(contractOperations)
      .where(
        and(
          eq(contractOperations.aggregateType, aggregateType),
          eq(contractOperations.aggregateId, aggregateId),
          eq(contractOperations.kind, expectation.kind),
          inArray(contractOperations.status, [
            'prepared',
            'submission_started',
            'submitted',
            'submitted_unknown',
            'confirming',
            'orphaned',
          ]),
        ),
      );
    const actionMatches = candidates.filter((candidate) => {
      if (expectation.action === undefined) return true;
      return (
        objectValue(candidate.binding)?.['mutation'] !== undefined &&
        objectValue(objectValue(candidate.binding)?.['mutation'])?.['action'] === expectation.action
      );
    });
    const selected = selectOperationForCanonicalTransaction(
      actionMatches,
      position.transactionHash,
    );
    if (selected === undefined) return false;
    const [updated] = await this.uow
      .current()
      .update(contractOperations)
      .set({
        status: 'confirmed',
        transactionHash: position.transactionHash,
        canonicalEventName: eventName,
        blockNumber: position.blockNumber,
        blockHash: position.blockHash,
        logIndex: position.logIndex,
        confirmedAt: position.observedAt,
        submissionStartedAt: sql`coalesce(${contractOperations.submissionStartedAt}, ${position.observedAt.toISOString()}::timestamptz)`,
        version: sql`${contractOperations.version} + 1`,
        updatedAt: position.observedAt,
      })
      .where(
        and(
          eq(contractOperations.id, selected.id),
          inArray(contractOperations.status, [
            'prepared',
            'submission_started',
            'submitted',
            'submitted_unknown',
            'confirming',
            'orphaned',
          ]),
        ),
      )
      .returning({ id: contractOperations.id });
    return updated !== undefined;
  }
}
