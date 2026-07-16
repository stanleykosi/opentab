import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const evidencePath = path.join(
  root,
  'artifacts/autonomous-build/evidence/dependency-licenses.json',
);
const foundryPath = path.join(root, 'packages/contracts/foundry-dependencies.lock.json');
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md');

const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
const foundry = JSON.parse(fs.readFileSync(foundryPath, 'utf8'));
if (
  evidence.schemaVersion !== 2 ||
  !Array.isArray(evidence.packages) ||
  !/^[0-9a-f]{64}$/.test(evidence.lockfileSha256 ?? '') ||
  !/^[0-9a-f]{64}$/.test(evidence.foundryDependencyLockSha256 ?? '')
) {
  throw new Error('Dependency-license evidence has an unsupported shape.');
}
if (foundry.schemaVersion !== 1 || !Array.isArray(foundry.dependencies)) {
  throw new Error('Foundry dependency lock has an unsupported shape.');
}

function cell(value) {
  return String(value ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

const lines = [
  '# Third-Party Notices',
  '',
  `Generated from the exact production dependency graph locked by pnpm SHA-256 \`${evidence.lockfileSha256}\`. ` +
    'OpenTab does not modify or claim ownership of these packages. License texts remain in their installed packages and upstream source locations.',
  '',
  '## Review summary',
  '',
  `- npm production package/version records: ${evidence.packageVersionRecords}`,
  `- license categories: ${Object.entries(evidence.licenses)
    .map(([license, count]) => `${license} (${count})`)
    .join(', ')}`,
  `- copyleft review: ${evidence.copyleftReview.status}; unmodified replaceable dependencies: ${evidence.copyleftReview.packages.join(', ')}`,
  `- disposition: ${evidence.copyleftReview.disposition}`,
  '',
  'The LGPL packages require their license terms, notices, and corresponding-source/relinking rights to be preserved in any distribution. This automated inventory is not legal advice; the release owner must retain dependency license files in deployed artifacts and complete the project’s normal distribution review.',
  '',
  '## Reviewed metadata exceptions',
  '',
  '| Package | Resolved license | Exact package SHA-256 |',
  '|---|---|---|',
  ...evidence.reviewedExceptions.map(
    (item) =>
      `| ${cell(item.package)} | ${cell(item.resolvedLicense)} | \`${cell(item.sha256)}\` |`,
  ),
  '',
  '## Foundry libraries',
  '',
  '| Library | Tag | Commit | Source | License |',
  '|---|---|---|---|---|',
  ...foundry.dependencies.map((item) => {
    const license = item.name === 'openzeppelin-contracts' ? 'MIT' : 'MIT OR Apache-2.0';
    return `| ${cell(item.name)} | ${cell(item.tag)} | \`${cell(item.commit)}\` | ${cell(item.source)} | ${license} |`;
  }),
  '',
  '## npm production dependencies',
  '',
  '| Package | Version | License | Upstream/homepage |',
  '|---|---:|---|---|',
  ...evidence.packages.map(
    (item) =>
      `| ${cell(item.name)} | ${cell(item.version)} | ${cell(item.license)} | ${cell(item.homepage)} |`,
  ),
  '',
  '## OpenTab-created assets',
  '',
  'The OpenTab wordmark/icon SVGs, fallback/product illustrations, interface styling, copy, deterministic demo data, screenshots, and diagrams in this repository were created for OpenTab. Lucide icons are consumed through the MIT-licensed package listed above. No third-party photo, font file, music, or video asset is distributed by the application.',
  '',
];

fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
process.stdout.write(
  `Generated THIRD_PARTY_NOTICES.md with ${evidence.packages.length} npm records.\n`,
);
