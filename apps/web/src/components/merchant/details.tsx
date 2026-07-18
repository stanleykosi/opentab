'use client';

import {
  Button,
  CanonicalStatus,
  Dialog,
  decimalToBaseUnits,
  InlineAlert,
  MoneyAmount,
  TextArea,
  TextField,
} from '@opentab/ui';
import { useEffect, useState } from 'react';
import type {
  FrontendFeatureState,
  MerchantOrderView,
  MerchantProductView,
} from '../../client/view-models';
import { BoundOperationStatus } from '../bound-operation-status';
import type { useBoundOperation } from '../use-bound-operation';
import {
  type FinancialFlowActions,
  type RecoverableFinancialFlow,
  RefundFlow,
} from './finance-flows';
import { QrShareCard } from './qr-card';

type BoundOperationController = ReturnType<typeof useBoundOperation>;

export interface ProductEditInput {
  readonly title: string;
  readonly description: string;
  readonly imageUrl?: string;
  readonly unitPriceBaseUnits: string;
  readonly maxSupply?: string;
  readonly maxPerOrder: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly refundWindowSeconds: string;
  readonly loyaltyPoints: string;
}

function baseUnitsToInput(value: string): string {
  const padded = value.padStart(7, '0');
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return fraction.length === 0 ? padded.slice(0, -6) : `${padded.slice(0, -6)}.${fraction}`;
}

