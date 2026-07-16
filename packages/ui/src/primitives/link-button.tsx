import type { AnchorHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';
import type { ButtonSize, ButtonVariant } from './button.js';

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function LinkButton({
  className,
  size = 'default',
  variant = 'primary',
  ...props
}: LinkButtonProps) {
  return (
    <a
      {...props}
      className={cn('ot-button', `ot-button--${variant}`, `ot-button--${size}`, className)}
    />
  );
}
