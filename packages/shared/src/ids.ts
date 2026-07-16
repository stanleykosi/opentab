import { z } from 'zod';

const prefixedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

export const UserIdSchema = prefixedId('usr').brand<'UserId'>();
export const SessionIdSchema = prefixedId('ses').brand<'SessionId'>();
export const MerchantIdSchema = prefixedId('mer').brand<'MerchantId'>();
export const ProductIdSchema = prefixedId('prd').brand<'ProductId'>();
export const CheckoutSessionIdSchema = prefixedId('chk').brand<'CheckoutSessionId'>();
export const PaymentAttemptIdSchema = prefixedId('pay').brand<'PaymentAttemptId'>();
export const OrderIdSchema = prefixedId('ord').brand<'OrderId'>();
export const ReceiptIdSchema = prefixedId('rcp').brand<'ReceiptId'>();
export const RefundIdSchema = prefixedId('rfd').brand<'RefundId'>();
export const WithdrawalIdSchema = prefixedId('wdr').brand<'WithdrawalId'>();
export const SplitIdSchema = prefixedId('spl').brand<'SplitId'>();
export const SplitInvitationIdSchema = prefixedId('spi').brand<'SplitInvitationId'>();
export const ProviderOperationIdSchema = z.string().min(1).max(256).brand<'ProviderOperationId'>();
export const RequestIdSchema = prefixedId('req').brand<'RequestId'>();
export const EvidenceIdSchema = prefixedId('evd').brand<'EvidenceId'>();

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .brand<'Bytes32'>();
export const OrderKeySchema = Bytes32Schema.brand<'OrderKey'>();
export const TransactionHashSchema = Bytes32Schema.brand<'TransactionHash'>();
export const EvidenceDigestSchema = Bytes32Schema.brand<'EvidenceDigest'>();

export type UserId = z.infer<typeof UserIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type MerchantId = z.infer<typeof MerchantIdSchema>;
export type ProductId = z.infer<typeof ProductIdSchema>;
export type CheckoutSessionId = z.infer<typeof CheckoutSessionIdSchema>;
export type PaymentAttemptId = z.infer<typeof PaymentAttemptIdSchema>;
export type OrderId = z.infer<typeof OrderIdSchema>;
export type ReceiptId = z.infer<typeof ReceiptIdSchema>;
export type RefundId = z.infer<typeof RefundIdSchema>;
export type WithdrawalId = z.infer<typeof WithdrawalIdSchema>;
export type SplitId = z.infer<typeof SplitIdSchema>;
export type SplitInvitationId = z.infer<typeof SplitInvitationIdSchema>;
export type ProviderOperationId = z.infer<typeof ProviderOperationIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type Bytes32 = z.infer<typeof Bytes32Schema>;
export type OrderKey = z.infer<typeof OrderKeySchema>;
export type TransactionHash = z.infer<typeof TransactionHashSchema>;
export type EvidenceDigest = z.infer<typeof EvidenceDigestSchema>;

export function asOrderKey(value: string): OrderKey {
  return OrderKeySchema.parse(value);
}
