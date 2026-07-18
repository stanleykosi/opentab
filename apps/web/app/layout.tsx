import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { OfflineBanner } from '../src/components/offline-banner';
import { PwaRegistration } from '../src/components/pwa-registration';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'OpenTab · Walletless checkout for real-world commerce',
    template: '%s · OpenTab',
  },
  description:
    'Create one link or QR, let customers pay from supported digital-asset balances, and treat an order as paid only after canonical settlement.',
  applicationName: 'OpenTab',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: '/icon.svg',
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'OpenTab' },
  formatDetection: { telephone: false },
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
