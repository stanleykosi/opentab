import { CanonicalStatus, LinkButton, MoneyAmount, PassFrame, ProgressTimeline } from '@opentab/ui';
import type { FrontendFeatureState } from '../client/view-models';
import { SiteHeader } from './shell';

const heroTimeline = [
  { id: 'approved', label: 'Payment approved', status: 'complete' as const },
  { id: 'move', label: 'Moving funds securely', status: 'complete' as const },
  { id: 'confirm', label: 'Confirming your order', status: 'current' as const },
  { id: 'pass', label: 'Creating your pass', status: 'upcoming' as const },
];

export function MarketingHome({ features }: { features: FrontendFeatureState }) {
  return (
    <>
      <SiteHeader features={features} />
      <main id="main-content">
        <section className="marketing-hero">
          <div className="marketing-hero__copy">
            <p className="eyebrow">Scan. Sign in. Settle in.</p>
            <h1>A checkout that meets your balance where it is.</h1>
            <p className="hero-lede">
              OpenTab turns any event, café, or pop-up link into one calm payment—no extension, no
              manual moving of funds, and a pass that is ready when the order is truly confirmed.
            </p>
            <div className="page-actions">
              <LinkButton href="/c/daylight-room/sunday-table" size="large">
                Open the demo tab
              </LinkButton>
              <LinkButton href="/merchant/onboarding" size="large" variant="secondary">
                Create a checkout
              </LinkButton>
            </div>
            <p className="trust-line">
              <span aria-hidden="true">✓</span> Digital-asset checkout with the total shown before
              approval.
            </p>
          </div>
          <aside aria-label="OpenTab checkout preview" className="hero-artifact">
            <div className="hero-artifact__ticket">
              <div className="hero-artifact__topline">
                <span>Daylight Room</span>
                <CanonicalStatus label="22 left" tone="attention" />
              </div>
              <p className="eyebrow">Sunday · 12:00</p>
              <h2>Sunday Table</h2>
              <p>A long-table brunch, seasonal plates, and a live vinyl set.</p>
              <div className="hero-artifact__total">
                <span>Your total</span>
                <MoneyAmount baseUnits="18000000" />
              </div>
              <div className="settlement-seam" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <ProgressTimeline items={heroTimeline} label="Example payment progress" />
            </div>
          </aside>
        </section>

        <section aria-label="OpenTab qualities" className="trust-strip">
          <p>
            <strong>One familiar sign-in</strong>
            <span>Google or email, right in the browser.</span>
          </p>
          <p>
            <strong>One available balance</strong>
            <span>Supported funds are brought together automatically.</span>
          </p>
          <p>
            <strong>One honest receipt</strong>
            <span>Complete only after the order is confirmed.</span>
          </p>
        </section>

        <section className="story-section">
          <div className="section-heading">
            <p className="eyebrow">A better open tab</p>
            <h2>The infrastructure steps disappear. The important choices stay.</h2>
          </div>
          <div className="story-grid">
            <article>
              <span>Open</span>
              <h3>Share one link</h3>
              <p>Publish a priced offer, then put its QR wherever your customers already are.</p>
            </article>
            <article>
              <span>Review</span>
              <h3>See the exact total</h3>
              <p>
                Customers review the item, payment cost, and refund terms before a single approval.
              </p>
            </article>
            <article>
              <span>Keep</span>
              <h3>Receive a living receipt</h3>
              <p>The pass holds order status, loyalty progress, and a privacy-safe proof trail.</p>
            </article>
          </div>
        </section>

        <section className="pass-story">
          <div className="pass-story__artifact">
            <PassFrame
              date="Sunday · 12:00"
              location="The Palm Courtyard · Lagos"
              merchant="Daylight Room"
              title="Sunday Table"
            />
          </div>
          <div>
            <p className="eyebrow">Built for after checkout, too</p>
            <h2>Your pass is more than the end screen.</h2>
            <p>
              Find it again, follow refund status, collect loyalty progress, or split the purchase
              with friends—all without exposing private payment details.
            </p>
            <LinkButton href="/receipt/ord_demo_7R2K9D" variant="secondary">
              View the demo pass
            </LinkButton>
          </div>
        </section>

        <section className="merchant-callout">
          <div>
            <p className="eyebrow">For people who sell in real rooms</p>
            <h2>Open a checkout before the doors open.</h2>
          </div>
          <div>
            <p>
              Create the offer, print the QR, watch confirmed orders arrive, and withdraw only what
              is safely available.
            </p>
            <LinkButton href="/merchant" size="large">
              Explore merchant tools
            </LinkButton>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <span>OpenTab</span>
        <p>Calm checkout for events, creators, cafés, and pop-ups.</p>
        <nav aria-label="Footer">
          <a href="/status">System status</a>
          <a href="/account">My passes</a>
        </nav>
      </footer>
    </>
  );
}
