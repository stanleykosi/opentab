import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

export interface InlineAlertProps extends HTMLAttributes<HTMLDivElement> {
  tone?: AlertTone;
  title: string;
  children?: ReactNode;
}

export function InlineAlert({
  children,
  className,
  title,
  tone = 'info',
  ...props
}: InlineAlertProps) {
  return (
    <div
      {...props}
      className={cn('ot-alert', `ot-alert--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <span aria-hidden="true" className="ot-alert__mark">
        {tone === 'success' ? '✓' : tone === 'danger' ? '!' : 'i'}
      </span>
      <div>
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} aria-hidden="true" className={cn('ot-skeleton', className)} />;
}

export function VisuallyHidden({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={cn('ot-sr-only', className)} />;
}
