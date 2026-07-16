'use client';

import { Button, CopyButton, InlineAlert } from '@opentab/ui';
import Image from 'next/image';
import { useEffect, useState } from 'react';

export function QrShareCard({ title, url }: { title: string; url: string }) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void import('qrcode')
      .then((qr) => qr.toDataURL(url, { errorCorrectionLevel: 'H', margin: 2, width: 640 }))
      .then((value) => {
        if (active) setDataUrl(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <section className="qr-card">
      <div className="qr-card__image">
        {dataUrl ? (
          <Image
            alt={`QR code for ${title} checkout`}
            height={240}
            src={dataUrl}
            unoptimized
            width={240}
          />
        ) : (
          <span aria-label="Generating QR code" className="qr-placeholder" role="status">
            {error ? 'QR unavailable' : 'Generating…'}
          </span>
        )}
      </div>
      <div>
        <p className="eyebrow">Checkout QR</p>
        <h2>Share {title}</h2>
        <p>Customers can scan this code or use the exact link below.</p>
        <p className="mono qr-link">{url}</p>
        {error ? (
          <InlineAlert title="QR could not be generated" tone="warning">
            <p>The direct link still works and can be copied.</p>
          </InlineAlert>
        ) : null}
        <div className="page-actions">
          <CopyButton label="Copy checkout link" value={url} />
          {dataUrl ? (
            <a
              className="ot-button ot-button--secondary"
              download={`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-qr.png`}
              href={dataUrl}
            >
              Download QR
            </a>
          ) : null}
          <Button onClick={() => window.print()} variant="quiet">
            Print
          </Button>
        </div>
      </div>
    </section>
  );
}
