'use client';

import {
  CanonicalStatus,
  CopyButton,
  ExternalProofLink,
  InlineAlert,
  LinkButton,
  MoneyAmount,
  PassFrame,
  ProgressMeter,
  ProgressTimeline,
  ReceiptFrame,
} from '@opentab/ui';
import { useState } from 'react';
import type { FrontendFeatureState, ReceiptView } from '../../client/view-models';

function receiptStatus(receipt: ReceiptView) {
  switch (receipt.status) {
    case 'paid':
      return { label: 'Paid and confirmed', tone: 'confirmed' as const };
    case 'partially_refunded':
      return { label: 'Partially refunded', tone: 'refunded' as const };
    case 'refunded':
      return { label: 'Refunded', tone: 'refunded' as const };
    case 'submitted':
    case 'confirming':
      return { label: 'Confirming payment', tone: 'processing' as const };
    case 'investigation':
      return { label: 'Checking order', tone: 'attention' as const };
  }
}

function eventDate(startsAt: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(startsAt));
}

function ShareActions({ receipt }: { receipt: ReceiptView }) {
  const [shared, setShared] = useState(false);
  const shareText = `${receipt.product.title} · ${receipt.product.merchant.displayName}`;
  return (
    <div className="share-actions">
      <ButtonLikeShare
        onShare={async () => {
          if (navigator.share) {
            await navigator.share({ title: receipt.product.title, text: shareText });
          } else {
            await navigator.clipboard.writeText(shareText);
          }
          setShared(true);
          window.setTimeout(() => setShared(false), 1800);
        }}
      >
        {shared ? 'Pass details ready' : 'Share pass details'}
      </ButtonLikeShare>
      <CopyButton label="Copy order reference" value={receipt.supportReference} />
    </div>
  );
}

function ButtonLikeShare({
  children,
  onShare,
}: {
  children: string;
  onShare: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="ot-button ot-button--primary ot-button--default"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onShare().finally(() => setBusy(false));
      }}
      type="button"
    >
      {busy ? 'Preparing share' : children}
    </button>
  );
}

export function ReceiptPageView({
  features,
  receipt,
}: {
  features: FrontendFeatureState;
  receipt: ReceiptView;
}) {
  const status = receiptStatus(receipt);
  const confirmed = ['paid', 'partially_refunded', 'refunded'].includes(receipt.status);
  const timestamp = receipt.confirmedAt
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(receipt.confirmedAt))
    : 'Awaiting confirmation';

  if (!confirmed) {
    return (
      <section className="pending-receipt">
        <CanonicalStatus {...status} />
        <p className="eyebrow">Order {receipt.supportReference}</p>
        <h1>
          {receipt.status === 'investigation'
            ? 'We’re checking this order'
            : 'We’re confirming your payment'}
        </h1>
        <p>
          A receipt will appear only after the matching order event is confirmed. Don’t submit
          another payment.
        </p>
        <ProgressTimeline
          items={[
            { id: 'submit', label: 'Payment submitted', status: 'complete' },
            {
              id: 'confirm',
              label: 'Confirming your order',
              status: 'current',
              detail: 'OpenTab is checking the saved payment reference.',
            },
            { id: 'pass', label: 'Creating your pass', status: 'upcoming' },
          ]}
        />
        <InlineAlert title="Safe to return later" tone="info">
          <p>This status comes from the server, so refreshing will not create another order.</p>
        </InlineAlert>
        <p className="support-copy">
          Support reference: <span className="mono">{receipt.supportReference}</span>
        </p>
      </section>
    );
  }

  return (
    <div className="receipt-page-grid">
      <section className="pass-column">
        <h1 className="sr-only">Receipt and pass for {receipt.product.title}</h1>
        <PassFrame
          date={eventDate(receipt.product.startsAt)}
          holder={receipt.holderAlias}
          {...(receipt.product.location === undefined
            ? {}
            : { location: receipt.product.location })}
          merchant={receipt.product.merchant.displayName}
          status={receipt.status === 'refunded' ? 'Refunded' : 'Valid'}
          title={receipt.product.title}
        />
        <ShareActions receipt={receipt} />
      </section>
      <div className="receipt-column">
        <ReceiptFrame
          amountBaseUnits={receipt.amountBaseUnits}
          item={`${receipt.product.title} × ${receipt.quantity}`}
          merchant={receipt.product.merchant.displayName}
          orderReference={receipt.supportReference}
          status={status}
          timestamp={timestamp}
        >
          {BigInt(receipt.refundBaseUnits) > 0n ? (
            <div className="refund-line">
              <span>Refunded amount</span>
              <MoneyAmount baseUnits={receipt.refundBaseUnits} />
            </div>
          ) : null}
        </ReceiptFrame>
        {receipt.status === 'refunded' ? (
          <InlineAlert title="This order was refunded" tone="info">
            <p>The original receipt stays visible as a record. The pass is no longer valid.</p>
          </InlineAlert>
        ) : null}
        <section className="loyalty-card">
          {!receipt.loyalty.rewardDetailsAvailable ? (
            <>
              <p className="eyebrow">Rewards</p>
              <h2>Rewards update unavailable</h2>
              <p>
                This receipt does not include a confirmed loyalty award or current rewards balance.
              </p>
            </>
          ) : (
            <>
              <p className="eyebrow">{receipt.product.merchant.displayName} rewards</p>
              <h2>+{receipt.loyalty.earned} points</h2>
              <ProgressMeter
                current={receipt.loyalty.current}
                detail={`${BigInt(receipt.loyalty.target) > BigInt(receipt.loyalty.current) ? BigInt(receipt.loyalty.target) - BigInt(receipt.loyalty.current) : 0n} points until ${receipt.loyalty.rewardLabel}.`}
                label="Loyalty progress"
                target={receipt.loyalty.target}
              />
            </>
          )}
        </section>
        <div className="receipt-actions">
          {features.splits && receipt.status === 'paid' ? (
            <LinkButton href={`/receipt/${receipt.orderId}/split`}>Split this purchase</LinkButton>
          ) : null}
          <LinkButton href="/account/orders" variant="secondary">
            View all orders
          </LinkButton>
        </div>
        <details className="disclosure">
          <summary>Payment proof</summary>
          <p>This order is marked paid only from its confirmed settlement record.</p>
          {receipt.transactionHash ? (
            <ExternalProofLink
              href={`https://arbiscan.io/tx/${receipt.transactionHash}`}
              label="View public payment proof"
            />
          ) : (
            <p>Public proof is temporarily unavailable. Order status remains under review.</p>
          )}
        </details>
        {receipt.product.merchant.supportContact === undefined ? null : (
          <p className="support-copy">
            Questions? Contact{' '}
            {/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receipt.product.merchant.supportContact) ? (
              <a
                className="support-link"
                href={`mailto:${receipt.product.merchant.supportContact}`}
              >
                {receipt.product.merchant.supportContact}
              </a>
            ) : (
              <span>{receipt.product.merchant.supportContact}</span>
            )}{' '}
            with reference <span className="mono">{receipt.supportReference}</span>.
          </p>
        )}
      </div>
    </div>
  );
}
