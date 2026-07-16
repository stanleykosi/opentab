import { createHash } from 'node:crypto';
import { EvidenceDigestSchema, type Product, type ProductId } from '@opentab/shared';

export interface PublicProductPassMetadata {
  readonly schema: 'https://opentab.app/schemas/product-pass/v1';
  readonly name: string;
  readonly description: string;
  readonly image?: string;
  readonly attributes: readonly {
    readonly trait_type: string;
    readonly value: string;
  }[];
}

/** The insertion order below is part of the v1 canonical metadata contract. */
export function canonicalProductPassMetadata(input: {
  title: string;
  description: string;
  imageUrl?: string;
  unitPriceBaseUnits: string;
  maxSupply?: string;
  maxPerOrder: string;
  startsAt: string;
  endsAt?: string;
  refundWindowSeconds: string;
  loyaltyPoints: string;
}): PublicProductPassMetadata {
  return {
    schema: 'https://opentab.app/schemas/product-pass/v1',
    name: input.title,
    description: input.description,
    ...(input.imageUrl === undefined ? {} : { image: input.imageUrl }),
    attributes: [
      { trait_type: 'Price (USDC base units)', value: input.unitPriceBaseUnits },
      { trait_type: 'Maximum supply', value: input.maxSupply ?? 'unlimited' },
      { trait_type: 'Maximum per customer', value: input.maxPerOrder },
      { trait_type: 'Starts at', value: input.startsAt },
      { trait_type: 'Ends at', value: input.endsAt ?? 'open-ended' },
      { trait_type: 'Refund window (seconds)', value: input.refundWindowSeconds },
      { trait_type: 'Loyalty points', value: input.loyaltyPoints },
    ],
  };
}

export function productMetadataDigest(metadata: PublicProductPassMetadata) {
  return canonicalMetadataDigest(metadata);
}

export function canonicalMetadataDigest(metadata: unknown) {
  return EvidenceDigestSchema.parse(
    `0x${createHash('sha256').update(JSON.stringify(metadata), 'utf8').digest('hex')}`,
  );
}

export function productPassUri(origin: string, productId: ProductId): string {
  return new URL(`/api/v1/metadata/products/${encodeURIComponent(productId)}`, origin).href;
}

export function metadataFromStoredProduct(product: Product): PublicProductPassMetadata {
  return canonicalProductPassMetadata({
    title: product.title,
    description: product.description,
    ...(product.imageUrl === undefined ? {} : { imageUrl: product.imageUrl }),
    unitPriceBaseUnits: product.unitPriceBaseUnits,
    ...(product.maxSupply === undefined ? {} : { maxSupply: product.maxSupply }),
    maxPerOrder: product.maxPerOrder,
    startsAt: product.startsAt,
    ...(product.endsAt === undefined ? {} : { endsAt: product.endsAt }),
    refundWindowSeconds: product.refundWindowSeconds,
    loyaltyPoints: product.loyaltyPoints,
  });
}
