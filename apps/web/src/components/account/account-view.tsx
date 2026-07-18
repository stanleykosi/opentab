import {
  CanonicalStatus,
  EmptyState,
  InlineAlert,
  LinkButton,
  MoneyAmount,
  ProgressMeter,
} from '@opentab/ui';
import type {
  CustomerOrderView,
  MerchantDashboardView,
  ReceiptView,
} from '../../client/view-models';
import { SessionControl } from '../session-control';

function orderTone(status: CustomerOrderView['status']) {
  return status === 'paid'
    ? ('confirmed' as const)
    : status.includes('refund')
      ? ('refunded' as const)
      : status === 'investigation'
        ? ('attention' as const)
        : ('processing' as const);
}

function maskedAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function LiveAccountOverviewView({
  loyalty,
  orders,
  walletAddress,
}: {
  loyalty: { points: string; label: string } | undefined;
  orders: readonly CustomerOrderView[];
  walletAddress: string;
}) {
  const recent = orders[0];
  return (
    <div className="account-layout">
      <header className="page-heading">
        <p className="eyebrow">Your OpenTab</p>
        <h1>Passes, orders, and progress</h1>
        <p>Signed in · Account {maskedAddress(walletAddress)}</p>
      </header>
      {loyalty === undefined ? null : (
        <section className="account-card">
          <div>
            <p className="eyebrow">Loyalty</p>
            <h2>Your confirmed progress</h2>
          </div>
          <p className="account-loyalty-total">
            <strong>{loyalty.points}</strong> points · {loyalty.label}
          </p>
        </section>
      )}
      <section>
        <div className="section-bar">
          <div>
            <p className="eyebrow">Recent purchase</p>
            <h2>{recent?.productTitle ?? 'No purchases yet'}</h2>
          </div>
          <LinkButton href="/account/orders" variant="quiet">
            All orders
          </LinkButton>
        </div>
        {recent === undefined ? (
          <EmptyState
            action={<LinkButton href="/">Return to OpenTab</LinkButton>}
            body="Open a merchant checkout link or scan their QR code to make a purchase. Confirmed orders and passes will appear here."
            title="No orders yet"
          />
        ) : (
          <a className="account-order-card" href={`/receipt/${recent.id}`}>
            <div>
              <strong>{recent.productTitle}</strong>
              <span>
                {recent.merchantDisplayName} ·{' '}
                {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                  new Date(recent.createdAt),
                )}
              </span>
            </div>
            <CanonicalStatus
              label={recent.status.replaceAll('_', ' ')}
              tone={orderTone(recent.status)}
            />
          </a>
        )}
      </section>
      <section className="account-card account-card--security">
        <div>
          <h2>Sign-in and privacy</h2>
          <p>
            Your full account address stays hidden in everyday views. Technical details are
            available when you need them.
          </p>
        </div>
        <details className="disclosure">
          <summary>Technical account details</summary>
          <p>
            Embedded account: <span className="mono">{maskedAddress(walletAddress)}</span>
          </p>
          <p>Your application session can be revoked without changing the account itself.</p>
        </details>
        <SessionControl />
      </section>
    </div>
  );
}

export function LiveAccountOrdersView({
  hasMore,
  loadError,
  loadingMore,
  onLoadMore,
  orders,
}: {
  hasMore: boolean;
  loadError?: string;
  loadingMore: boolean;
  onLoadMore: () => void;
  orders: readonly CustomerOrderView[];
}) {
  if (orders.length === 0)
    return (
      <EmptyState
        body="Open a merchant checkout link or scan their QR code to make a purchase. Confirmed orders and passes will appear here."
        title="No orders yet"
        action={<LinkButton href="/">Return to OpenTab</LinkButton>}
      />
    );
  return (
    <div className="account-layout">
      <header className="page-heading">
        <p className="eyebrow">Purchase history</p>
        <h1>Your orders</h1>
        <p>Paid and refund states come from confirmed order records.</p>
      </header>
      <div className="order-card-list">
        {orders.map((order) => (
          <a
            className="account-order-card account-order-card--ledger"
            href={`/receipt/${order.id}`}
            key={order.id}
          >
            <div>
              <strong>{order.productTitle}</strong>
              <span>
                {order.merchantDisplayName} ·{' '}
                {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                  new Date(order.createdAt),
                )}{' '}
                · {order.supportReference}
              </span>
            </div>
            <MoneyAmount baseUnits={order.amountBaseUnits} />
            <CanonicalStatus
              label={order.status.replaceAll('_', ' ')}
              tone={orderTone(order.status)}
            />
          </a>
        ))}
      </div>
      {loadError === undefined ? null : (
        <InlineAlert title="More orders could not be loaded" tone="warning">
          <p>{loadError}</p>
        </InlineAlert>
      )}
      {hasMore ? (
        <button
          className="ot-button ot-button--secondary"
          disabled={loadingMore}
          onClick={onLoadMore}
          type="button"
        >
          {loadingMore ? 'Loading more orders…' : 'Load more orders'}
        </button>
      ) : null}
    </div>
  );
}

