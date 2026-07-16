import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ACCEPTED_LICENSES = new Set([
  '(MIT AND Zlib)',
  '(MIT OR Apache-2.0)',
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'Unlicense',
]);

const REVIEWED_UNKNOWN = new Map([
  [
    'eyes@0.1.8',
    {
      file: 'LICENSE',
      license: 'MIT',
      sha256: 'e424cbb68485fe465f6e58959da4bf157e5a0e716c02cd8d9a2041a12520fb93',
    },
  ],
  [
    'text-encoding-utf-8@1.0.2',
    {
      file: 'LICENSE.md',
      license: 'Unlicense with WHATWG attribution notice',
      sha256: 'caecf721eb8d6c1d74e57a798ef53d9cbeb58fc637af1877741a5572455206ec',
    },
  ],
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  process.stderr.write(`Dependency license verification failed: ${message}\n`);
  process.exit(1);
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const catalog = JSON.parse(raw);
const reviewedExceptions = [];
const packages = [];

for (const [license, records] of Object.entries(catalog)) {
  if (!Array.isArray(records)) fail(`pnpm returned a non-array ${license} group`);
  if (license !== 'Unknown' && !ACCEPTED_LICENSES.has(license)) {
    fail(`unreviewed production license category ${license}`);
  }
  for (const record of records) {
    for (const version of record.versions ?? []) {
      const key = `${record.name}@${version}`;
      if (license === 'Unknown') {
        const review = REVIEWED_UNKNOWN.get(key);
        const packagePath = record.paths?.[0];
        if (review === undefined || typeof packagePath !== 'string') {
          fail(`unknown license metadata for ${key}`);
        }
        const licenseText = readFileSync(join(packagePath, review.file));
        const digest = sha256(licenseText);
        if (digest !== review.sha256) {
          fail(`reviewed license text changed for ${key}`);
        }
        reviewedExceptions.push({ package: key, resolvedLicense: review.license, sha256: digest });
      }
      packages.push({
        name: record.name,
        version,
        license:
          license === 'Unknown' ? (REVIEWED_UNKNOWN.get(key)?.license ?? 'Unknown') : license,
        ...(typeof record.homepage === 'string' ? { homepage: record.homepage } : {}),
      });
    }
  }
}

packages.sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);
const licenses = Object.fromEntries(
  Object.entries(catalog)
    .filter(([license]) => license !== 'Unknown')
    .map(([license, records]) => [
      license,
      records.reduce((count, record) => count + (record.versions?.length ?? 0), 0),
    ])
    .concat([['Reviewed package-metadata exceptions', reviewedExceptions.length]])
    .sort(([left], [right]) => left.localeCompare(right)),
);

const evidence = {
  schemaVersion: 2,
  lockfileSha256: sha256(readFileSync(join(process.cwd(), 'pnpm-lock.yaml'))),
  foundryDependencyLockSha256: sha256(
    readFileSync(join(process.cwd(), 'packages', 'contracts', 'foundry-dependencies.lock.json')),
  ),
  command: 'pnpm licenses list --prod --json',
  packageVersionRecords: packages.length,
  licenses,
  reviewedExceptions,
  copyleftReview: {
    status: 'reviewed',
    packages: packages
      .filter((entry) => entry.license.startsWith('LGPL-'))
      .map((entry) => `${entry.name}@${entry.version}`),
    disposition:
      'Unmodified third-party libraries remain replaceable dependencies; their notices and corresponding source locations are preserved.',
  },
  packages,
};

const outputDirectory = join(process.cwd(), 'artifacts', 'autonomous-build', 'evidence');
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  join(outputDirectory, 'dependency-licenses.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o644 },
);

process.stdout.write(
  `Dependency licenses verified: ${packages.length} package/version records, ${reviewedExceptions.length} reviewed metadata exceptions.\n`,
);
