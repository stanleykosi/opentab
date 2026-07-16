import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sourceEntries = [
  '.github',
  '.node-version',
  '.nvmrc',
  'apps',
  'biome.json',
  'docker-compose.yml',
  'openapi',
  'package.json',
  'packages',
  'patches',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'railway.indexer.json',
  'scripts',
  'spikes',
  'tsconfig.base.json',
  'turbo.json',
];

const ignoredDirectories = new Set([
  '.next',
  '.turbo',
  'broadcast',
  'cache',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
]);

function includeFile(name) {
  return !(
    (name.startsWith('.env') && name !== '.env.example') ||
    name.endsWith('.key') ||
    name.endsWith('.pem')
  );
}

function collectFiles(root, absolutePath, files) {
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    files.push({
      absolutePath,
      bytes: Buffer.from(`symlink:${fs.readlinkSync(absolutePath)}`),
    });
    return;
  }
  if (stat.isFile()) {
    if (includeFile(path.basename(absolutePath))) {
      files.push({ absolutePath, bytes: fs.readFileSync(absolutePath) });
    }
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    collectFiles(root, path.join(absolutePath, entry.name), files);
  }
}

export function computeReleaseSourceFingerprint(root) {
  const files = [];
  for (const entry of sourceEntries) {
    const absolutePath = path.join(root, entry);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Release fingerprint input is missing: ${entry}`);
    }
    collectFiles(root, absolutePath, files);
  }

  files.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  const hash = crypto.createHash('sha256');
  hash.update('opentab-release-source-v1\0');
  for (const file of files) {
    const relativePath = path.relative(root, file.absolutePath).replaceAll(path.sep, '/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(file.bytes.length));
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }

  return { fileCount: files.length, sha256: hash.digest('hex') };
}
