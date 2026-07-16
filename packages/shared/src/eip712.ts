import type { OrderIntent } from './checkout.js';
import type { SplitReimbursementIntent } from './split.js';

export const ORDER_INTENT_EIP712_TYPE_STRING =
  'OrderIntent(bytes32 orderKey,address payer,address recipient,uint256 merchantId,uint256 productId,uint64 productVersion,address token,uint256 amount,uint16 platformFeeBps,uint256 platformFee,uint64 quantity,uint64 validAfter,uint64 validUntil,uint64 refundDeadline,bytes32 metadataHash)' as const;

export const ORDER_INTENT_EIP712_FIELDS = [
  { name: 'orderKey', type: 'bytes32' },
  { name: 'payer', type: 'address' },
  { name: 'recipient', type: 'address' },
  { name: 'merchantId', type: 'uint256' },
  { name: 'productId', type: 'uint256' },
  { name: 'productVersion', type: 'uint64' },
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'platformFeeBps', type: 'uint16' },
  { name: 'platformFee', type: 'uint256' },
  { name: 'quantity', type: 'uint64' },
  { name: 'validAfter', type: 'uint64' },
  { name: 'validUntil', type: 'uint64' },
  { name: 'refundDeadline', type: 'uint64' },
  { name: 'metadataHash', type: 'bytes32' },
] as const;

export function toOrderIntentEip712Message(intent: OrderIntent) {
  return {
    orderKey: intent.orderKey,
    payer: intent.payer,
    recipient: intent.recipient,
    merchantId: BigInt(intent.merchantOnchainId),
    productId: BigInt(intent.productOnchainId),
    productVersion: BigInt(intent.productVersion),
    token: intent.token,
    amount: BigInt(intent.amountBaseUnits),
    platformFeeBps: Number(intent.platformFeeBps),
    platformFee: BigInt(intent.platformFeeBaseUnits),
    quantity: BigInt(intent.quantity),
    validAfter: BigInt(intent.validAfter),
    validUntil: BigInt(intent.validUntil),
    refundDeadline: BigInt(intent.refundDeadline),
    metadataHash: intent.metadataHash,
  } as const;
}

export const SPLIT_INTENT_EIP712_TYPE_STRING =
  'SplitIntent(bytes32 paymentKey,bytes32 splitDigest,bytes32 originalOrderKey,address payer,address beneficiary,address token,uint256 amount,uint64 validAfter,uint64 validUntil,bytes32 metadataHash)' as const;

export const SPLIT_INTENT_EIP712_FIELDS = [
  { name: 'paymentKey', type: 'bytes32' },
  { name: 'splitDigest', type: 'bytes32' },
  { name: 'originalOrderKey', type: 'bytes32' },
  { name: 'payer', type: 'address' },
  { name: 'beneficiary', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'validAfter', type: 'uint64' },
  { name: 'validUntil', type: 'uint64' },
  { name: 'metadataHash', type: 'bytes32' },
] as const;

export function toSplitIntentEip712Message(intent: SplitReimbursementIntent) {
  return {
    paymentKey: intent.paymentKey,
    splitDigest: intent.splitDigest,
    originalOrderKey: intent.originalOrderKey,
    payer: intent.payer,
    beneficiary: intent.beneficiary,
    token: intent.token,
    amount: BigInt(intent.amountBaseUnits),
    validAfter: BigInt(intent.validAfter),
    validUntil: BigInt(intent.validUntil),
    metadataHash: intent.metadataHash,
  } as const;
}
