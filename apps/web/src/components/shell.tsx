import { LinkButton } from '@opentab/ui';
import type { ReactNode } from 'react';
import type { FrontendFeatureState } from '../client/view-models';
import { SessionControl } from './session-control';

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <a aria-label="OpenTab home" className="brand" href="/">
      <span aria-hidden="true" className="brand__mark">
        <i />
        <i />
        <i />
      </span>
      {compact ? null : <span>OpenTab</span>}
    </a>
  );
}

export function DemoBanner({ features }: { features: FrontendFeatureState }) {
  if (features.mode !== 'deterministic') return null;
  return (
    <aside className="demo-banner" role="status">
      <strong>Deterministic demo</strong>
      <span>No live funds move. Every demo record is synthetic and visibly labeled.</span>
    </aside>
  );
}

export function SiteHeader({
  features,
  quiet = false,
}: {
  features: FrontendFeatureState;
  quiet?: boolean;
}) {
  return (
    <>
      <DemoBanner features={features} />
      <header className={quiet ? 'site-header site-header--quiet' : 'site-header'}>
        <BrandMark />
        <nav aria-label="Main navigation" className="site-header__nav">
          <a href="/status">Status</a>
          <a href="/account">My passes</a>
          {features.mode === 'live' ? <SessionControl /> : null}
          <LinkButton href="/merchant" size="compact" variant="secondary">
            For merchants
          </LinkButton>
        </nav>
      </header>
    </>
  );
}

const merchantLinks = [
  { href: '/merchant', label: 'Overview', short: 'Overview' },
  { href: '/merchant/products', label: 'Products', short: 'Products' },
  { href: '/merchant/orders', label: 'Orders', short: 'Orders' },
  { href: '/merchant/balance', label: 'Balance', short: 'Balance' },
] as const;

export function MerchantShell({
  children,
  features,
  active,
}: {
  children: ReactNode;
  features: FrontendFeatureState;
  active: string;
}) {
  return (
    <div className="merchant-app">
      <DemoBanner features={features} />
      <aside className="merchant-rail">
        <BrandMark />
        <nav aria-label="Merchant navigation">
          {merchantLinks.map((link) => (
            <a
              aria-current={active === link.href ? 'page' : undefined}
              href={link.href}
              key={link.href}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <a className="merchant-rail__settings" href="/merchant/settings">
          Settings
        </a>
      </aside>
      <div className="merchant-main">
        <header className="merchant-topbar">
          <BrandMark compact />
          <span>Merchant console</span>
          <a href="/merchant/settings">
            {features.mode === 'deterministic' ? 'Daylight Room' : 'Merchant account'}
          </a>
        </header>
        <main id="main-content">{children}</main>
      </div>
      <nav aria-label="Merchant mobile navigation" className="merchant-bottom-nav">
        {merchantLinks.map((link) => (
          <a
            aria-current={active === link.href ? 'page' : undefined}
            href={link.href}
            key={link.href}
          >
            {link.short}
          </a>
        ))}
      </nav>
    </div>
  );
}

export function CustomerShell({
  children,
  features,
  narrow = true,
}: {
  children: ReactNode;
  features: FrontendFeatureState;
  narrow?: boolean;
}) {
  return (
    <>
      <SiteHeader features={features} quiet />
      <main
        className={narrow ? 'customer-page customer-page--narrow' : 'customer-page'}
        id="main-content"
      >
        {children}
      </main>
    </>
  );
}

export function FeatureUnavailable({ title, body }: { title: string; body: string }) {
  return (
    <section className="unavailable-panel">
      <p className="eyebrow">Live path safely disabled</p>
      <h1>{title}</h1>
      <p>{body}</p>
      <p className="support-copy">No provider action was started and no funds moved.</p>
      <LinkButton href="/status" variant="secondary">
        View system status
      </LinkButton>
    </section>
  );
}
