import type { ReactNode } from 'react';
import { CopyButton } from '../primitives/copy-button.js';

export interface EvidenceRowProps {
  label: string;
  value: string;
  copyLabel?: string;
  trailing?: ReactNode;
  mono?: boolean;
}

export function EvidenceRow({ copyLabel, label, mono = false, trailing, value }: EvidenceRowProps) {
  return (
    <div className="ot-evidence-row">
      <dt>{label}</dt>
      <dd className={mono ? 'ot-mono' : undefined}>
        <span>{value}</span>
        {copyLabel ? <CopyButton label={copyLabel} value={value} /> : null}
        {trailing}
      </dd>
    </div>
  );
}

export function AddressDisplay({
  address,
  label = 'Address',
}: {
  address: string;
  label?: string;
}) {
  const visual = address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
  return (
    <span className="ot-mono">
      <span className="ot-sr-only">
        {label}: {address}
      </span>
      <span aria-hidden="true">{visual}</span>
    </span>
  );
}

export function ExternalProofLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="ot-proof-link" href={href} rel="noreferrer" target="_blank">
      {label}
      <span className="ot-sr-only"> (opens in a new tab)</span>
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}
