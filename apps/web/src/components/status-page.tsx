'use client';

import { CanonicalStatus, type CanonicalTone } from '@opentab/ui';
import { useEffect, useMemo, useState } from 'react';
import {
  getPublicSessionApplicationService,
  type PublicSessionApplicationService,
} from '../application/public-session-api-client';
import type { FrontendFeatureState } from '../client/view-models';

interface ComponentAvailability {
  readonly name: string;
  readonly enabled: boolean;
  readonly enabledDetail: string;
  readonly pausedDetail: string;
}

function componentStatus(component: ComponentAvailability): {
  readonly label: 'Enabled' | 'Paused';
  readonly tone: CanonicalTone;
  readonly detail: string;
} {
  return component.enabled
    ? { label: 'Enabled', tone: 'confirmed', detail: component.enabledDetail }
    : { label: 'Paused', tone: 'attention', detail: component.pausedDetail };
}

function configuredComponents(
  features: FrontendFeatureState,
  checkoutCertified: boolean,
): readonly ComponentAvailability[] {
  const applicationAvailable = features.mode !== 'live-unavailable';
  return [
    {
      name: 'Checkout',
      enabled: applicationAvailable && features.payments && checkoutCertified,
      enabledDetail: 'New payment checkouts are enabled for this deployment.',
      pausedDetail: 'New payment checkouts stay paused until payment readiness is verified.',
    },
    {
      name: 'Sign-in',
      enabled: applicationAvailable,
      enabledDetail: 'Customer sign-in is configured for this deployment.',
      pausedDetail: 'Customer sign-in is not available in this deployment.',
    },
    {
      name: 'Receipts',
      enabled: applicationAvailable,
      enabledDetail: 'Existing receipt records can be requested from this deployment.',
      pausedDetail: 'Receipt access is not available in this deployment.',
    },
    {
      name: 'Refunds',
      enabled: applicationAvailable && features.refunds,
      enabledDetail: 'Refund preparation is enabled; settlement confirmation is still required.',
      pausedDetail: 'New refunds are paused by deployment configuration.',
    },
    {
      name: 'Withdrawals',
      enabled: applicationAvailable && features.withdrawals,
      enabledDetail: 'Merchant withdrawal preparation is enabled for confirmed balances.',
      pausedDetail: 'New merchant withdrawals are paused by deployment configuration.',
    },
    {
      name: 'Split payments',
      enabled: applicationAvailable && features.splits,
      enabledDetail: 'New split reimbursement flows are enabled.',
      pausedDetail: 'New split reimbursement flows are paused by deployment configuration.',
    },
  ];
}

type CheckoutReadiness =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly certified: boolean }
  | { readonly status: 'unavailable' };

export function StatusPage({
  features,
  service: providedService,
}: {
  features: FrontendFeatureState;
  service?: Pick<PublicSessionApplicationService, 'getPublicCheckoutContext'>;
}) {
  const service = useMemo(
    () => providedService ?? getPublicSessionApplicationService(),
    [providedService],
  );
  const [checkoutReadiness, setCheckoutReadiness] = useState<CheckoutReadiness>(() =>
    features.mode === 'deterministic'
      ? { status: 'ready', certified: true }
      : features.mode === 'live-unavailable' || !features.payments
        ? { status: 'ready', certified: false }
        : { status: 'loading' },
  );

  useEffect(() => {
    if (features.mode !== 'live' || !features.payments) return;
    let active = true;
    void service
      .getPublicCheckoutContext()
      .then((context) => {
        if (active) setCheckoutReadiness({ status: 'ready', certified: context.checkoutEnabled });
      })
      .catch(() => {
        if (active) setCheckoutReadiness({ status: 'unavailable' });
      });
    return () => {
      active = false;
    };
  }, [features.mode, features.payments, service]);

  const checkoutCertified = checkoutReadiness.status === 'ready' && checkoutReadiness.certified;
  const components = configuredComponents(features, checkoutCertified);
  const enabledCount = components.filter((component) => component.enabled).length;
  const allEnabled = enabledCount === components.length;
  const checkoutEnabled = components[0]?.enabled === true;
  const checkoutLoading = checkoutReadiness.status === 'loading';

  return (
    <div className="status-page">
      <header>
        <CanonicalStatus
          label={
            checkoutLoading
              ? 'Verifying checkout readiness'
              : allEnabled
                ? 'Configured product features enabled'
                : 'Some product features paused'
          }
          tone={checkoutEnabled ? 'confirmed' : 'attention'}
        />
        <p className="eyebrow">OpenTab availability</p>
        <h1>
          {checkoutLoading
            ? 'Checking checkout readiness'
            : checkoutEnabled
              ? 'Checkout is enabled'
              : 'Checkout is currently paused'}
        </h1>
        <p>
          {enabledCount} of {components.length} customer and merchant capabilities are enabled for
          this deployment.
        </p>
        {checkoutReadiness.status === 'unavailable' ? (
          <p>Checkout remains paused because payment readiness could not be verified.</p>
        ) : null}
      </header>
      <section aria-labelledby="components-title">
        <h2 id="components-title">Configured capabilities</h2>
        <dl className="component-status-list">
          {components.map((component) => {
            const status = componentStatus(component);
            return (
              <div key={component.name}>
                <dt>{component.name}</dt>
                <dd>
                  <CanonicalStatus label={status.label} tone={status.tone} />
                  <p>{status.detail}</p>
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
      <section>
        <h2>About availability</h2>
        <article className="incident-card">
          <div>
            <strong>OpenTab feature readiness</strong>
          </div>
          <p>
            This page reports whether OpenTab capabilities are ready to use. Payment completion
            still requires the matching confirmed settlement record.
          </p>
        </article>
      </section>
    </div>
  );
}