function localDateTime(value: string | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function ProductDetail({
  changeStatus,
  chainSyncStatus,
  operation,
  resumeOperation,
  product,
  shareOrigin = '',
  updateProduct,
}: {
  product: MerchantProductView;
  shareOrigin?: string;
  changeStatus?: (action: 'publish' | 'pause' | 'archive') => Promise<void>;
  chainSyncStatus?: 'not_required' | 'pending' | 'submitted' | 'confirmed' | 'mismatch' | 'failed';
  operation?: BoundOperationController;
  resumeOperation?: () => Promise<void>;
  updateProduct?: (input: ProductEditInput) => Promise<void>;
}) {
  const [status, setStatus] = useState(product.status);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<'publish' | 'pause' | 'archive'>();
  const [error, setError] = useState<string>();
  const [editTitle, setEditTitle] = useState(product.title);
  const [editDescription, setEditDescription] = useState(product.description ?? '');
  const [editImageUrl, setEditImageUrl] = useState(product.imageUrl ?? '');
  const [editPrice, setEditPrice] = useState(baseUnitsToInput(product.priceBaseUnits));
  const [editInventory, setEditInventory] = useState(product.inventory ?? '');
  const [editLimit, setEditLimit] = useState(product.maxPerOrder ?? '1');
  const [editStartsAt, setEditStartsAt] = useState(localDateTime(product.startsAt));
  const [editEndsAt, setEditEndsAt] = useState(localDateTime(product.endsAt));
  const [editRefundWindow, setEditRefundWindow] = useState(product.refundWindowSeconds ?? '0');
  const [editLoyalty, setEditLoyalty] = useState(product.loyaltyPoints ?? '0');
  const updateStatus = async (action: 'publish' | 'pause' | 'archive') => {
    if (changeStatus === undefined) {
      setStatus(action === 'pause' ? 'paused' : action === 'archive' ? 'archived' : 'publishing');
      return;
    }
    setPending(true);
    setPendingAction(action);
    setError(undefined);
    try {
      await changeStatus(action);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The product status could not be changed.',
      );
    } finally {
      setPending(false);
    }
  };
  const operationBusy =
    operation !== undefined && !['idle', 'confirmed', 'failed'].includes(operation.state);
  useEffect(() => {
    if (operation?.state !== 'confirmed' || pendingAction === undefined) return;
    setStatus(
      pendingAction === 'pause' ? 'paused' : pendingAction === 'archive' ? 'archived' : 'active',
    );
    setPendingAction(undefined);
  }, [operation?.state, pendingAction]);
  const saveEdit = async () => {
    if (updateProduct === undefined) return;
    let unitPriceBaseUnits: string;
    try {
      unitPriceBaseUnits = decimalToBaseUnits(editPrice);
    } catch {
      setError('Enter a valid price with up to six decimal places.');
      return;
    }
    const startsAt = new Date(editStartsAt);
    const endsAt = editEndsAt.length === 0 ? undefined : new Date(editEndsAt);
    if (
      editTitle.trim().length < 2 ||
      editDescription.trim().length < 1 ||
      BigInt(unitPriceBaseUnits) <= 0n ||
      !/^[1-9][0-9]*$/.test(editLimit) ||
      (editInventory.length > 0 && !/^[1-9][0-9]*$/.test(editInventory)) ||
      !/^(0|[1-9][0-9]*)$/.test(editRefundWindow) ||
      !/^(0|[1-9][0-9]*)$/.test(editLoyalty) ||
      !Number.isFinite(startsAt.getTime()) ||
      (endsAt !== undefined && (!Number.isFinite(endsAt.getTime()) || endsAt <= startsAt))
    ) {
      setError(
        'Review the product values, inventory, schedule, refund window, and loyalty points.',
      );
      return;
    }
    if (editInventory.length > 0 && BigInt(editLimit) > BigInt(editInventory)) {
      setError('The cumulative customer limit cannot exceed inventory.');
      return;
    }
    if (editImageUrl.length > 0) {
      try {
        if (new URL(editImageUrl).protocol !== 'https:') throw new Error('invalid');
      } catch {
        setError('Use an approved HTTPS image URL or leave it empty.');
        return;
      }
    }
    setPending(true);
    setError(undefined);
    try {
      await updateProduct({
        title: editTitle.trim(),
        description: editDescription.trim(),
        ...(editImageUrl.length === 0 ? {} : { imageUrl: editImageUrl }),
        unitPriceBaseUnits,
        ...(editInventory.length === 0 ? {} : { maxSupply: editInventory }),
        maxPerOrder: editLimit,
        startsAt: startsAt.toISOString(),
        ...(endsAt === undefined ? {} : { endsAt: endsAt.toISOString() }),
        refundWindowSeconds: editRefundWindow,
        loyaltyPoints: editLoyalty,
      });
      setEditOpen(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The product edit could not be prepared.',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="merchant-content">
      <header className="merchant-page-head">
        <div>
          <CanonicalStatus
            label={status.replaceAll('_', ' ')}
            tone={status === 'active' ? 'confirmed' : 'attention'}
          />
          <p className="eyebrow">Product detail</p>
          <h1>{product.title}</h1>
          <p>
            Last confirmed update{' '}
            {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(product.updatedAt),
            )}
          </p>
        </div>
        <div className="page-actions">
          <Button
            disabled={operationBusy}
            loading={pending}
            onClick={() => void updateStatus(status === 'active' ? 'pause' : 'publish')}
            variant="secondary"
          >
            {status === 'active' ? 'Pause sales' : 'Activate sales'}
          </Button>
          <Button disabled={operationBusy} onClick={() => setArchiveOpen(true)} variant="quiet">
            Archive
          </Button>
        </div>
      </header>
      {error === undefined ? null : (
        <InlineAlert title="Product update not saved" tone="warning">
          <p>{error}</p>
        </InlineAlert>
      )}
      {chainSyncStatus !== undefined && chainSyncStatus !== 'confirmed' ? (
        <InlineAlert
          title={
            chainSyncStatus === 'mismatch' || chainSyncStatus === 'failed'
              ? 'Product projection needs investigation'
              : 'Product change is not confirmed yet'
          }
          tone={chainSyncStatus === 'mismatch' || chainSyncStatus === 'failed' ? 'danger' : 'info'}
        >
          <p>
            Current chain synchronization state: {chainSyncStatus.replaceAll('_', ' ')}. Buyer
            availability remains bound to the confirmed projection.
          </p>
        </InlineAlert>
      ) : null}
      {operation?.operation?.status === 'prepared' && operation.state === 'idle' ? (
        <InlineAlert title="A product change is ready to resume" tone="info">
          <p>This exact server-bound operation has not been approved or submitted.</p>
          <Button onClick={() => void resumeOperation?.()} variant="secondary">
            Review pending operation
          </Button>
        </InlineAlert>
      ) : null}
      {operation === undefined ? null : (
        <BoundOperationStatus
          confirmLabel="Approve product change"
          controller={operation}
          noun="Product change"
        />
      )}
      <section className="product-detail-grid">
        <article>
          <p className="eyebrow">Price</p>
          <MoneyAmount baseUnits={product.priceBaseUnits} />
          <p>
            {product.sold} sold
            {product.inventory === undefined ? null : ` of ${product.inventory} total`}
          </p>
        </article>
        <article>
          <p className="eyebrow">Loyalty</p>
          <strong>{product.loyaltyPoints ?? 'Not configured'} points</strong>
          <p>Awarded after each confirmed purchase</p>
        </article>
        <article>
          <p className="eyebrow">Refund policy</p>
          <strong>
            {product.refundWindowSeconds === undefined
              ? 'See buyer terms'
              : `${product.refundWindowSeconds} seconds`}
          </strong>
          <p>
            {product.startsAt === undefined
              ? 'Offer schedule unavailable'
              : `Starts ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(product.startsAt))}`}
          </p>
        </article>
      </section>
      <QrShareCard title={product.title} url={`${shareOrigin}${product.checkoutUrl}`} />
      <section className="settings-section">
        <div>
          <h2>Buyer preview and product details</h2>
          <p>
            Price and inventory changes create a new version. Existing sessions either remain bound
            or expire safely.
          </p>
        </div>
        <div className="page-actions">
          <a className="ot-button ot-button--secondary" href={product.checkoutUrl}>
            Open buyer view
          </a>
          <Button
            disabled={product.sold !== '0' || operationBusy || updateProduct === undefined}
            onClick={() => setEditOpen(true)}
            variant="secondary"
          >
            {product.sold === '0' ? 'Edit product' : 'Edits locked after first sale'}
          </Button>
        </div>
      </section>
      <Dialog
        description="Saving prepares a new exact product version. A separate embedded-account approval is required before it becomes active."
        onOpenChange={setEditOpen}
        open={editOpen}
        title={`Edit ${product.title}`}
      >
        <form
          className="product-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveEdit();
          }}
        >
          <TextField
            label="Product name"
            onChange={(event) => setEditTitle(event.currentTarget.value)}
            value={editTitle}
          />
          <TextArea
            label="Description"
            onChange={(event) => setEditDescription(event.currentTarget.value)}
            value={editDescription}
          />
          <TextField
            description="Optional approved HTTPS media URL."
            label="Image URL"
            onChange={(event) => setEditImageUrl(event.currentTarget.value)}
            type="url"
            value={editImageUrl}
          />
          <div className="field-pair">
            <TextField
              inputMode="decimal"
              label="Price (USDC)"
              onChange={(event) => setEditPrice(event.currentTarget.value)}
              value={editPrice}
            />
            <TextField
              inputMode="numeric"
              label="Inventory"
              onChange={(event) => setEditInventory(event.currentTarget.value)}
              value={editInventory}
            />
          </div>
          <div className="field-pair">
            <TextField
              inputMode="numeric"
              label="Maximum per customer"
              onChange={(event) => setEditLimit(event.currentTarget.value)}
              value={editLimit}
            />
            <TextField
              inputMode="numeric"
              label="Loyalty points"
              onChange={(event) => setEditLoyalty(event.currentTarget.value)}
              value={editLoyalty}
            />
          </div>
          <div className="field-pair">
            <TextField
              label="Starts at"
              onChange={(event) => setEditStartsAt(event.currentTarget.value)}
              type="datetime-local"
              value={editStartsAt}
            />
            <TextField
              label="Ends at"
              onChange={(event) => setEditEndsAt(event.currentTarget.value)}
              type="datetime-local"
              value={editEndsAt}
            />
          </div>
          <TextField
            description="Whole seconds after the payment window closes. Use 0 for non-refundable."
            inputMode="numeric"
            label="Refund window (seconds)"
            onChange={(event) => setEditRefundWindow(event.currentTarget.value)}
            value={editRefundWindow}
          />
          <div className="page-actions">
            <Button loading={pending} type="submit">
              Review exact product update
            </Button>
            <Button onClick={() => setEditOpen(false)} variant="quiet">
              Cancel
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        description="Existing receipts remain available. New checkouts will stop and this product cannot be permanently deleted after sales."
        onOpenChange={setArchiveOpen}
        open={archiveOpen}
        title={`Archive ${product.title}?`}
      >
        <div className="page-actions">
          <Button
            disabled={operationBusy}
            onClick={() => {
              void updateStatus('archive');
              setArchiveOpen(false);
            }}
            variant="danger"
          >
            Archive {product.title}
          </Button>
          <Button onClick={() => setArchiveOpen(false)} variant="quiet">
            Keep product
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export function OrderDetail({
  features,
  initialRefund,
  refundActions,
  order,
}: {
  features: FrontendFeatureState;
  initialRefund?: RecoverableFinancialFlow;
  refundActions?: FinancialFlowActions;
  order: MerchantOrderView;
}) {
  const paidBaseUnits = order.paidBaseUnits ?? order.amountBaseUnits;
  const refundedBaseUnits = order.refundedBaseUnits ?? '0';
  const remainingBaseUnits = (
    BigInt(paidBaseUnits) > BigInt(refundedBaseUnits)
      ? BigInt(paidBaseUnits) - BigInt(refundedBaseUnits)
      : 0n
  ).toString();
  return (
    <div className="merchant-content merchant-content--narrow">
      <header className="merchant-page-head">
        <div>
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
          <p className="eyebrow">Order {order.supportReference}</p>
          <h1>{order.productTitle}</h1>
          <p>Customer alias {order.customerAlias} · no personal email shown</p>
        </div>
        <MoneyAmount baseUnits={order.amountBaseUnits} />
      </header>
      <section className="order-ledger">
        <h2>Money ledger</h2>
        <dl className="summary-ledger">
          <div>
            <dt>Gross paid</dt>
            <dd>
              <MoneyAmount baseUnits={paidBaseUnits} />
            </dd>
          </div>
          <div>
            <dt>Confirmed refunds</dt>
            <dd>
              <MoneyAmount baseUnits={refundedBaseUnits} />
            </dd>
          </div>
          <div>
            <dt>Net liability</dt>
            <dd>
              <MoneyAmount baseUnits={remainingBaseUnits} />
            </dd>
          </div>
        </dl>
        <p>Paid status comes from the confirmed order event, not a provider callback.</p>
        {order.refundableUntil === undefined ? null : (
          <p>
            Refund eligibility ends{' '}
            {new Intl.DateTimeFormat('en-GB', {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(order.refundableUntil))}
            .
          </p>
        )}
      </section>
      <section className="order-timeline">
        <h2>Order timeline</h2>
        <ol>
          <li>
            <strong>Order created</strong>
            <span>Checkout reference issued</span>
          </li>
          <li>
            <strong>Payment submitted</strong>
            <span>Provider operation persisted</span>
          </li>
          <li>
            <strong>Order paid</strong>
            <span>Settlement event confirmed</span>
          </li>
          <li>
            <strong>Pass created</strong>
            <span>Receipt available to customer</span>
          </li>
        </ol>
      </section>
      <RefundFlow
        features={features}
        {...(initialRefund === undefined ? {} : { initialResult: initialRefund })}
        {...(refundActions === undefined ? {} : { liveActions: refundActions })}
        order={order}
      />
      {features.judgeMode ? (
        <details className="disclosure">
          <summary>Technical proof</summary>
          <p>
            Public-safe proof is available in Judge Mode. Sensitive signatures, session data, and
            provider payloads are never shown.
          </p>
          <a href={`/judge/${order.id}`}>Open order evidence</a>
        </details>
      ) : null}
    </div>
  );
}
