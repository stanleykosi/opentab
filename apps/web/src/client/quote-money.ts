import {
  addBaseUnits,
  BaseUnitAmountSchema,
  formatUsdc,
  multiplyBaseUnits,
  parseUsdcDecimal,
  QuantitySchema,
} from '@opentab/shared';
import type { CheckoutSnapshotView } from './view-models';

export function calculateCheckoutQuoteTotals(input: {
  unitPriceBaseUnits: string;
  quantity: string;
  estimatedFeeUsd: string;
}): { productBaseUnits: string; maximumTotalUsd: string } {
  const productBaseUnits = multiplyBaseUnits(
    BaseUnitAmountSchema.parse(input.unitPriceBaseUnits),
    QuantitySchema.parse(input.quantity),
  );
  const maximumBaseUnits = addBaseUnits(productBaseUnits, parseUsdcDecimal(input.estimatedFeeUsd));
  return {
    productBaseUnits,
    maximumTotalUsd: formatUsdc(maximumBaseUnits, { trimTrailingZeros: true }),
  };
}

export function repriceCheckoutQuantity(
  snapshot: CheckoutSnapshotView,
  quantity: string,
): CheckoutSnapshotView {
  if (!snapshot.quote) return { ...snapshot, quantity };
  const totals = calculateCheckoutQuoteTotals({
    unitPriceBaseUnits: snapshot.product.unitPriceBaseUnits,
    quantity,
    estimatedFeeUsd: snapshot.quote.estimatedFeeUsd,
  });
  return {
    ...snapshot,
    quantity,
    quote: { ...snapshot.quote, ...totals },
  };
}
