import { cn } from '../lib/cn.js';

export type CanonicalTone =
  | 'confirmed'
  | 'processing'
  | 'attention'
  | 'refunded'
  | 'failed'
  | 'neutral';

export interface CanonicalStatusProps {
  label: string;
  tone: CanonicalTone;
  className?: string;
}

export function CanonicalStatus({ className, label, tone }: CanonicalStatusProps) {
  const mark =
    tone === 'confirmed'
      ? '✓'
      : tone === 'processing'
        ? '↻'
        : tone === 'refunded'
          ? '↩'
          : tone === 'failed'
            ? '×'
            : '•';
  return (
    <span className={cn('ot-status', `ot-status--${tone}`, className)}>
      <span aria-hidden="true">{mark}</span>
      {label}
    </span>
  );
}
