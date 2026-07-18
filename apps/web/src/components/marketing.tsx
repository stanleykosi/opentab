import { CanonicalStatus, LinkButton, MoneyAmount, PassFrame } from '@opentab/ui';
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Link2,
  QrCode,
  ReceiptText,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Split,
  Store,
  WalletCards,
} from 'lucide-react';
import Image from 'next/image';
import type { FrontendFeatureState } from '../client/view-models';
import styles from './marketing.module.css';
import { BrandMark, SiteHeader } from './shell';

const technology = [
  { mark: '1', name: 'Familiar sign-in', detail: 'Google or email' },
  { mark: '2', name: 'One available balance', detail: 'No manual bridging' },
  { mark: '3', name: 'Verified settlement', detail: 'Paid means confirmed' },
  { mark: '$', name: 'Stable pricing', detail: 'Clear USDC totals' },
] as const;

const salesBars = [
  { day: 'Mon', height: 38 },
  { day: 'Tue', height: 52 },
  { day: 'Wed', height: 44 },
  { day: 'Thu', height: 70 },
  { day: 'Fri', height: 96 },
  { day: 'Sat', height: 62 },
] as const;

const faqItems = [
  {
    question: 'Do customers need a crypto wallet?',
    answer:
      'They do not need to install a browser extension or manage a seed phrase. Customers sign in with Google or email, OpenTab prepares an embedded account, and they still review and approve the exact payment.',
  },
  {
    question: 'What does “one available balance” mean?',
    answer:
      'OpenTab can show eligible supported balances together and prepare the route needed for the purchase. Customers do not have to manually bridge or move those funds before checkout.',
  },
  {
    question: 'When does a merchant see an order as paid?',
    answer:
      'Only after OpenTab observes the matching, successful, confirmed settlement event. A provider submission response alone is never treated as payment truth.',
  },
  {
    question: 'Are fees and totals shown before approval?',
    answer:
      'Yes. The product total, estimated payment cost, maximum total, and quote expiry are shown before the customer approves. An expired quote is refreshed before payment can continue.',
  },
  {
    question: 'What happens after checkout?',
    answer:
      'Customers receive a durable receipt and event-style pass, can follow refund status and loyalty progress, and can create private reimbursement links without changing the original merchant order.',
  },
] as const;