export function AccountOverview({ receipt }: { receipt: ReceiptView }) {
  return (
    <div className="account-layout">
      <header className="page-heading">
        <p className="eyebrow">Your OpenTab</p>
        <h1>Passes, orders, and progress</h1>
        <p>Signed in as S. Ade · Account ending 91C0</p>
      </header>
      <section className="account-card">
        <div>
          <p className="eyebrow">Daylight Room</p>
          <h2>Regulars progress</h2>
        </div>
        <ProgressMeter
          current={receipt.loyalty.current}
          detail={`Next: ${receipt.loyalty.rewardLabel}`}
          label="Daylight Room loyalty"
          target={receipt.loyalty.target}
        />
      </section>
      <section>
        <div className="section-bar">
          <div>
            <p className="eyebrow">Recent pass</p>
            <h2>{receipt.product.title}</h2>
          </div>
          <LinkButton href="/account/orders" variant="quiet">
            All orders
          </LinkButton>
        </div>
        <a className="account-order-card" href={`/receipt/${receipt.orderId}`}>
          <div>
            <strong>{receipt.product.title}</strong>
            <span>{receipt.product.merchant.displayName} · Sunday, 2 August</span>
          </div>
          <CanonicalStatus label="Pass ready" tone="confirmed" />
        </a>
      </section>
      <section className="account-card account-card--security">
        <div>
          <h2>Sign-in and privacy</h2>
          <p>
            Your full account address stays hidden in everyday views. Technical details are
            available when you need them.
          </p>
        </div>
        <details className="disclosure">
          <summary>Technical account details</summary>
          <p>
            Embedded account: <span className="mono">0x7D24…91C0</span>
          </p>
          <p>Your application session can be revoked without changing the account itself.</p>
        </details>
        <button className="ot-button ot-button--secondary" type="button">
          Sign out
        </button>
      </section>
    </div>
  );
}

export function AccountOrders({ dashboard }: { dashboard: MerchantDashboardView }) {
  if (dashboard.orders.length === 0)
    return (
      <EmptyState
        body="Open a merchant checkout link or scan their QR code to make a purchase. Confirmed orders and passes will appear here."
        title="No orders yet"
        action={<LinkButton href="/">Return to OpenTab</LinkButton>}
      />
    );
  return (
    <div className="account-layout">
      <header className="page-heading">
        <p className="eyebrow">Purchase history</p>
        <h1>Your orders</h1>
        <p>Paid and refund states come from confirmed order records.</p>
      </header>
      <nav className="filter-pills" aria-label="Order filters">
        <a aria-current="page" href="/account/orders">
          All
        </a>
        <a href="/account/orders?status=paid">Paid</a>
        <a href="/account/orders?status=refunded">Refunded</a>
      </nav>
      <div className="order-card-list">
        {dashboard.orders.map((order) => (
          <a
            className="account-order-card account-order-card--ledger"
            href={`/receipt/${order.id}`}
            key={order.id}
          >
            <div>
              <strong>{order.productTitle}</strong>
              <span>
                {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                  new Date(order.createdAt),
                )}{' '}
                · {order.supportReference}
              </span>
            </div>
            <MoneyAmount baseUnits={order.amountBaseUnits} />
            <CanonicalStatus
              label={order.status.replaceAll('_', ' ')}
              tone={
                order.status === 'paid'
                  ? 'confirmed'
                  : order.status.includes('refund')
                    ? 'refunded'
                    : 'processing'
              }
            />
          </a>
        ))}
      </div>
    </div>
  );
}
