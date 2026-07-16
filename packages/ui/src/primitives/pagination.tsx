import type { ReactNode } from 'react';
import { Button } from './button.js';

export interface PaginationProps {
  label?: string;
  pageLabel: string;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  previousLabel?: ReactNode;
  nextLabel?: ReactNode;
}

export function Pagination({
  label = 'Pagination',
  nextDisabled,
  nextLabel = 'Next',
  onNext,
  onPrevious,
  pageLabel,
  previousDisabled,
  previousLabel = 'Previous',
}: PaginationProps) {
  return (
    <nav aria-label={label} className="ot-pagination">
      <Button disabled={previousDisabled} onClick={onPrevious} variant="secondary">
        {previousLabel}
      </Button>
      <span aria-current="page">{pageLabel}</span>
      <Button disabled={nextDisabled} onClick={onNext} variant="secondary">
        {nextLabel}
      </Button>
    </nav>
  );
}