export function MarketingHome({ features }: { features: FrontendFeatureState }) {
  const demoAvailable = features.mode === 'deterministic';
  return (
    <div className={styles.page}>
      <SiteHeader features={features} marketing />

      <main id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Walletless checkout for real-world commerce</p>
            <h1>Sell anywhere. Settle with certainty.</h1>
            <p className={styles.heroLede}>
              Create one link or QR for any offer. Customers pay from supported digital-asset
              balances without installing a wallet, and you see an order only after it truly
              settles.
            </p>
            <div className={styles.heroActions}>
              <LinkButton href="/merchant/onboarding" size="large">
                Start selling <ArrowRight aria-hidden="true" size={18} />
              </LinkButton>
              <LinkButton
                href={demoAvailable ? '/c/daylight-room/sunday-table' : '/account'}
                size="large"
                variant="secondary"
              >
                {demoAvailable ? 'Open the demo tab' : 'View my purchases'}
              </LinkButton>
            </div>
            {demoAvailable ? null : (
              <p className={styles.buyerPath}>
                Buying something? Open the checkout link from the merchant or scan their QR to
                begin.
              </p>
            )}
            <div className={styles.heroProof}>
              <span>
                <Check aria-hidden="true" size={15} /> No wallet extension
              </span>
              <span>
                <Check aria-hidden="true" size={15} /> Exact total before approval
              </span>
            </div>
          </div>

          <aside aria-label="OpenTab checkout in use" className={styles.heroVisual}>
            <Image
              alt="A hand holding a phone with a simple event checkout on screen"
              fill
              priority
              sizes="(max-width: 832px) calc(100vw - 16px), 52vw"
              src="/images/marketing/hero-checkout.jpg"
            />
            <div className={styles.heroBalance}>
              <span>Available to spend</span>
              <strong>$64.28</strong>
              <small>Across supported balances</small>
            </div>
            <div className={styles.heroConfirmed}>
              <BadgeCheck aria-hidden="true" size={20} />
              <span>
                <strong>Order confirmed</strong>
                <small>Settlement verified</small>
              </span>
            </div>
          </aside>
        </section>

        <section aria-labelledby="technology-heading" className={styles.technology}>
          <p id="technology-heading">A checkout customers can understand</p>
          <ul>
            {technology.map((item) => (
              <li key={item.name}>
                <span aria-hidden="true">{item.mark}</span>
                <div className={styles.techCopy}>
                  <strong className={styles.techName}>{item.name}</strong>
                  <small className={styles.techDetail}>{item.detail}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section} id="features">
          <div className={styles.centeredHeading}>
            <p className={styles.kicker}>Built for the way you already sell</p>
            <h2>From “I have an idea” to a checkout people can actually use.</h2>
            <p>
              OpenTab hides the network choreography without hiding the choices that matter: price,
              payment cost, refund terms, and final confirmation.
            </p>
          </div>

          <div className={styles.commerceGrid}>
            <article className={`${styles.commerceCard} ${styles.commercePhoto}`}>
              <Image
                alt="An independent cafe merchant placing a QR checkout card on the counter"
                fill
                sizes="(max-width: 832px) calc(100vw - 32px), 55vw"
                src="/images/marketing/merchant-qr.jpg"
              />
              <div className={styles.photoCaption}>
                <span>Sell in the room</span>
                <strong>One QR. No wallet lecture.</strong>
              </div>
            </article>

            <article className={`${styles.commerceCard} ${styles.linkCard}`}>
              <div className={styles.cardIcon}>
                <Link2 aria-hidden="true" size={21} />
              </div>
              <div>
                <h3>One offer, ready to share</h3>
                <p>Publish a priced checkout, then share its link or print its QR.</p>
              </div>
              <div className={styles.linkPreview} aria-hidden="true">
                <span>opentab.app/c/daylight-room</span>
                <QrCode size={70} strokeWidth={1.6} />
              </div>
            </article>

            <article className={`${styles.commerceCard} ${styles.statCard}`}>
              <span>Customer steps</span>
              <strong>1 sign-in</strong>
              <strong>1 review</strong>
              <strong>1 approval</strong>
            </article>
          </div>
        </section>

        <section className={`${styles.section} ${styles.featuresSection}`}>
          <div className={styles.centeredHeading}>
            <h2>The crypto complexity stays backstage.</h2>
            <p>
              Every surface is designed around a calm purchase, an exact ledger, and a result that
              can be proved later.
            </p>
          </div>

          <div className={styles.featureGrid}>
            <article className={`${styles.featureCard} ${styles.featureCardWide}`}>
              <div>
                <div className={styles.cardIcon}>
                  <WalletCards aria-hidden="true" size={21} />
                </div>
                <h3>One available balance</h3>
                <p>Eligible supported funds appear together, ready for one checkout.</p>
              </div>
              <div className={styles.balanceVisual}>
                <span>Available to spend</span>
                <strong>$64.28</strong>
                <div>
                  <p>
                    <i /> Available balance A <b>$12.14</b>
                  </p>
                  <p>
                    <i /> Available balance B <b>$52.14</b>
                  </p>
                </div>
              </div>
            </article>

            <article className={styles.featureCard}>
              <div>
                <div className={styles.cardIcon}>
                  <ScanLine aria-hidden="true" size={21} />
                </div>
                <h3>An exact review</h3>
                <p>The customer sees the item, cost, maximum total, and terms before approval.</p>
              </div>
              <dl className={styles.quoteVisual}>
                <div>
                  <dt>Sunday Table</dt>
                  <dd>$18.00</dd>
                </div>
                <div>
                  <dt>Estimated payment cost</dt>
                  <dd>$0.14</dd>
                </div>
                <div>
                  <dt>Maximum total</dt>
                  <dd>$18.14</dd>
                </div>
              </dl>
            </article>

            <article className={styles.featureCard}>
              <div>
                <div className={styles.cardIcon}>
                  <ShieldCheck aria-hidden="true" size={21} />
                </div>
                <h3>Honest payment status</h3>
                <p>Submitted is not paid. OpenTab waits for confirmed settlement.</p>
              </div>
              <div className={styles.statusVisual}>
                <p>
                  <i /> Payment approved <Check aria-hidden="true" size={15} />
                </p>
                <p>
                  <i /> Moving funds securely <Check aria-hidden="true" size={15} />
                </p>
                <p className={styles.statusCurrent}>
                  <i /> Confirming your order <RefreshCw aria-hidden="true" size={15} />
                </p>
              </div>
            </article>

            <article className={`${styles.featureCard} ${styles.featureCardWide}`}>
              <div>
                <div className={styles.cardIcon}>
                  <ReceiptText aria-hidden="true" size={21} />
                </div>
                <h3>A receipt that keeps working</h3>
                <p>Confirmation, pass access, loyalty, refund progress, and private splitting.</p>
              </div>
              <div className={styles.receiptVisual}>
                <div>
                  <span>Sunday Table</span>
                  <strong>Paid &amp; confirmed</strong>
                </div>
                <div className={styles.receiptActions}>
                  <span>
                    <ReceiptText aria-hidden="true" size={16} /> Pass
                  </span>
                  <span>
                    <Split aria-hidden="true" size={16} /> Split
                  </span>
                  <span>
                    <BadgeCheck aria-hidden="true" size={16} /> Proof
                  </span>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className={`${styles.section} ${styles.merchantSection}`} id="how-it-works">
          <div className={styles.merchantCopy}>
            <p className={styles.kicker}>The merchant loop</p>
            <h2>Open before the doors do.</h2>
            <p>
              Build the offer, put the checkout where customers already are, and manage the money
              from records designed around settlement truth.
            </p>
            <ol>
              <li>
                <span>01</span>
                <div>
                  <strong>Create the offer</strong>
                  <p>Set price, inventory, timing, loyalty, and refund terms.</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Share the checkout</strong>
                  <p>Use a link online or place the printable QR in the room.</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Run from confirmed records</strong>
                  <p>Track orders, refunds, pending funds, and withdrawable settlement.</p>
                </div>
              </li>
            </ol>
            <LinkButton href="/merchant" variant="secondary">
              Explore merchant tools <ArrowRight aria-hidden="true" size={17} />
            </LinkButton>
          </div>

          <aside aria-label="Example OpenTab merchant dashboard" className={styles.dashboard}>
            <header>
              <div>
                <span>OpenTab merchant console</span>
                <strong>Daylight Room</strong>
              </div>
              <CanonicalStatus label="Records fresh" tone="confirmed" />
            </header>
            <div className={styles.metricGrid}>
              <article>
                <span className={styles.metricLabel}>Settled sales</span>
                <MoneyAmount baseUnits="468000000" />
              </article>
              <article>
                <span className={styles.metricLabel}>Pending</span>
                <MoneyAmount baseUnits="54000000" />
              </article>
              <article className={styles.metricAccent}>
                <span className={styles.metricLabel}>Available</span>
                <MoneyAmount baseUnits="396000000" />
              </article>
            </div>
            <div className={styles.chartCard}>
              <div>
                <span>Settled sales</span>
                <small>Last six days</small>
              </div>
              <div className={styles.chart} aria-hidden="true">
                {salesBars.map((bar) => (
                  <i key={bar.day} style={{ blockSize: `${bar.height}%` }} />
                ))}
              </div>
            </div>
            <div className={styles.orderRows}>
              <div>
                <span>Sunday Table · S. Ade</span>
                <MoneyAmount baseUnits="18000000" />
                <CanonicalStatus label="Paid" tone="confirmed" />
              </div>
              <div>
                <span>Sunday Table · M. Bello</span>
                <MoneyAmount baseUnits="36000000" />
                <CanonicalStatus label="Confirming" tone="processing" />
              </div>
            </div>
          </aside>
        </section>

        <section className={`${styles.section} ${styles.afterSection}`} id="after-checkout">
          <div className={styles.afterVisual}>
            <Image
              alt="Friends at brunch looking at a digital event pass on a phone"
              fill
              sizes="(max-width: 832px) calc(100vw - 16px), 50vw"
              src="/images/marketing/brunch-pass.jpg"
            />
          </div>
          <div className={styles.afterCopy}>
            <p className={styles.kicker}>After checkout</p>
            <h2>The order ends. The relationship does not.</h2>
            <p>
              A confirmed purchase becomes a useful home for access, support, loyalty, and sharing
              the cost with friends.
            </p>
            <div className={styles.afterBenefits}>
              <p>
                <ReceiptText aria-hidden="true" size={19} />
                <span>
                  <strong>Durable receipt &amp; pass</strong>
                  Find the order and its current status again.
                </span>
              </p>
              <p>
                <BadgeCheck aria-hidden="true" size={19} />
                <span>
                  <strong>Loyalty that follows the purchase</strong>
                  Keep progress beside the confirmed order.
                </span>
              </p>
              <p>
                <Split aria-hidden="true" size={19} />
                <span>
                  <strong>Private split reimbursement</strong>
                  Share exact private links without exposing payment details.
                </span>
              </p>
            </div>
            <div className={styles.passWrap}>
              <PassFrame
                className={styles.compactPass ?? ''}
                date="Sunday · 12:00"
                location="The Palm Courtyard · Lagos"
                merchant="Daylight Room"
                title="Sunday Table"
              />
            </div>
          </div>
        </section>

        <section className={styles.trustSection} id="trust">
          <div className={styles.trustHeading}>
            <p className={styles.kicker}>Settlement you can stand behind</p>
            <h2>“Paid” means confirmed. Not merely submitted.</h2>
            <p>
              OpenTab follows the payment all the way to confirmed settlement, then preserves a
              public-safe evidence trail for the result.
            </p>
          </div>
          <div className={styles.truthFlow}>
            <div>
              <span aria-hidden="true">1</span>
              <strong>Customer approves</strong>
              <small>Exact bound payment</small>
            </div>
            <i aria-hidden="true" />
            <div>
              <span aria-hidden="true">2</span>
              <strong>Route executes</strong>
              <small>Supported funds move</small>
            </div>
            <i aria-hidden="true" />
            <div>
              <span aria-hidden="true">3</span>
              <strong>Settlement confirms</strong>
              <small>Verified event observed</small>
            </div>
            <i aria-hidden="true" />
            <div>
              <span aria-hidden="true">✓</span>
              <strong>Order is paid</strong>
              <small>Receipt becomes authoritative</small>
            </div>
          </div>
          <div className={styles.guardrails}>
            <p>
              <RefreshCw aria-hidden="true" size={20} />
              <span>
                <strong>Reload-safe recovery</strong>
                Saved operations can be checked without paying twice.
              </span>
            </p>
            <p>
              <ShieldCheck aria-hidden="true" size={20} />
              <span>
                <strong>Confirmed source of truth</strong>
                Provider status alone never marks the order paid.
              </span>
            </p>
            <p>
              <BadgeCheck aria-hidden="true" size={20} />
              <span>
                <strong>Privacy-safe proof</strong>
                Verify the result without exposing private payment data.
              </span>
            </p>
          </div>
        </section>

        <section className={`${styles.section} ${styles.faqSection}`}>
          <div>
            <p className={styles.kicker}>The practical questions</p>
            <h2>Clear before anyone checks out.</h2>
            <p>
              OpenTab is designed to make the payment understandable for customers and operationally
              honest for merchants.
            </p>
          </div>
          <div className={styles.faqList}>
            {faqItems.map((item) => (
              <details key={item.question}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.finalCta}>
          <div>
            <p className={styles.kicker}>Your next offer can be open in minutes</p>
            <h2>Make checkout the easiest part of showing up.</h2>
            <p>
              {demoAvailable
                ? 'Create the offer as a merchant, or walk through the complete deterministic buyer journey first.'
                : 'Create an offer, publish its checkout, and share the link or QR with customers.'}
            </p>
            <div className={styles.finalActions}>
              <LinkButton href="/merchant/onboarding" size="large">
                Create a checkout <ArrowRight aria-hidden="true" size={18} />
              </LinkButton>
              <LinkButton
                href={demoAvailable ? '/c/daylight-room/sunday-table' : '#how-it-works'}
                size="large"
                variant="secondary"
              >
                {demoAvailable ? 'Try the buyer demo' : 'See how it works'}
              </LinkButton>
            </div>
          </div>
          <div className={styles.ctaArtifacts} aria-hidden="true">
            <div>
              <Store size={20} />
              <span>Offer published</span>
              <strong>Sunday Table</strong>
            </div>
            <div>
              <BadgeCheck size={20} />
              <span>Order confirmed</span>
              <strong>$18.00 settled</strong>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <div>
            <BrandMark className={styles.footerBrand} />
            <p>Walletless checkout for events, creators, cafés, and pop-ups.</p>
          </div>
          <nav aria-label="Product">
            <strong>Product</strong>
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="/account">My passes</a>
          </nav>
          <nav aria-label="Company and trust">
            <strong>Trust</strong>
            <a href="#trust">Settlement</a>
            <a href="/status">System status</a>
            <a href="/merchant">Merchant console</a>
          </nav>
        </div>
        <div className={styles.footerBottom}>
          <span>Built for calm, provable commerce.</span>
          <span>OpenTab</span>
        </div>
      </footer>
    </div>
  );
}
