import type { ReactNode } from 'react';
import { useId } from 'react';

export function Tooltip({ children, content }: { children: ReactNode; content: string }) {
  const id = useId();
  return (
    <span className="ot-tooltip">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Text-only tooltip triggers need keyboard discovery. */}
      <span aria-describedby={id} className="ot-tooltip__trigger" tabIndex={0}>
        {children}
      </span>
      <span className="ot-tooltip__content" id={id} role="tooltip">
        {content}
      </span>
    </span>
  );
}
