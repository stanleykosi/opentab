'use client';

import {
  Button,
  Checkbox,
  Dialog,
  decimalToBaseUnits,
  InlineAlert,
  MoneyAmount,
  SelectField,
  TextArea,
  TextField,
} from '@opentab/ui';
import { useMemo, useState } from 'react';
import { createDeterministicFrontendTransport } from '../../client/frontend-transport';
import type { PresentationMode } from '../../client/view-models';

export interface ProductDraftInput {
  title: string;
  slug: string;
  description: string;
  imageUrl?: string;
  unitPriceBaseUnits: string;
  maxSupply: string;
  maxPerOrder: string;
  startsAt: string;
  endsAt?: string;
  refundWindowSeconds: string;
  loyaltyPoints: string;
}

export type ProductResult = { id: string; slug: string; status: string };
export type ProductPreparedResult = ProductResult & {
  operationId: string;
  estimatedFeeUsd: string;
  maximumTotalUsd: string;
};
type PublishState =
  | 'draft'
  | 'review'
  | 'publishing'
  | 'approval'
  | 'submitting'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'error';

function asIso(value: string): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function ProductForm({
  createProduct,
  merchantSlug = 'your-store',
  mode,
  submitProduct,
}: {
  mode: PresentationMode;
  merchantSlug?: string;
  createProduct?: (input: ProductDraftInput) => Promise<ProductPreparedResult>;
  submitProduct?: (operationId: string) => Promise<ProductResult>;
}) {
  const [title, setTitle] = useState('Golden Hour Supper');
  const [slug, setSlug] = useState('golden-hour-supper');
  const [description, setDescription] = useState(
    'A six-seat supper with a seasonal menu and sunset listening session.',
  );
  const [imageUrl, setImageUrl] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const [price, setPrice] = useState('24.00');
  const [inventory, setInventory] = useState('18');
  const [maxPerOrder, setMaxPerOrder] = useState('4');
  const [loyalty, setLoyalty] = useState('240');
  const [startsAt, setStartsAt] = useState('2027-08-02T12:00');
  const [endsAt, setEndsAt] = useState('2027-08-02T16:00');
  const [refundWindow, setRefundWindow] = useState('172800');
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, setState] = useState<PublishState>('draft');
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<ProductResult>();
  const [prepared, setPrepared] = useState<ProductPreparedResult>();
  const priceBaseUnits = useMemo(() => {
    try {
      return decimalToBaseUnits(price);
    } catch {
      return undefined;
    }
  }, [price]);
  const startsAtIso = asIso(startsAt);
  const endsAtIso = endsAt.length === 0 ? undefined : asIso(endsAt);
  const imageValid =
    imageUrl.length === 0 ||
    (() => {
      try {
        return new URL(imageUrl).protocol === 'https:';
      } catch {
        return false;
      }
    })();

  const validate = () => {
    if (title.trim().length < 3)
      return { fieldId: 'product-title', message: 'Give the product a complete title.' };
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      return {
        fieldId: 'product-slug',
        message: 'Use lowercase letters, numbers, and single hyphens in the URL.',
      };
    if (!imageValid)
      return {
        fieldId: 'product-image-url',
        message: 'Use a complete HTTPS image URL or leave the image empty.',
      };
    if (!priceBaseUnits || BigInt(priceBaseUnits) === 0n)
      return {
        fieldId: 'product-price',
        message: 'Enter a price greater than zero with up to six decimal places.',
      };
    if (!/^[1-9][0-9]*$/.test(inventory))
      return {
        fieldId: 'product-inventory',
        message: 'Inventory must be a whole number greater than zero.',
      };
    if (!/^[1-9][0-9]*$/.test(maxPerOrder))
      return {
        fieldId: 'product-max-per-customer',
        message: 'The purchase limit must be a whole number greater than zero.',
      };
    if (BigInt(maxPerOrder) > BigInt(inventory))
      return {
        fieldId: 'product-max-per-customer',
        message: 'The cumulative per-customer limit cannot exceed inventory.',
      };
    if (startsAtIso === undefined)
      return { fieldId: 'product-starts-at', message: 'Enter a valid start date.' };
    if (endsAt.length > 0 && endsAtIso === undefined)
      return { fieldId: 'product-ends-at', message: 'Enter a valid end date.' };
    if (endsAtIso !== undefined && new Date(endsAtIso) <= new Date(startsAtIso))
      return { fieldId: 'product-ends-at', message: 'The end date must be after the start date.' };
    if (!/^(0|[1-9][0-9]*)$/.test(loyalty))
      return { fieldId: 'product-loyalty', message: 'Loyalty points must be a whole number.' };
    if (!acknowledged)
      return {
        fieldId: 'product-policy',
        message: 'Confirm the product and refund information before publishing.',
      };
    return undefined;
  };

  if ((state === 'confirmed' || state === 'awaiting_confirmation') && created !== undefined) {
    const confirmed = state === 'confirmed';
    return (
      <section className="publish-result">
        <p className="eyebrow">{confirmed ? 'Product registered' : 'Registration requested'}</p>
        <h1>
          {title} {confirmed ? 'is registered' : 'is being confirmed'}
        </h1>
        <InlineAlert
          title={confirmed ? 'Product registration confirmed' : 'Canonical confirmation pending'}
          tone={confirmed ? 'success' : 'info'}
        >
          <p>
            {confirmed
              ? mode === 'deterministic'
                ? 'This explicit deterministic demo did not send a live transaction.'
                : 'The indexed canonical product record is registered. Activate sales from product detail.'
              : 'The durable operation is saved. OpenTab will not call this product registered until the canonical product event is indexed.'}
          </p>
        </InlineAlert>
        <div className="page-actions">
          <a className="ot-button ot-button--primary" href={`/merchant/products/${created.id}`}>
            Check product status
          </a>
          <a className="ot-button ot-button--secondary" href={`/c/${merchantSlug}/${created.slug}`}>
            Buyer view
          </a>
        </div>
      </section>
    );
  }

  const submitPublication = async () => {
    if (priceBaseUnits === undefined || startsAtIso === undefined) return;
    setState('publishing');
    setError(undefined);
    const input: ProductDraftInput = {
      title,
      slug,
      description,
      ...(imageUrl.length === 0 ? {} : { imageUrl }),
      unitPriceBaseUnits: priceBaseUnits,
      maxSupply: inventory,
      maxPerOrder,
      startsAt: startsAtIso,
      ...(endsAtIso === undefined ? {} : { endsAt: endsAtIso }),
      refundWindowSeconds: refundWindow,
      loyaltyPoints: loyalty,
    };
    try {
      if (mode === 'live') {
        if (createProduct === undefined) throw new Error('Live product creation is unavailable.');
        const result = await createProduct(input);
        setCreated(result);
        setPrepared(result);
        setState('approval');
        return;
      }
      const result = await createDeterministicFrontendTransport().createProduct(
        {
          title,
          slug,
          description,
          unitPriceBaseUnits: priceBaseUnits,
          inventory,
          maxPerOrder,
          refundWindowSeconds: refundWindow,
          loyaltyPoints: loyalty,
        },
        `product-${slug}`,
      );
      if (result.resourceId === undefined) {
        throw new Error('The deterministic product reference was not returned.');
      }
      setCreated({ id: result.resourceId, slug, status: 'active' });
      window.setTimeout(() => setState('confirmed'), 900);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Publication could not start.');
      setState('error');
    }
  };

  const confirmPublication = async () => {
    if (prepared === undefined || submitProduct === undefined) return;
    setState('submitting');
    setError(undefined);
    try {
      const result = await submitProduct(prepared.operationId);
      setCreated((current) =>
        current === undefined ? result : { ...current, status: result.status },
      );
      setState(result.status === 'confirmed' ? 'confirmed' : 'awaiting_confirmation');
    } catch (caught) {
      const submissionPossible =
        typeof caught === 'object' &&
        caught !== null &&
        'submissionPossible' in caught &&
        caught.submissionPossible === true;
      setError(
        caught instanceof Error
          ? caught.message
          : 'The product operation could not be submitted safely.',
      );
      setState(submissionPossible ? 'awaiting_confirmation' : 'error');
    }
  };

  return (
    <div className="product-editor">
      <form
        className="product-form"
        onSubmit={(event) => {
          event.preventDefault();
          const validationError = validate();
          if (validationError !== undefined) {
            setError(validationError.message);
            setState('error');
            document.getElementById(validationError.fieldId)?.focus();
            return;
          }
          setError(undefined);
          setState('review');
        }}
      >
        <header className="page-heading">
          <p className="eyebrow">New product</p>
          <h1>Create a checkout</h1>
          <p>Draft the buyer-facing offer and review exact values before publication.</p>
        </header>
        {error === undefined ? null : (
          <div className="form-error-summary" role="alert" tabIndex={-1}>
            <strong>Review the product</strong>
            <p>{error}</p>
          </div>
        )}
        <fieldset>
          <legend>Offer</legend>
          <TextField
            id="product-title"
            label="Product or event name"
            maxLength={120}
            onChange={(event) => setTitle(event.currentTarget.value)}
            required
            value={title}
          />
          <TextField
            description={`Checkout link: /c/${merchantSlug}/${slug || 'your-link'}`}
            id="product-slug"
            label="URL slug"
            onChange={(event) => setSlug(event.currentTarget.value)}
            required
            value={slug}
          />
          <TextArea
            label="Description"
            maxLength={4000}
            onChange={(event) => setDescription(event.currentTarget.value)}
            required
            value={description}
          />
          <TextField
            description="Optional approved HTTPS media URL. Buyer pages use a neutral fallback unless the origin is allowed by OpenTab."
            id="product-image-url"
            label="Image URL"
            onChange={(event) => {
              setImageUrl(event.currentTarget.value);
              setImageFailed(false);
            }}
            type="url"
            value={imageUrl}
            {...(imageValid ? {} : { error: 'Use a complete HTTPS URL.' })}
          />
        </fieldset>
        <fieldset>
          <legend>Price, inventory, and schedule</legend>
          <TextField
            description="Exact USDC amount with up to six decimals."
            id="product-price"
            inputMode="decimal"
            label="Price (USDC)"
            onChange={(event) => setPrice(event.currentTarget.value)}
            required
            value={price}
            {...(priceBaseUnits === undefined ? { error: 'Enter a valid decimal amount.' } : {})}
          />
          <div className="field-pair">
            <TextField
              id="product-inventory"
              inputMode="numeric"
              label="Inventory"
              onChange={(event) => setInventory(event.currentTarget.value)}
              required
              value={inventory}
            />
            <TextField
              id="product-max-per-customer"
              inputMode="numeric"
              label="Maximum per customer"
              onChange={(event) => setMaxPerOrder(event.currentTarget.value)}
              required
              value={maxPerOrder}
            />
          </div>
          <div className="field-pair">
            <TextField
              id="product-starts-at"
              label="Starts at"
              onChange={(event) => setStartsAt(event.currentTarget.value)}
              required
              type="datetime-local"
              value={startsAt}
            />
            <TextField
              id="product-ends-at"
              label="Ends at"
              onChange={(event) => setEndsAt(event.currentTarget.value)}
              type="datetime-local"
              value={endsAt}
            />
          </div>
          <SelectField
            label="Refund window"
            onChange={(event) => setRefundWindow(event.currentTarget.value)}
            value={refundWindow}
          >
            <option value="0">Non-refundable</option>
            <option value="86400">24 hours after the payment window closes</option>
            <option value="172800">48 hours after the payment window closes</option>
            <option value="604800">7 days after the payment window closes</option>
          </SelectField>
        </fieldset>
        <fieldset>
          <legend>Receipt and loyalty</legend>
          <TextField
            description="Whole points awarded only after confirmed payment."
            id="product-loyalty"
            inputMode="numeric"
            label="Loyalty points"
            onChange={(event) => setLoyalty(event.currentTarget.value)}
            value={loyalty}
          />
          <Checkbox
            checked={acknowledged}
            description="Publishing creates a durable version. Products with sales can be archived, not deleted."
            id="product-policy"
            label="I reviewed the offer, schedule, image, refund terms, and buyer preview"
            onChange={(event) => setAcknowledged(event.currentTarget.checked)}
          />
        </fieldset>
        <div className="page-actions">
          <Button size="large" type="submit">
            Review product
          </Button>
          <a className="ot-button ot-button--quiet" href="/merchant/products">
            Save and leave
          </a>
        </div>
      </form>
      <aside aria-label="Buyer preview" className="buyer-preview">
        <p className="eyebrow">Buyer preview</p>
        <div className="buyer-preview__art">
          {imageUrl.length > 0 && imageValid && !imageFailed ? (
            // biome-ignore lint/performance/noImgElement: merchant draft preview is remote and not yet trusted for Next image optimization
            <img alt="Merchant offer preview" onError={() => setImageFailed(true)} src={imageUrl} />
          ) : (
            <span>{title.slice(0, 1) || 'O'}</span>
          )}
        </div>
        <h2>{title || 'Untitled offer'}</h2>
        <p>{description || 'Your description will appear here.'}</p>
        <p>
          {startsAtIso === undefined ? 'Schedule needed' : new Date(startsAtIso).toLocaleString()}
        </p>
        <div>
          <MoneyAmount baseUnits={priceBaseUnits ?? '0'} />
          <span>{inventory} available</span>
        </div>
        <button disabled type="button">
          Continue
        </button>
      </aside>
      {(state === 'review' ||
        state === 'publishing' ||
        state === 'approval' ||
        state === 'submitting') &&
      priceBaseUnits !== undefined ? (
        <Dialog
          className="review-card"
          description="Review the exact registration values before preparing the embedded-account approval."
          dismissible={state === 'review'}
          onOpenChange={(open) => {
            if (!open && state === 'review') setState('draft');
          }}
          open
          title={`Register ${title}?`}
        >
          <dl className="payment-ledger">
            <div>
              <dt>Price</dt>
              <dd>
                <MoneyAmount baseUnits={priceBaseUnits} />
              </dd>
            </div>
            <div>
              <dt>Inventory</dt>
              <dd>{inventory}</dd>
            </div>
            <div>
              <dt>Starts</dt>
              <dd>{startsAtIso}</dd>
            </div>
            <div>
              <dt>Refund window</dt>
              <dd>{refundWindow} seconds</dd>
            </div>
          </dl>
          <InlineAlert title="Canonical confirmation required" tone="info">
            <p>
              Registration and sales activation are separate, canonically confirmed changes. This
              step cannot make an unconfirmed product available to buyers.
            </p>
          </InlineAlert>
          {state === 'approval' || state === 'submitting' ? (
            <>
              <InlineAlert title="Exact calls verified" tone="warning">
                <p>
                  The destination and product registration call were re-derived from the
                  server-bound operation before this approval.
                </p>
              </InlineAlert>
              <dl className="payment-ledger">
                <div>
                  <dt>Estimated payment cost</dt>
                  <dd>${prepared?.estimatedFeeUsd ?? '—'}</dd>
                </div>
                <div className="payment-ledger__total">
                  <dt>Maximum total</dt>
                  <dd>${prepared?.maximumTotalUsd ?? '—'}</dd>
                </div>
              </dl>
            </>
          ) : null}
          <div className="page-actions">
            {state === 'approval' || state === 'submitting' ? (
              <>
                <Button loading={state === 'submitting'} onClick={() => void confirmPublication()}>
                  Approve product registration
                </Button>
                <a
                  className="ot-button ot-button--quiet"
                  href={`/merchant/products/${created?.id ?? ''}`}
                >
                  Leave and resume safely
                </a>
              </>
            ) : (
              <>
                <Button loading={state === 'publishing'} onClick={() => void submitPublication()}>
                  Prepare exact registration
                </Button>
                <Button onClick={() => setState('draft')} variant="quiet">
                  Back to editing
                </Button>
              </>
            )}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
