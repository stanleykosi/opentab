import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { MoneyAmount } from './money-amount.js';
import { CanonicalStatus } from './status.js';

export interface ReceiptFrameProps {
  merchant: string;
  item: string;
  amountBaseUnits: string;
  orderReference: string;
  timestamp: string;
  status: { label: string; tone: Parameters<typeof CanonicalStatus>[0]['tone'] };
  children?: ReactNode;
}

export function ReceiptFrame({
  amountBaseUnits,
  children,
  item,
  merchant,
  orderReference,
  status,
  timestamp,
}: ReceiptFrameProps) {
  return (
    <article className="ot-receipt">
      <div className="ot-receipt__seam" aria-hidden="true" />
      <header>
        <p className="ot-eyebrow">Receipt</p>
        <h2>{merchant}</h2>
        <CanonicalStatus {...status} />
      </header>
      <dl className="ot-ledger">
        <div>
          <dt>Item</dt>
          <dd>{item}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>
            <MoneyAmount baseUnits={amountBaseUnits} />
          </dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd className="ot-mono">{orderReference}</dd>
        </div>
        <div>
          <dt>Confirmed</dt>
          <dd>{timestamp}</dd>
        </div>
      </dl>
      {children}
    </article>
  );
}

export interface PassFrameProps {
  merchant: string;
  title: string;
  date: string;
  location: string;
  holder?: string;
  status?: string;
  children?: ReactNode;
  className?: string;
}

export function PassFrame({
  children,
  className,
  date,
  holder,
  location,
  merchant,
  status = 'Valid',
  title,
}: PassFrameProps) {
  return (
    <article className={cn('ot-pass', className)}>
      <div className="ot-pass__texture" aria-hidden="true" />
      <header>
        <p>{merchant}</p>
        <span>{status}</span>
      </header>
      <div className="ot-pass__body">
        <p className="ot-eyebrow">Your pass</p>
        <h2>{title}</h2>
        <p>{date}</p>
        <p>{location}</p>
      </div>
      <footer>
        <span>{holder ?? 'Pass holder'}</span>
        <span>Non-transferable</span>
      </footer>
      {children}
    </article>
  );
}

export function EmptyState({
  action,
  body,
  title,
}: {
  action?: ReactNode;
  body: string;
  title: string;
}) {
  return (
    <section className="ot-empty">
      <span aria-hidden="true" className="ot-empty__mark">
        ◇
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}
