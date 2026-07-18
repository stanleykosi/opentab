import type {
  CustomerOrderView,
  MerchantDashboardView,
  MerchantOrderView,
  MerchantProductView,
  OrderCanonicalStatus,
  ReceiptView,
} from '../client/view-models';
import type {
  CustomerOrderListResponse,
  MerchantOrderListResponse,
  MerchantProductListResponse,
  MerchantSummaryResponse,
  OrderSnapshotResponse,
} from './browser-api-client';
import { mapPublicProductToView } from './live-view-mappers';

function supportReference(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-10)
    .toUpperCase()
    .padStart(10, '0');
}

function maskedAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function mapOrderStatus(
  status: OrderSnapshotResponse['order']['status'],
): OrderCanonicalStatus {
  switch (status) {
    case 'created':
    case 'submission_started':
    case 'submitted':
      return 'submitted';
    case 'executing':
      return 'confirming';
    case 'paid':
      return 'paid';
    case 'partially_refunded':
      return 'partially_refunded';
    case 'refunded':
      return 'refunded';
    case 'failed_confirmed':
    case 'mismatch':
    case 'orphaned':
      return 'investigation';
  }
}

export function mapMerchantOrder(
  order: MerchantOrderListResponse['items'][number]['order'],
  productTitle: string,
): MerchantOrderView {
  return {
    id: order.id,
    productTitle,
    customerAlias: maskedAddress(order.payer),
    amountBaseUnits: order.amountBaseUnits,
    paidBaseUnits: order.paidAmountBaseUnits,
    refundedBaseUnits: order.refundedAmountBaseUnits,
    refundableUntil: order.refundableUntil,
    status: mapOrderStatus(order.status),
    createdAt: order.createdAt,
    supportReference: supportReference(order.id),
  };
}

export function mapCustomerOrder(
  item: CustomerOrderListResponse['items'][number],
): CustomerOrderView {
  return {
    id: item.order.id,
    merchantDisplayName: item.merchantDisplayName,
    merchantSlug: item.merchantSlug,
    productTitle: item.product.title,
    amountBaseUnits:
      item.order.paidAmountBaseUnits === '0'
        ? item.order.amountBaseUnits
        : item.order.paidAmountBaseUnits,
    status: mapOrderStatus(item.order.status),
    createdAt: item.order.createdAt,
    supportReference: supportReference(item.order.id),
  };
}

export function mapMerchantProduct(
  product: MerchantProductListResponse['items'][number],
  merchantSlug: string,
): MerchantProductView {
  return {
    id: product.id,
    version: product.version,
    slug: product.slug,
    title: product.title,
    description: product.description,
    ...(product.imageUrl === undefined ? {} : { imageUrl: product.imageUrl }),
    priceBaseUnits: product.unitPriceBaseUnits,
    sold: product.sold,
    ...(product.maxSupply === undefined ? {} : { inventory: product.maxSupply }),
    status: product.status,
    checkoutUrl: `/c/${merchantSlug}/${product.slug}`,
    updatedAt: product.updatedAt,
    startsAt: product.startsAt,
    ...(product.endsAt === undefined ? {} : { endsAt: product.endsAt }),
    refundWindowSeconds: product.refundWindowSeconds,
    loyaltyPoints: product.loyaltyPoints,
    maxPerOrder: product.maxPerOrder,
  };
}

function salesSeries(
  orders: MerchantDashboardView['orders'],
  observedAt: string,
): MerchantDashboardView['salesSeries'] {
  const end = new Date(observedAt);
  const days = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (5 - index));
    const key = date.toISOString().slice(0, 10);
    return {
      key,
      label: new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(date),
      amountBaseUnits: 0n,
      orderCount: 0n,
    };
  });
  for (const order of orders) {
    if (!['paid', 'partially_refunded', 'refunded'].includes(order.status)) continue;
    const bucket = days.find((day) => day.key === order.createdAt.slice(0, 10));
    if (bucket !== undefined) {
      bucket.amountBaseUnits += BigInt(order.amountBaseUnits);
      bucket.orderCount += 1n;
    }
  }
  return days.map(({ label, amountBaseUnits, orderCount }) => ({
    label,
    amountBaseUnits: amountBaseUnits.toString(),
    orderCount: orderCount.toString(),
  }));
}

