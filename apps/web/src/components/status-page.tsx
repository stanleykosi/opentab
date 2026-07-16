import { CanonicalStatus } from '@opentab/ui';

const components = [
  {
    name: 'Checkout',
    status: 'Available',
    tone: 'confirmed' as const,
    detail: 'New checkout sessions can be created.',
  },
  {
    name: 'Sign-in',
    status: 'Available',
    tone: 'confirmed' as const,
    detail: 'Google and email entry points are responding.',
  },
  {
    name: 'Receipts',
    status: 'Available',
    tone: 'confirmed' as const,
    detail: 'Canonical order records are being served.',
  },
] as const;

export function StatusPage() {
  return (
    <div className="status-page">
      <header>
        <CanonicalStatus label="All product systems available" tone="confirmed" />
        <p className="eyebrow">OpenTab status</p>
        <h1>Checkout is operating normally</h1>
        <p>Last product-level check: 10 July 2026, 11:35 WAT.</p>
      </header>
      <section aria-labelledby="components-title">
        <h2 id="components-title">Product components</h2>
        <dl className="component-status-list">
          {components.map((component) => (
            <div key={component.name}>
              <dt>{component.name}</dt>
              <dd>
                <CanonicalStatus label={component.status} tone={component.tone} />
                <p>{component.detail}</p>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h2>Incident history</h2>
        <article className="incident-card">
          <div>
            <strong>No incidents in the last 30 days</strong>
            <time dateTime="2026-07-10">Updated 10 July</time>
          </div>
          <p>
            Operational details that could expose providers, balances, or internal infrastructure
            are intentionally omitted.
          </p>
        </article>
      </section>
    </div>
  );
}
