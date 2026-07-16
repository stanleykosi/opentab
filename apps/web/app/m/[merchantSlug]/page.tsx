import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { CustomerShell, FeatureUnavailable } from '../../../src/components/shell';
import { LiveMerchantStorefront } from '../../../src/components/storefront/live-merchant-storefront';
import { MerchantIdentity, ProductCard } from '../../../src/components/storefront/storefront';

export const metadata: Metadata = {
  title: 'Merchant storefront',
  description: 'Active merchant offers on OpenTab.',
};

export default async function StorefrontPage({
  params,
}: {
  params: Promise<{ merchantSlug: string }>;
}) {
  const { merchantSlug } = await params;
  const features = getServerFeatureState();
  return (
    <CustomerShell features={features} narrow={false}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="The public merchant catalog is unavailable until live server configuration is complete."
          title="Storefront unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveMerchantStorefront merchantSlug={merchantSlug} />
      ) : (
        <DeterministicStorefront merchantSlug={merchantSlug} />
      )}
    </CustomerShell>
  );
}

async function DeterministicStorefront({ merchantSlug }: { merchantSlug: string }) {
  const { notFound } = await import('next/navigation');
  const { demoDashboard } = await import('../../../src/client/deterministic-data');
  if (merchantSlug !== demoDashboard.merchant.slug) notFound();
  return (
    <div className="storefront-page">
      <MerchantIdentity dashboard={demoDashboard} />
      <section>
        <div className="section-heading">
          <p className="eyebrow">Open tabs</p>
          <h2>Choose what brings you in</h2>
        </div>
        <div className="product-grid">
          {demoDashboard.products
            .filter((product) => product.status === 'active')
            .map((product) => (
              <ProductCard dashboardProduct={product} key={product.id} />
            ))}
        </div>
      </section>
    </div>
  );
}
