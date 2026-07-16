import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'docs/09-vendor/sources.json');
const index = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const results = [];
for (const source of index.sources) {
  try {
    const response = await fetch(source.url, {
      redirect: 'follow',
      headers: { 'user-agent': 'OpenTab-doc-metadata/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    results.push({
      vendor: source.vendor,
      title: source.title,
      url: source.url,
      finalUrl: response.url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
      retrievedAt: new Date().toISOString(),
    });
  } catch (error) {
    results.push({
      vendor: source.vendor,
      title: source.title,
      url: source.url,
      error: error instanceof Error ? error.message : String(error),
      retrievedAt: new Date().toISOString(),
    });
  }
}
const output = path.join(root, 'evidence/vendor/source-metadata.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, results }, null, 2) + '\n');
console.log(`Wrote ${path.relative(root, output)}. Full vendor pages were not vendored.`);
