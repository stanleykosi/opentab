import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/c/', '/m/', '/status'],
      disallow: ['/account', '/auth', '/checkout', '/judge', '/merchant', '/receipt', '/split'],
    },
  };
}
