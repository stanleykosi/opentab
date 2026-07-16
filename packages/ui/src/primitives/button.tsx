import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'compact' | 'default' | 'large';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  leading?: ReactNode;
}

export function Button({
  children,
  className,
  disabled,
  leading,
  loading = false,
  loadingLabel = 'Working',
  size = 'default',
  type = 'button',
  variant = 'primary',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={cn('ot-button', `ot-button--${variant}`, `ot-button--${size}`, className)}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <span aria-hidden="true" className="ot-spinner" /> : leading}
      <span>{loading ? loadingLabel : children}</span>
    </button>
  );
}
