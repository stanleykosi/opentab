import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../../src/client/presentation-mode';
import { LiveProductDetail } from '../../../../src/components/merchant/live-product-detail';
import { FeatureUnavailable, MerchantShell } from '../../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Manage product',
  robots: { index: false, follow: false },
};

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant/products" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Product management requires an authenticated merchant application service."
          title="Product unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveProductDetail productId={productId} />
      ) : (
        <DeterministicProductDetail productId={productId} />
      )}
    </MerchantShell>
  );
}

async function DeterministicProductDetail({ productId }: { productId: string }) {
  const [{ notFound }, { demoDashboard }, { ProductDetail }] = await Promise.all([
    import('next/navigation'),
    import('../../../../src/client/deterministic-data'),
    import('../../../../src/components/merchant/details'),
  ]);
  const productTemplate = demoDashboard.products[0];
  const product =
    demoDashboard.products.find((item) => item.id === productId) ??
    (productId === 'prd_demo_new' && productTemplate
      ? {
          ...productTemplate,
          id: productId,
          title: 'Golden Hour Supper',
          slug: 'golden-hour-supper',
          priceBaseUnits: '24000000',
          checkoutUrl: '/c/daylight-room/golden-hour-supper',
        }
      : undefined);
  if (!product) return notFound();
  return <ProductDetail product={product} />;
}
