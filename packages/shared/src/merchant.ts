import { z } from 'zod';
import { EvmAddressSchema } from './address.js';
import { EvidenceDigestSchema, MerchantIdSchema, ProductIdSchema, UserIdSchema } from './ids.js';
import { BaseUnitAmountSchema, QuantitySchema } from './money.js';

export const MerchantStatusSchema = z.enum(['draft', 'pending', 'active', 'paused', 'archived']);
export const ProductStatusSchema = z.enum([
  'draft',
  'publishing',
  'scheduled',
  'active',
  'paused',
  'sold_out',
  'ended',
  'archived',
]);

export const MerchantSchema = z.object({
  id: MerchantIdSchema,
  ownerUserId: UserIdSchema,
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
  displayName: z.string().trim().min(2).max(100),
  supportContact: z.string().trim().max(200).optional(),
  payoutAddress: EvmAddressSchema,
  status: MerchantStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ProductSchema = z.object({
  id: ProductIdSchema,
  merchantId: MerchantIdSchema,
  onchainProductId: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .optional(),
  version: z.string().regex(/^[1-9][0-9]*$/),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().min(1).max(4_000),
  imageUrl: z.string().url().optional(),
  unitPriceBaseUnits: BaseUnitAmountSchema,
  maxSupply: QuantitySchema.optional(),
  sold: z.string().regex(/^(0|[1-9][0-9]*)$/),
  maxPerOrder: QuantitySchema,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
  refundWindowSeconds: z.string().regex(/^(0|[1-9][0-9]*)$/),
  loyaltyPoints: BaseUnitAmountSchema,
  metadataHash: EvidenceDigestSchema,
  status: ProductStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const PublicProductSchema = ProductSchema.pick({
  id: true,
  merchantId: true,
  version: true,
  slug: true,
  title: true,
  description: true,
  imageUrl: true,
  unitPriceBaseUnits: true,
  maxSupply: true,
  sold: true,
  maxPerOrder: true,
  startsAt: true,
  endsAt: true,
  refundWindowSeconds: true,
  loyaltyPoints: true,
  status: true,
}).extend({
  merchant: MerchantSchema.pick({ slug: true, displayName: true }),
  availabilityCheckedAt: z.string().datetime(),
  projectionStale: z.boolean(),
});

export type Merchant = z.infer<typeof MerchantSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type PublicProduct = z.infer<typeof PublicProductSchema>;
