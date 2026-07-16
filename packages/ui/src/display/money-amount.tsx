import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

export function formatBaseUnitCurrency(
  value: string,
  options: { decimals?: number; currency?: string; locale?: string } = {},
): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RangeError('Amount must be unsigned base units');
  const decimals = options.decimals ?? 6;
  const currency = options.currency ?? 'USD';
  const locale = options.locale ?? 'en-US';
  const amount = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fractionRaw = (amount % scale).toString().padStart(decimals, '0');
  const fraction =
    decimals === 0
      ? ''
      : fractionRaw.slice(2).replace(/0+$/g, '').length > 0
        ? fractionRaw.replace(/0+$/g, '')
        : fractionRaw.slice(0, 2).padEnd(2, '0');
  const wholeFormatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole);
  const symbol = currency === 'USD' || currency === 'USDC' ? '$' : `${currency} `;
  return `${symbol}${wholeFormatted}${fraction ? `.${fraction}` : ''}`;
}

export function decimalToBaseUnits(value: string, decimals = 6): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) {
    throw new RangeError('Amount must be an unsigned decimal string');
  }
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new RangeError(`Amount supports at most ${decimals} decimal places`);
  }
  const scale = 10n ** BigInt(decimals);
  return (BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

export interface MoneyAmountProps extends HTMLAttributes<HTMLSpanElement> {
  baseUnits: string;
  currency?: string;
  decimals?: number;
  label?: string;
}

export function MoneyAmount({
  baseUnits,
  className,
  currency = 'USDC',
  decimals = 6,
  label,
  ...props
}: MoneyAmountProps) {
  const formatted = formatBaseUnitCurrency(baseUnits, { currency, decimals });
  return (
    <span {...props} className={cn('ot-money', className)}>
      {label ? <span className="ot-sr-only">{label}: </span> : null}
      {formatted}
    </span>
  );
}
