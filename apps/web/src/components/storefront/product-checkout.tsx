'use client';

import { Button, InlineAlert, MoneyAmount } from '@opentab/ui';
import { useMemo, useState } from 'react';
import type { PresentationMode, ProductView } from '../../client/view-models';

function createIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `checkout-${crypto.randomUUID()}`
    : `checkout-${Date.now().toString(36)}`;
}

export function ProductCheckout({
  mode,
  paymentsEnabled = true,
  product,
}: {
  mode: PresentationMode;
  paymentsEnabled?: boolean;
  product: ProductView;
}) {
  const [quantity, setQuantity] = useState('1');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // The wire field retains its v1 name, but the contract enforces this as a
  // cumulative per-wallet/customer ceiling across purchases.
  const max = BigInt(product.maxPerOrder);
  const total = useMemo(
    () => (BigInt(product.unitPriceBaseUnits) * BigInt(quantity)).toString(),
    [product.unitPriceBaseUnits, quantity],
  );
  const unavailable = product.availability.state !== 'available';

  const changeQuantity = (direction: -1n | 1n) => {
    const next = BigInt(quantity) + direction;
    if (next >= 1n && next <= max) setQuantity(next.toString());
  };

  return (
    <section aria-labelledby="buy-title" className="buy-card">
      <p className="eyebrow">Your tab</p>
      <h2 id="buy-title">Choose your passes</h2>
      <div className="quantity-row">
        <span>Quantity</span>
        <fieldset className="quantity-stepper">
          <legend className="sr-only">Quantity</legend>
          <Button
            aria-label="Decrease quantity"
            disabled={quantity === '1'}
            onClick={() => changeQuantity(-1n)}
            size="compact"
            variant="secondary"
          >
            −
          </Button>
          <output aria-live="polite">{quantity}</output>
          <Button
            aria-label="Increase quantity"
            disabled={BigInt(quantity) >= max}
            onClick={() => changeQuantity(1n)}
            size="compact"
            variant="secondary"
          >
            +
          </Button>
        </fieldset>
      </div>
      <p className="field-description">
        Maximum {product.maxPerOrder} per customer across confirmed purchases.
      </p>
      <div className="buy-card__total">
        <span>Total</span>
        <MoneyAmount baseUnits={total} label="Total" />
      </div>
      {product.projectionStale ? (
        <InlineAlert title="Availability is updating" tone="warning">
          Checkout stays paused until a fresh product record is verified.
        </InlineAlert>
      ) : null}
      {error ? (
        <InlineAlert title="Checkout did not start" tone="danger">
          <p>{error} No payment was submitted.</p>
        </InlineAlert>
      ) : null}
      <Button
        disabled={
          unavailable || product.projectionStale || mode === 'live-unavailable' || !paymentsEnabled
        }
        loading={pending}
        loadingLabel="Starting secure checkout"
        onClick={async () => {
          setPending(true);
          setError(undefined);
          try {
            if (mode === 'deterministic') {
              const { createDeterministicFrontendTransport } = await import(
                '../../client/frontend-transport'
              );
              const result = await createDeterministicFrontendTransport().startCheckout(
                { productId: product.id, quantity },
                createIdempotencyKey(),
              );
              if (!result.accepted || !result.resourceId)
                throw new Error('The demo did not accept this checkout.');
              window.location.assign(
                `/checkout/${encodeURIComponent(result.resourceId)}?quantity=${quantity}`,
              );
              return;
            }
            // Wallet/provider code is intentionally absent from the anonymous
            // product-page critical path. Load the application boundary only
            // after the buyer explicitly starts checkout.
            const { getBrowserApplicationService } = await import(
              '../../application/browser-application-service'
            );
            const result = await getBrowserApplicationService().startCheckout(
              { productId: product.id, quantity },
              createIdempotencyKey(),
            );
            window.location.assign(`/checkout/${encodeURIComponent(result.sessionId)}`);
          } catch (caught) {
            setPending(false);
            setError(
              caught instanceof Error ? caught.message : 'OpenTab could not start this checkout.',
            );
          }
        }}
        size="large"
      >
        Continue · <MoneyAmount baseUnits={total} />
      </Button>
      {mode === 'live-unavailable' ? (
        <p className="disabled-reason">
          Live checkout is disabled until the server confirms provider and contract readiness.
        </p>
      ) : null}
      {mode === 'live' && !paymentsEnabled ? (
        <p className="disabled-reason">
          Checkout is paused while the merchant can still manage products and review orders.
        </p>
      ) : null}
      {unavailable ? (
        <p className="disabled-reason">This offer is not currently available to buy.</p>
      ) : null}
      <p className="trust-line">
        <span aria-hidden="true">✓</span> Secure checkout. Pay from your available balance.
      </p>
    </section>
  );
}
