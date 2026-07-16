const PRIVATE_PATHS = [
  '/account',
  '/auth',
  '/checkout',
  '/judge',
  '/merchant',
  '/receipt',
  '/split',
  '/api',
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    PRIVATE_PATHS.some((path) => url.pathname.startsWith(path))
  )
    return;
  // Public navigation remains network-owned. No authenticated or transaction response is cached.
});
