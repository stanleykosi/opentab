'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from './button.js';

export interface CopyButtonProps {
  value: string;
  label: string;
  copiedLabel?: string;
}

export function CopyButton({ copiedLabel = 'Copied', label, value }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );
  return (
    <Button
      aria-live="polite"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        timeoutRef.current = setTimeout(() => setCopied(false), 1800);
      }}
      size="compact"
      variant="quiet"
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}
