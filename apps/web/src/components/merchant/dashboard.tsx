import { CanonicalStatus, DataTable, EmptyState, LinkButton, MoneyAmount } from '@opentab/ui';
import type { MerchantDashboardView } from '../../client/view-models';

function csvHref(dashboard: MerchantDashboardView): string {
  const rows = [
    ['Order', 'Product', 'Customer alias', 'Amount base units', 'Settlement status', 'Created at'],
    ...dashboard.orders.map((order) => [
      order.supportReference,
      order.productTitle,
      order.customerAlias,
      order.amountBaseUnits,
      order.status,
      order.createdAt,
    ]),
  ];
  const csv = rows
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','))
    .join('\n');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

function canonicalTone(status: MerchantDashboardView['orders'][number]['status']) {
  if (status === 'paid') return 'confirmed' as const;
  if (status === 'partially_refunded' || status === 'refunded') return 'refunded' as const;
  if (status === 'investigation') return 'attention' as const;
  return 'processing' as const;
}

export function MerchantDashboard({ dashboard }: { dashboard: MerchantDashboardView }) {
  const max = dashboard.salesSeries.reduce(
    (value, point) =>
      BigInt(point.amountBaseUnits) > value ? BigInt(point.amountBaseUnits) : value,
    1n,
  );
  return (
    <div className="merchant-content">
      <header className="merchant-page-head">
        <div>
          <p className="eyebrow">{dashboard.merchant.displayName}</p>
          <h1>Merchant overview</h1>
          <p>Only confirmed settlement is counted as paid revenue.</p>
        </div>
        <div className="page-actions">
          <LinkButton href="/merchant/products/new">Create product</LinkButton>
          <a
            className="ot-button ot-button--secondary"
            download="opentab-orders.csv"
            href={csvHref(dashboard)}
          >
            Export CSV
          </a>
        </div>
      </header>
      {dashboard.freshness.state !== 'fresh' ? (
        <div className="freshness-warning">
          <CanonicalStatus label="Settlement data delayed" tone="attention" />
          <p>Money actions stay unavailable until confirmed records catch up.</p>
        </div>
      ) : (
        <p className="freshness-line">
          <span aria-hidden="true">●</span> Confirmed records checked just now
        </p>
      )}
      <section aria-label="Financial overview" className="metric-grid">
        <article>
          <span>Settled sales</span>
          <MoneyAmount baseUnits={dashboard.grossBaseUnits} />
          <small>Before refunds</small>
        </article>
        <article>
          <span>Refunded</span>
          <MoneyAmount baseUnits={dashboard.refundedBaseUnits} />
          <small>Confirmed refunds</small>
        </article>
        <article>
          <span>Pending</span>
          <MoneyAmount baseUnits={dashboard.pendingBaseUnits} />
          <small>Not yet withdrawable</small>
        </article>
        <article className="metric-card--accent">
          <span>Available balance</span>
          <MoneyAmount baseUnits={dashboard.withdrawableBaseUnits} />
          <LinkButton href="/merchant/balance" size="compact" variant="secondary">
            Manage balance
          </LinkButton>
        </article>
      </section>
      <section className="analytics-card">
        <div className="section-bar">
          <div>
            <p className="eyebrow">Last six days</p>
            <h2>Settled sales</h2>
          </div>
          <p>
            <strong>{dashboard.loyaltyMembers}</strong> returning customers
          </p>
        </div>
        <div aria-hidden="true" className="sales-chart">
          {dashboard.salesSeries.map((point) => (
            <div key={point.label}>
              <span
                style={{
                  blockSize: `${((BigInt(point.amountBaseUnits) * 100n) / max).toString()}%`,
                }}
              />
              <small>{point.label}</small>
            </div>
          ))}
        </div>
        <details className="chart-table">
          <summary>View sales as a table</summary>
          <DataTable
            caption="Settled sales by day"
            columns={[
              {
                id: 'day',
                header: 'Day',
                cell: (row: MerchantDashboardView['salesSeries'][number]) => row.label,
              },
              { id: 'orders', header: 'Orders', cell: (row) => row.orderCount, numeric: true },
              {
                id: 'sales',
                header: 'Settled sales',
                cell: (row) => <MoneyAmount baseUnits={row.amountBaseUnits} />,
                numeric: true,
              },
            ]}
            getRowKey={(row) => row.label}
            rows={dashboard.salesSeries}
          />
        </details>
      </section>
      <section>
        <div className="section-bar">
          <div>
            <p className="eyebrow">Settlement activity</p>
            <h2>Recent orders</h2>
          </div>
          <LinkButton href="/merchant/orders" variant="quiet">
            View all orders
          </LinkButton>
        </div>
        <DataTable
          caption="Recent confirmed and pending orders"
          columns={[
            {
              id: 'order',
              header: 'Order',
              cell: (row: MerchantDashboardView['orders'][number]) => (
                <a href={`/merchant/orders/${row.id}`}>{row.supportReference}</a>
              ),
            },
            { id: 'product', header: 'Product', cell: (row) => row.productTitle },
            { id: 'customer', header: 'Customer', cell: (row) => row.customerAlias },
            {
              id: 'status',
              header: 'Status',
              cell: (row) => (
                <CanonicalStatus
                  label={row.status.replaceAll('_', ' ')}
                  tone={canonicalTone(row.status)}
                />
              ),
            },
            {
              id: 'amount',
              header: 'Amount',
              cell: (row) => <MoneyAmount baseUnits={row.amountBaseUnits} />,
              numeric: true,
            },
          ]}
          getRowKey={(row) => row.id}
          rows={dashboard.orders}
        />
        <div className="mobile-ledger-list">
          {dashboard.orders.map((order) => (
            <a href={`/merchant/orders/${order.id}`} key={order.id}>
              <div>
                <strong>{order.productTitle}</strong>
                <span>
                  {order.customerAlias} · {order.supportReference}
                </span>
              </div>
              <MoneyAmount baseUnits={order.amountBaseUnits} />
              <CanonicalStatus
                label={order.status.replaceAll('_', ' ')}
                tone={canonicalTone(order.status)}
              />
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

export function MerchantProducts({ dashboard }: { dashboard: MerchantDashboardView }) {
  if (dashboard.products.length === 0)
    return (
      <EmptyState
        action={<LinkButton href="/merchant/products/new">Create your first product</LinkButton>}
        body="Create an offer to generate a checkout link and QR."
        title="No products yet"
      />
    );
  return (
    <div className="merchant-content">
      <header className="merchant-page-head">
        <div>
          <p className="eyebrow">Catalog</p>
          <h1>Products</h1>
          <p>Create, publish, pause, and share your offers.</p>
        </div>
        <LinkButton href="/merchant/products/new">Create product</LinkButton>
      </header>
      <div className="merchant-product-list">
        {dashboard.products.map((product) => (
          <article className="merchant-product-card" key={product.id}>
            <div className="merchant-product-card__art" aria-hidden="true">
              {product.title.slice(0, 1)}
            </div>
            <div>
              <CanonicalStatus
                label={product.status.replaceAll('_', ' ')}
                tone={product.status === 'active' ? 'confirmed' : 'attention'}
              />
              <h2>
                <a href={`/merchant/products/${product.id}`}>{product.title}</a>
              </h2>
              <p>
                <MoneyAmount baseUnits={product.priceBaseUnits} /> · {product.sold} sold
                {product.inventory === undefined ? null : ` of ${product.inventory}`}
              </p>
            </div>
            <div className="page-actions">
              <LinkButton href={`/merchant/products/${product.id}`} variant="secondary">
                Manage
              </LinkButton>
              <LinkButton href={product.checkoutUrl} variant="quiet">
                Buyer view
              </LinkButton>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function MerchantOrders({ dashboard }: { dashboard: MerchantDashboardView }) {
  return (
    <div className="merchant-content">
      <header className="merchant-page-head">
        <div>
          <p className="eyebrow">Settlement ledger</p>
          <h1>Orders</h1>
          <p>Pending records never count as paid until settlement is confirmed.</p>
        </div>
        <a
          className="ot-button ot-button--secondary"
          download="opentab-orders.csv"
          href={csvHref(dashboard)}
        >
          Export CSV
        </a>
      </header>
      <DataTable
        caption="Merchant orders"
        columns={[
          {
            id: 'reference',
            header: 'Reference',
            cell: (row: MerchantDashboardView['orders'][number]) => (
              <a href={`/merchant/orders/${row.id}`}>{row.supportReference}</a>
            ),
          },
          {
            id: 'date',
            header: 'Date',
            cell: (row) =>
              new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                new Date(row.createdAt),
              ),
          },
          { id: 'product', header: 'Product', cell: (row) => row.productTitle },
          { id: 'customer', header: 'Customer', cell: (row) => row.customerAlias },
          {
            id: 'status',
            header: 'Settlement status',
            cell: (row) => (
              <CanonicalStatus
                label={row.status.replaceAll('_', ' ')}
                tone={canonicalTone(row.status)}
              />
            ),
          },
          {
            id: 'amount',
            header: 'Gross',
            cell: (row) => <MoneyAmount baseUnits={row.amountBaseUnits} />,
            numeric: true,
          },
        ]}
        getRowKey={(row) => row.id}
        rows={dashboard.orders}
      />
      <div className="mobile-ledger-list">
        {dashboard.orders.map((order) => (
          <a href={`/merchant/orders/${order.id}`} key={order.id}>
            <div>
              <strong>{order.productTitle}</strong>
              <span>
                {order.customerAlias} · {order.supportReference}
              </span>
            </div>
            <MoneyAmount baseUnits={order.amountBaseUnits} />
            <CanonicalStatus
              label={order.status.replaceAll('_', ' ')}
              tone={canonicalTone(order.status)}
            />
          </a>
        ))}
      </div>
    </div>
  );
}
