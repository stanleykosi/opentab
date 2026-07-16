import { type BoundOperationTemplate, BoundOperationTemplateSchema } from '@opentab/shared';
import { z } from 'zod';
import {
  type MerchantProductOperationBinding,
  MerchantProductOperationBindingSchema,
  type RefundOperationBinding,
  RefundOperationBindingSchema,
  type SplitReimbursementOperationBinding,
  SplitReimbursementOperationBindingSchema,
  validateMerchantProductOperationTemplate,
  validateRefundOperationTemplate,
  validateSplitReimbursementOperationTemplate,
  validateWithdrawalOperationTemplate,
  type WithdrawalOperationBinding,
  WithdrawalOperationBindingSchema,
} from './operation-templates.js';

const BrowserContractOperationInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('merchant_mutation'),
      binding: MerchantProductOperationBindingSchema,
      template: BoundOperationTemplateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('product_mutation'),
      binding: MerchantProductOperationBindingSchema,
      template: BoundOperationTemplateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('refund'),
      binding: RefundOperationBindingSchema,
      template: BoundOperationTemplateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('withdrawal'),
      binding: WithdrawalOperationBindingSchema,
      template: BoundOperationTemplateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('split_reimbursement'),
      binding: SplitReimbursementOperationBindingSchema,
      template: BoundOperationTemplateSchema,
    })
    .strict(),
]);

export type BrowserContractOperationValidationInput =
  | {
      readonly kind: 'merchant_mutation';
      readonly binding: MerchantProductOperationBinding;
      readonly template: BoundOperationTemplate;
    }
  | {
      readonly kind: 'product_mutation';
      readonly binding: MerchantProductOperationBinding;
      readonly template: BoundOperationTemplate;
    }
  | {
      readonly kind: 'refund';
      readonly binding: RefundOperationBinding;
      readonly template: BoundOperationTemplate;
    }
  | {
      readonly kind: 'withdrawal';
      readonly binding: WithdrawalOperationBinding;
      readonly template: BoundOperationTemplate;
    }
  | {
      readonly kind: 'split_reimbursement';
      readonly binding: SplitReimbursementOperationBinding;
      readonly template: BoundOperationTemplate;
    };

/**
 * Re-derives and validates a server-issued customer/merchant operation before
 * browser signing. Managed split revocation is deliberately not in this union.
 */
export function validateBrowserContractOperation(
  input: BrowserContractOperationValidationInput,
): BoundOperationTemplate {
  const parsed = BrowserContractOperationInputSchema.parse(input);
  switch (parsed.kind) {
    case 'merchant_mutation':
    case 'product_mutation':
      return validateMerchantProductOperationTemplate(parsed);
    case 'refund':
      return validateRefundOperationTemplate(parsed);
    case 'withdrawal':
      return validateWithdrawalOperationTemplate(parsed);
    case 'split_reimbursement':
      return validateSplitReimbursementOperationTemplate(parsed);
  }
}
