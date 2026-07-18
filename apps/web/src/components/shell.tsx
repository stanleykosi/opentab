import { LinkButton } from '@opentab/ui';
import type { ReactNode } from 'react';
import type { FrontendFeatureState } from '../client/view-models';
import { SessionControl } from './session-control';

export function BrandSymbol() {
  return (
    <span aria-hidden="true" className="brand__mark">
      <svg focusable="false" viewBox="0 0 32 32">
        <title>OpenTab symbol</title>
        <path d="M18.4 9.04A8.5 8.5 0 1 0 18.4 22.96" />
        <rect className="brand__tab" height="4" rx="2" width="9" x="17.5" y="14" />
      </svg>
    </span>
  );
}

export function BrandMark({
  className,
  compact = false,
}: {
  className?: string | undefined;
  compact?: boolean;
}) {
  return (
    <a aria-label="OpenTab home" className={className ? `brand ${className}` : 'brand'} href="/">
      <BrandSymbol />
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
  marketing = false,
  quiet = false,
}: {
  features: FrontendFeatureState;
  marketing?: boolean;
  quiet?: boolean;
}) {
  return (
    <>
      <DemoBanner features={features} />
      <header className={quiet ? 'site-header site-header--quiet' : 'site-header'}>
        <BrandMark />
        <nav aria-label="Main navigation" className="site-header__nav">
          {marketing ? (
            <span className="site-header__sections">
              <a href="#features">Features</a>
              <a href="#how-it-works">How it works</a>
              <a href="#trust">Trust</a>
            </span>
          ) : (
            <a href="/status">Status</a>
          )}
          <a href="/account">My passes</a>
          {features.mode === 'live' ? <SessionControl /> : null}
          <LinkButton
            href={marketing ? '/merchant/onboarding' : '/merchant'}
            size="compact"
            variant={marketing ? 'primary' : 'secondary'}
          >
            {marketing ? 'Start selling' : 'For merchants'}
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
