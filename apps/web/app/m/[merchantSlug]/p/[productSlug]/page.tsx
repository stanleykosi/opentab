import { permanentRedirect } from 'next/navigation';

export default async function LegacyProductPage({
  params,
}: {
  params: Promise<{ merchantSlug: string; productSlug: string }>;
}) {
  const { merchantSlug, productSlug } = await params;
  permanentRedirect(`/c/${encodeURIComponent(merchantSlug)}/${encodeURIComponent(productSlug)}`);
}
