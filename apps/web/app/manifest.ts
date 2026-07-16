import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OpenTab',
    short_name: 'OpenTab',
    description: 'Calm checkout, receipts, passes, and merchant settlement.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f2f6f2',
    theme_color: '#14231e',
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/maskable-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
