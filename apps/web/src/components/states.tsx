import { InlineAlert, LinkButton, Skeleton } from '@opentab/ui';
import type { ReactNode } from 'react';

export function PageSkeleton({ label = 'Loading page' }: { label?: string }) {
  return (
    <section aria-busy="true" aria-label={label} className="state-page">
      <span className="sr-status">{label}</span>
      <Skeleton className="skeleton-line skeleton-line--short" />
      <Skeleton className="skeleton-title" />
      <Skeleton className="skeleton-card" />
    </section>
  );
}

export function ErrorState({
  action,
  body,
  reference,
  title,
}: {
  title: string;
  body: string;
  reference?: string;
  action?: ReactNode;
}) {
  return (
    <section className="state-panel" role="alert">
      <span aria-hidden="true" className="state-panel__mark">
        !
      </span>
      <p className="eyebrow">Action needed</p>
      <h1>{title}</h1>
      <p>{body}</p>
      {reference ? (
        <p className="support-copy">
          Support reference: <span className="mono">{reference}</span>
        </p>
      ) : null}
      <div className="page-actions">
        {action ?? (
          <LinkButton href="/" variant="secondary">
            Return home
          </LinkButton>
        )}
      </div>
    </section>
  );
}

export function StaleDataNotice({ checkedAt }: { checkedAt: string }) {
  return (
    <InlineAlert title="Updates are delayed" tone="warning">
      <p>
        The last verified update was {checkedAt}. Money actions stay unavailable until fresh records
        return.
      </p>
    </InlineAlert>
  );
}
