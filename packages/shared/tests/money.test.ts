import { describe, expect, it } from 'vitest';
import {
  addBaseUnits,
  applyBasisPointsFloor,
  BaseUnitAmountSchema,
  BasisPointsSchema,
  formatUsdc,
  multiplyBaseUnits,
  parseUsdcDecimal,
  QuantitySchema,
  subtractBaseUnits,
} from '../src/index.js';

describe('exact base-unit money', () => {
  it('parses and formats six-decimal USDC without floating point', () => {
    const amount = parseUsdcDecimal('12345678901234567890.000001');
    expect(amount).toBe('12345678901234567890000001');
    expect(formatUsdc(amount)).toBe('12345678901234567890.000001');
  });

  it('uses floor rounding for basis points and exact arithmetic', () => {
    const unit = BaseUnitAmountSchema.parse('1000001');
    const quantity = QuantitySchema.parse('3');
    const gross = multiplyBaseUnits(unit, quantity);
    const fee = applyBasisPointsFloor(gross, BasisPointsSchema.parse('125'));
    expect(gross).toBe('3000003');
    expect(fee).toBe('37500');
    expect(addBaseUnits(subtractBaseUnits(gross, fee), fee)).toBe(gross);
  });

  it('rejects negative or over-precision inputs', () => {
    expect(() => parseUsdcDecimal('-1')).toThrow();
    expect(() => parseUsdcDecimal('1.0000001')).toThrow();
    expect(() =>
      subtractBaseUnits(BaseUnitAmountSchema.parse('1'), BaseUnitAmountSchema.parse('2')),
    ).toThrow();
  });

  it('rejects values outside Solidity integer widths', () => {
    expect(() => BaseUnitAmountSchema.parse((1n << 256n).toString())).toThrow();
    expect(() => QuantitySchema.parse((1n << 64n).toString())).toThrow();
  });
});
