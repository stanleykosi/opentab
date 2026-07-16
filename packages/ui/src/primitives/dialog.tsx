'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  dismissible?: boolean;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(dialog: HTMLDialogElement): readonly HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) =>
      element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}

export function Dialog({
  children,
  className,
  description,
  dismissible = true,
  onOpenChange,
  open,
  title,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-dialog-title`;
  const descriptionId = description ? `${titleId}-description` : undefined;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
    return () => {
      if (!open) return;
      if (dialog.open) dialog.close();
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open]);

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className={cn('ot-dialog', className)}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onOpenChange(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = focusableElements(event.currentTarget);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === null)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      ref={ref}
    >
      <div className="ot-dialog__head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        {dismissible ? (
          <Button
            aria-label={`Close ${title}`}
            onClick={() => onOpenChange(false)}
            size="compact"
            variant="quiet"
          >
            <span aria-hidden="true">×</span>
          </Button>
        ) : null}
      </div>
      {children}
    </dialog>
  );
}

export function Drawer(props: DialogProps) {
  return <Dialog {...props} className={cn('ot-drawer', props.className)} />;
}
