import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { OfflineBanner } from '../src/components/offline-banner';
import { PwaRegistration } from '../src/components/pwa-registration';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'OpenTab', template: '%s · OpenTab' },
  description:
    'One calm checkout from your available digital-asset balance, with a trustworthy receipt and pass.',
  applicationName: 'OpenTab',
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
