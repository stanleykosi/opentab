import { CanonicalStatus, LinkButton, MoneyAmount } from '@opentab/ui';
import Image from 'next/image';
import type {
  MerchantDashboardView,
  PresentationMode,
  ProductView,
} from '../../client/view-models';
import { ProductCheckout } from './product-checkout';

function availabilityStatus(product: ProductView) {
  switch (product.availability.state) {
    case 'available':
      return {
        label:
          product.availability.remaining === undefined
            ? 'Available'
            : `${product.availability.remaining} left`,
        tone: 'attention' as const,
      };
    case 'scheduled':
      return { label: 'Coming soon', tone: 'neutral' as const };
    case 'sold_out':
      return { label: 'Sold out', tone: 'failed' as const };
    case 'paused':
      return { label: 'Temporarily paused', tone: 'attention' as const };
    case 'ended':
      return { label: 'Sale ended', tone: 'neutral' as const };
  }
}

export function MerchantIdentity({ dashboard }: { dashboard: MerchantDashboardView }) {
  return (
    <header className="storefront-head">
      <div aria-hidden="true" className="merchant-monogram">
        {dashboard.merchant.monogram}
      </div>
      <div>
        <p className="eyebrow">Independent merchant</p>
        <h1>{dashboard.merchant.displayName}</h1>
        <p>Browse current offers and review exact terms before starting checkout.</p>
      </div>
      {dashboard.merchant.verified ? (
        <CanonicalStatus label="Verified merchant" tone="confirmed" />
      ) : null}
    </header>
  );
}

export function ProductCard({
  dashboardProduct,
}: {
  dashboardProduct: MerchantDashboardView['products'][number];
}) {
  return (
    <article className="product-card">
      <div className="product-card__visual">
        <span>{dashboardProduct.title.slice(0, 1)}</span>
      </div>
      <div className="product-card__body">
        <CanonicalStatus
          label={
            dashboardProduct.status === 'active'
              ? 'Available'
              : dashboardProduct.status.replaceAll('_', ' ')
          }
          tone={dashboardProduct.status === 'active' ? 'confirmed' : 'attention'}
        />
        <h2>{dashboardProduct.title}</h2>
        <MoneyAmount baseUnits={dashboardProduct.priceBaseUnits} />
        <LinkButton href={dashboardProduct.checkoutUrl}>View offer</LinkButton>
      </div>
    </article>
  );
}

export function ProductPageView({
  mode,
  paymentsEnabled = true,
  product,
}: {
  mode: PresentationMode;
  paymentsEnabled?: boolean;
  product: ProductView;
}) {
  const availability = availabilityStatus(product);
  return (
    <div className="product-page-grid">
      <section className="product-visual" aria-label={product.imageAlt}>
        <Image
          alt={product.imageAlt}
          height={960}
          priority
          sizes="(max-width: 832px) calc(100vw - 16px), min(48vw, 704px)"
          src={product.imagePath}
          width={960}
        />
        <span className="product-visual__category">{product.category}</span>
      </section>
      <div className="product-details">
        <header className="product-merchant">
          <span className="merchant-monogram merchant-monogram--small" aria-hidden="true">
            {product.merchant.monogram}
          </span>
          <div>
            <strong>{product.merchant.displayName}</strong>
            <span>Verified independent merchant</span>
          </div>
        </header>
        <CanonicalStatus {...availability} />
        <h1>{product.title}</h1>
        <p className="product-description">{product.description}</p>
        <dl className="event-facts">
          <div>
            <dt>When</dt>
            <dd>
              {new Intl.DateTimeFormat('en-GB', {
                dateStyle: 'full',
                timeStyle: 'short',
                timeZone: 'UTC',
              }).format(new Date(product.startsAt))}
            </dd>
          </div>
          <div>
            <dt>Where</dt>
            <dd>{product.location}</dd>
          </div>
          <div>
            <dt>Included</dt>
            <dd>The offer described above and its confirmed digital receipt</dd>
          </div>
        </dl>
        <ProductCheckout mode={mode} paymentsEnabled={paymentsEnabled} product={product} />
        <details className="disclosure">
          <summary>Terms, refunds, and payment details</summary>
          <div>
            <p>{product.refundTerms}</p>
            <p>
              Payment uses supported digital assets. OpenTab shows the total and estimated payment
              cost before approval.
            </p>
            <p>
              Support:{' '}
              <a className="support-link" href={`mailto:${product.merchant.supportContact}`}>
                {product.merchant.supportContact}
              </a>
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
