import type { Metadata } from 'next';
import { getServerFeatureState } from '../../../../src/client/presentation-mode';
import { LiveProductForm } from '../../../../src/components/merchant/live-product-form';
import { ProductForm } from '../../../../src/components/merchant/product-form';
import { FeatureUnavailable, MerchantShell } from '../../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Create product',
  robots: { index: false, follow: false },
};

export default function NewProductPage() {
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant/products" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Product publication is disabled until merchant authorization and contract readiness are configured."
          title="Product creation unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveProductForm />
      ) : (
        <ProductForm mode={features.mode} />
      )}
    </MerchantShell>
  );
}
