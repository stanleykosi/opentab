import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerFeatureState } from '../../../../src/client/presentation-mode';
import { CustomerShell, FeatureUnavailable } from '../../../../src/components/shell';
import { LiveProductPage } from '../../../../src/components/storefront/live-product-page';
import { ProductPageView } from '../../../../src/components/storefront/storefront';

export const metadata: Metadata = {
  title: 'Offer',
  description: 'View a verified merchant offer and continue to secure checkout.',
};

export default async function ProductPage({
  params,
}: {
  params: Promise<{ merchantSlug: string; productSlug: string }>;
}) {
  const { merchantSlug, productSlug } = await params;
  const features = getServerFeatureState();
  if (features.mode === 'live-unavailable') {
    return (
      <CustomerShell features={features} narrow={false}>
        <FeatureUnavailable
          body="Public product data and payment providers are not configured for this environment."
          title="Checkout is not available"
        />
      </CustomerShell>
    );
  }
  if (features.mode === 'live') {
    return (
      <CustomerShell features={features} narrow={false}>
        <LiveProductPage
          merchantSlug={merchantSlug}
          paymentsEnabled={features.payments}
          productSlug={productSlug}
        />
      </CustomerShell>
    );
  }

  const { demoProduct } = await import('../../../../src/client/deterministic-data');
  if (
    merchantSlug !== demoProduct.merchant.slug ||
    !['sunday-table', 'golden-hour-supper'].includes(productSlug)
  )
    notFound();
  const product =
    productSlug === 'golden-hour-supper'
      ? {
          ...demoProduct,
          id: 'prd_demo_new',
          slug: productSlug,
          title: 'Golden Hour Supper',
          description: 'A six-seat supper with a seasonal menu and sunset listening session.',
          unitPriceBaseUnits: '24000000',
          availability: { state: 'available' as const, remaining: '18' },
        }
      : demoProduct;
  return (
    <CustomerShell features={features} narrow={false}>
      <ProductPageView mode={features.mode} product={product} />
    </CustomerShell>
  );
}
