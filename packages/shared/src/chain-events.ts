import { z } from 'zod';
import { ChainIdSchema, EvmAddressSchema } from './address.js';
import { Bytes32Schema, OrderKeySchema, TransactionHashSchema } from './ids.js';
import { BaseUnitAmountSchema, QuantitySchema, Uint64StringSchema } from './money.js';

const EventPositionSchema = z.object({
  chainId: ChainIdSchema,
  contractAddress: EvmAddressSchema,
  transactionHash: TransactionHashSchema,
  blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockHash: Bytes32Schema,
  logIndex: z.string().regex(/^(0|[1-9][0-9]*)$/),
  confirmations: z.string().regex(/^(0|[1-9][0-9]*)$/),
  canonical: z.boolean(),
  observedAt: z.string().datetime(),
});

const CommerceEventFieldsSchema = z.object({
  orderKey: OrderKeySchema,
  merchantOnchainId: z.string().regex(/^[1-9][0-9]*$/),
  productOnchainId: z.string().regex(/^[1-9][0-9]*$/),
  payer: EvmAddressSchema,
  recipient: EvmAddressSchema,
});

export const CanonicalEventProofSchema = z.discriminatedUnion('eventName', [
  EventPositionSchema.extend({
    eventName: z.literal('OrderPaid'),
    fields: CommerceEventFieldsSchema.extend({
      token: EvmAddressSchema,
      quantity: QuantitySchema,
      amountBaseUnits: BaseUnitAmountSchema,
      platformFeeBaseUnits: BaseUnitAmountSchema,
      intentDigest: Bytes32Schema,
      passTokenId: z.string().regex(/^[1-9][0-9]*$/),
      refundDeadline: Uint64StringSchema,
    }),
  }),
  EventPositionSchema.extend({
    eventName: z.literal('OrderRefunded'),
    fields: CommerceEventFieldsSchema.pick({ orderKey: true }).extend({
      amountBaseUnits: BaseUnitAmountSchema,
      cumulativeRefundedBaseUnits: BaseUnitAmountSchema,
    }),
  }),
  EventPositionSchema.extend({
    eventName: z.literal('OrderFinalized'),
    fields: CommerceEventFieldsSchema.pick({ orderKey: true, merchantOnchainId: true }).extend({
      merchantCreditBaseUnits: BaseUnitAmountSchema,
      platformCreditBaseUnits: BaseUnitAmountSchema,
    }),
  }),
  EventPositionSchema.extend({
    eventName: z.literal('MerchantWithdrawal'),
    fields: z.object({
      merchantOnchainId: z.string().regex(/^[1-9][0-9]*$/),
      recipient: EvmAddressSchema,
      amountBaseUnits: BaseUnitAmountSchema,
    }),
  }),
  EventPositionSchema.extend({
    eventName: z.literal('SplitReimbursed'),
    fields: z.object({
      paymentKey: Bytes32Schema,
      splitDigest: Bytes32Schema,
      originalOrderKey: Bytes32Schema,
      payer: EvmAddressSchema,
      beneficiary: EvmAddressSchema,
      token: EvmAddressSchema,
      amountBaseUnits: BaseUnitAmountSchema,
      intentDigest: Bytes32Schema,
    }),
  }),
]);

export type CanonicalEventProof = z.infer<typeof CanonicalEventProofSchema>;

export function isFinalCanonicalProof(
  proof: CanonicalEventProof,
  requiredConfirmations: bigint,
): boolean {
  return proof.canonical && BigInt(proof.confirmations) >= requiredConfirmations;
}
