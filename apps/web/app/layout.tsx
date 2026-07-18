import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { OfflineBanner } from '../src/components/offline-banner';
import { PwaRegistration } from '../src/components/pwa-registration';
import './globals.css';

const title = 'OpenTab · Walletless checkout for real-world commerce';
const description =
  'Create one link or QR, let customers pay from supported digital-asset balances, and treat an order as paid only after confirmed settlement.';

function resolveMetadataBase() {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000');
  } catch {
    return new URL('http://localhost:3000');
  }
}

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: {
    default: title,
    template: '%s · OpenTab',
  },
  description,
  applicationName: 'OpenTab',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'OpenTab' },
  formatDetection: { telephone: false },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    title,
    description,
    siteName: 'OpenTab',
    images: [
      {
        url: '/brand/opentab-social-card.png',
        width: 1200,
        height: 630,
        alt: 'OpenTab — Sell anywhere. Settle with certainty.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: ['/brand/opentab-social-card.png'],
  },
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#2457ED',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <OfflineBanner />
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
