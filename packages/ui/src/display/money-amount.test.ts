import { describe, expect, it } from 'vitest';
import { decimalToBaseUnits, formatBaseUnitCurrency } from './money-amount.js';

describe('exact money formatting', () => {
  it('formats whole-cent USDC without floating point', () => {
    expect(formatBaseUnitCurrency('18000000')).toBe('$18.00');
    expect(formatBaseUnitCurrency('1000001')).toBe('$1.000001');
  });

  it('converts decimal input to exact base units', () => {
    expect(decimalToBaseUnits('18.14')).toBe('18140000');
    expect(decimalToBaseUnits('0.000001')).toBe('1');
  });

  it('rejects negative, exponent, and over-precision input', () => {
    expect(() => decimalToBaseUnits('-1')).toThrow(RangeError);
    expect(() => decimalToBaseUnits('1e6')).toThrow(RangeError);
    expect(() => decimalToBaseUnits('1.0000001')).toThrow(RangeError);
  });
});
