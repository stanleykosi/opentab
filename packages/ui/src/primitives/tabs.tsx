'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
}

export interface TabsProps {
  items: readonly TabItem[];
  selectedId: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
}

export function keyboardTabIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | undefined {
  if (itemCount <= 0) return undefined;
  switch (key) {
    case 'ArrowRight':
      return (currentIndex + 1) % itemCount;
    case 'ArrowLeft':
      return (currentIndex - 1 + itemCount) % itemCount;
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
    default:
      return undefined;
  }
}

export function Tabs({ className, items, label, onChange, selectedId }: TabsProps) {
  return (
    <div className={className}>
      <div aria-label={label} className="ot-tabs" role="tablist">
        {items.map((item, currentIndex) => {
          const tabId = `${item.id}-tab`;
          return (
            <button
              aria-controls={`${item.id}-panel`}
              aria-selected={selectedId === item.id}
              className={cn('ot-tab', selectedId === item.id && 'ot-tab--active')}
              id={tabId}
              key={item.id}
              onClick={() => onChange(item.id)}
              onKeyDown={(event) => {
                const nextIndex = keyboardTabIndex(event.key, currentIndex, items.length);
                if (nextIndex === undefined) return;
                const next = items[nextIndex];
                if (next === undefined) return;
                event.preventDefault();
                onChange(next.id);
                document.getElementById(`${next.id}-tab`)?.focus();
              }}
              role="tab"
              tabIndex={selectedId === item.id ? 0 : -1}
              type="button"
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) =>
        selectedId === item.id ? (
          <div
            aria-labelledby={`${item.id}-tab`}
            id={`${item.id}-panel`}
            key={item.id}
            role="tabpanel"
          >
            {item.panel}
          </div>
        ) : null,
      )}
    </div>
  );
}