export function mapMerchantDashboard(input: {
  summary: MerchantSummaryResponse;
  orders: MerchantOrderListResponse;
  products: MerchantProductListResponse;
}): MerchantDashboardView {
  const merchantOrders = input.orders.items.map(({ order, productTitle }) =>
    mapMerchantOrder(order, productTitle),
  );
  return {
    merchant: {
      id: input.summary.merchant.id,
      slug: input.summary.merchant.slug,
      displayName: input.summary.merchant.displayName,
      monogram: input.summary.merchant.displayName
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part.slice(0, 1).toUpperCase())
        .join(''),
      ...(input.summary.merchant.supportContact?.trim()
        ? { supportContact: input.summary.merchant.supportContact.trim() }
        : {}),
      verified: input.summary.merchant.status === 'active',
    },
    payoutAddress: input.summary.merchant.payoutAddress,
    grossBaseUnits: input.summary.grossBaseUnits,
    refundedBaseUnits: input.summary.refundedBaseUnits,
    pendingBaseUnits: input.summary.pendingBaseUnits,
    withdrawableBaseUnits: input.summary.withdrawableBaseUnits,
    withdrawnBaseUnits: input.summary.withdrawnBaseUnits,
    loyaltyMembers: input.summary.loyaltyMembers,
    freshness: { state: 'fresh', checkedAt: input.summary.observedAt },
    products: input.products.items.map((product) =>
      mapMerchantProduct(product, input.summary.merchant.slug),
    ),
    orders: merchantOrders,
    salesSeries: salesSeries(merchantOrders, input.summary.observedAt),
  };
}

export function mapOrderSnapshotToMerchantOrder(
  snapshot: OrderSnapshotResponse,
): MerchantOrderView {
  return mapMerchantOrder(snapshot.order, snapshot.product.title);
}

export function mapOrderSnapshotToReceipt(
  snapshot: OrderSnapshotResponse,
  origin: string,
): ReceiptView {
  const status = mapOrderStatus(snapshot.order.status);
  return {
    orderId: snapshot.order.id,
    supportReference: supportReference(snapshot.order.id),
    status,
    product: mapPublicProductToView(
      {
        merchant: snapshot.merchant,
        product: snapshot.product,
        availabilityObservedAt: snapshot.order.updatedAt,
        projectionStale: false,
        requestId: snapshot.requestId,
      },
      { origin },
    ),
    quantity: snapshot.order.quantity,
    amountBaseUnits:
      snapshot.order.paidAmountBaseUnits === '0'
        ? snapshot.order.amountBaseUnits
        : snapshot.order.paidAmountBaseUnits,
    ...(snapshot.order.confirmedAt === undefined
      ? {}
      : { confirmedAt: snapshot.order.confirmedAt }),
    holderAlias: maskedAddress(snapshot.order.recipient),
    ...(snapshot.order.transactionHash === undefined
      ? {}
      : { transactionHash: snapshot.order.transactionHash }),
    refundBaseUnits: snapshot.order.refundedAmountBaseUnits,
    passStatus:
      snapshot.receipt?.status === 'issued' && ['paid', 'partially_refunded'].includes(status)
        ? 'valid'
        : status === 'refunded' || snapshot.receipt?.status === 'revoked'
          ? 'refunded'
          : status === 'investigation' || snapshot.receipt?.status === 'orphaned'
            ? 'investigation'
            : 'pending',
    loyalty: {
      earned: '0',
      current: '0',
      target: '1',
      rewardLabel: 'Reward details unavailable',
      rewardDetailsAvailable: false,
    },
  };
}
