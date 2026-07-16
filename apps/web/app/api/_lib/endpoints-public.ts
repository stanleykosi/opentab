import { AppError, ProductIdSchema } from '@opentab/shared';
import { handleQuery } from './http.js';
import { type RouteContext, routeParam } from './params.js';
import { metadataFromStoredProduct, productMetadataDigest } from './product-metadata.js';
import { OpaqueReferenceSchema, PublicBrowserConfigSchema, SlugSchema } from './schemas.js';

export function getPublicConfig(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'none',
    execute: async ({ registry }) => {
      const config = PublicBrowserConfigSchema.parse(
        await registry.resourceQueries.getPublicConfig(),
      );
      return { ...config };
    },
  });
}

export async function getMerchant(request: Request, context: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'none',
    publicCache: { sMaxAgeSeconds: 30, staleWhileRevalidateSeconds: 120 },
    execute: async ({ registry }) => {
      const merchantSlug = await routeParam(context, 'merchantSlug', SlugSchema);
      const catalog = await registry.queries.getMerchantCatalog(merchantSlug);
      return catalog === undefined ? undefined : { ...catalog };
    },
  });
}

export async function getProduct(request: Request, context: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'none',
    publicCache: { sMaxAgeSeconds: 30, staleWhileRevalidateSeconds: 120 },
    execute: async ({ registry }) => {
      const productId = await routeParam(context, 'productId', ProductIdSchema);
      const product = await registry.queries.getPublicProductById(productId);
      return product === undefined ? undefined : { ...product };
    },
  });
}

export async function getProductBySlugs(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleQuery({
    request,
    auth: 'none',
    publicCache: { sMaxAgeSeconds: 30, staleWhileRevalidateSeconds: 120 },
    execute: async ({ registry }) => {
      const merchantSlug = await routeParam(context, 'merchantSlug', SlugSchema);
      const productSlug = await routeParam(context, 'productSlug', SlugSchema);
      const product = await registry.queries.getPublicProductBySlugs(merchantSlug, productSlug);
      return product === undefined ? undefined : { ...product };
    },
  });
}

export async function getCheckoutLink(request: Request, context: RouteContext): Promise<Response> {
  return handleQuery({
    request,
    auth: 'optional',
    execute: async ({ registry, actor }) => {
      const reference = await routeParam(context, 'reference', OpaqueReferenceSchema);
      return registry.resourceQueries.getCheckoutLink(reference, actor);
    },
  });
}

export async function getProductPassMetadata(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let digest = '';
  return handleQuery({
    request,
    auth: 'none',
    publicCache: { sMaxAgeSeconds: 300, staleWhileRevalidateSeconds: 900 },
    exactJsonBody: true,
    etag: () => `"${digest}"`,
    execute: async ({ registry }) => {
      const productId = await routeParam(context, 'productId', ProductIdSchema);
      const record = await registry.queries.getPassMetadataProduct(productId);
      if (record === undefined) return undefined;
      const metadata = metadataFromStoredProduct(record.product);
      digest = productMetadataDigest(metadata);
      if (digest !== record.product.metadataHash) {
        throw new AppError(
          'CONFIGURATION_INVALID',
          'The canonical product metadata is unavailable.',
        );
      }
      return metadata;
    },
  });
}
