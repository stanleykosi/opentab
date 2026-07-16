import { z } from 'zod';

export const UINT64_MAX = 18_446_744_073_709_551_615n;
export const UINT256_MAX = (1n << 256n) - 1n;

export const UnsignedIntegerStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= UINT256_MAX, 'Value must fit uint256')
  .brand<'UnsignedIntegerString'>();
export const BaseUnitAmountSchema = UnsignedIntegerStringSchema.brand<'BaseUnitAmount'>();
export const QuantitySchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= UINT64_MAX, 'Quantity must fit uint64')
  .brand<'Quantity'>();
export const Uint64StringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= UINT64_MAX, 'Value must fit uint64')
  .brand<'Uint64String'>();
export const BasisPointsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,3}|10000)$/)
  .refine((value) => BigInt(value) <= 10_000n, 'Basis points must not exceed 10000')
  .brand<'BasisPoints'>();

export type UnsignedIntegerString = z.infer<typeof UnsignedIntegerStringSchema>;
export type BaseUnitAmount = z.infer<typeof BaseUnitAmountSchema>;
export type Quantity = z.infer<typeof QuantitySchema>;
export type Uint64String = z.infer<typeof Uint64StringSchema>;
export type BasisPoints = z.infer<typeof BasisPointsSchema>;

export const USDC_DECIMALS = 6n;
export const BPS_DENOMINATOR = 10_000n;

export function toBaseUnitBigInt(value: BaseUnitAmount | UnsignedIntegerString): bigint {
  return BigInt(value);
}

export function fromBaseUnitBigInt(value: bigint): BaseUnitAmount {
  if (value < 0n) throw new RangeError('Base-unit amount cannot be negative');
  return BaseUnitAmountSchema.parse(value.toString());
}

export function addBaseUnits(...values: readonly BaseUnitAmount[]): BaseUnitAmount {
  return fromBaseUnitBigInt(values.reduce((sum, value) => sum + BigInt(value), 0n));
}

export function subtractBaseUnits(
  minuend: BaseUnitAmount,
  subtrahend: BaseUnitAmount,
): BaseUnitAmount {
  const result = BigInt(minuend) - BigInt(subtrahend);
  if (result < 0n) throw new RangeError('Base-unit subtraction would be negative');
  return fromBaseUnitBigInt(result);
}

export function multiplyBaseUnits(amount: BaseUnitAmount, quantity: Quantity): BaseUnitAmount {
  return fromBaseUnitBigInt(BigInt(amount) * BigInt(quantity));
}

export function applyBasisPointsFloor(
  amount: BaseUnitAmount,
  basisPoints: BasisPoints,
): BaseUnitAmount {
  return fromBaseUnitBigInt((BigInt(amount) * BigInt(basisPoints)) / BPS_DENOMINATOR);
}

export function parseUsdcDecimal(value: string): BaseUnitAmount {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!match)
    throw new RangeError('USDC amount must be a non-negative decimal with at most 6 places');
  const whole = match[1];
  if (whole === undefined) throw new RangeError('USDC whole amount is required');
  const fraction = (match[2] ?? '').padEnd(Number(USDC_DECIMALS), '0');
  return fromBaseUnitBigInt(BigInt(whole) * 1_000_000n + BigInt(fraction || '0'));
}

export function formatUsdc(
  amount: BaseUnitAmount,
  options?: { trimTrailingZeros?: boolean },
): string {
  const value = BigInt(amount);
  const whole = value / 1_000_000n;
  const rawFraction = (value % 1_000_000n).toString().padStart(6, '0');
  const fraction = options?.trimTrailingZeros ? rawFraction.replace(/0+$/, '') : rawFraction;
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

export function sumEquals(values: readonly BaseUnitAmount[], expected: BaseUnitAmount): boolean {
  return values.reduce((sum, value) => sum + BigInt(value), 0n) === BigInt(expected);
}
