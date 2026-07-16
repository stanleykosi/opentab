import { cn } from '../lib/cn.js';

export interface TimelineItem {
  id: string;
  label: string;
  detail?: string | undefined;
  status: 'complete' | 'current' | 'upcoming' | 'attention';
}

export interface ProgressTimelineProps {
  items: readonly TimelineItem[];
  label?: string;
}

export function ProgressTimeline({ items, label = 'Payment progress' }: ProgressTimelineProps) {
  return (
    <ol aria-label={label} className="ot-timeline">
      {items.map((item) => (
        <li
          aria-current={item.status === 'current' ? 'step' : undefined}
          className={cn('ot-timeline__item', `ot-timeline__item--${item.status}`)}
          key={item.id}
        >
          <span aria-hidden="true" className="ot-timeline__node">
            {item.status === 'complete' ? '✓' : ''}
          </span>
          <div>
            <strong>{item.label}</strong>
            {item.detail ? <p>{item.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
