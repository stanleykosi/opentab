import { describe, expect, it } from 'vitest';
import { demoCheckout } from './deterministic-data';
import { calculateCheckoutQuoteTotals, repriceCheckoutQuantity } from './quote-money';

describe('checkout quote money', () => {
  it('scales the product amount and adds the decimal fee using base-unit arithmetic', () => {
    expect(
      calculateCheckoutQuoteTotals({
        unitPriceBaseUnits: '18000000',
        quantity: '2',
        estimatedFeeUsd: '0.14',
      }),
    ).toEqual({ productBaseUnits: '36000000', maximumTotalUsd: '36.14' });
  });

  it('preserves micro-USDC precision without a JavaScript number conversion', () => {
    expect(
      calculateCheckoutQuoteTotals({
        unitPriceBaseUnits: '1',
        quantity: '3',
        estimatedFeeUsd: '0.000001',
      }),
    ).toEqual({ productBaseUnits: '3', maximumTotalUsd: '0.000004' });
  });

  it('reprices every quantity-bound quote field together', () => {
    const checkout = repriceCheckoutQuantity(demoCheckout('preview_ready'), '2');
    expect(checkout.quantity).toBe('2');
    expect(checkout.quote).toMatchObject({
      productBaseUnits: '36000000',
      maximumTotalUsd: '36.14',
    });
  });
});
