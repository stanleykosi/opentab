import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'MANIFEST.json');
const ignoredDirectories = new Set([
  '.deploy-smoke',
  '.git',
  '.next',
  '.pnpm-store',
  '.turbo',
  'artifacts',
  'broadcast',
  'cache',
  'coverage',
  'dist',
  'lib',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
  'vendor-cache',
]);

function ignoredFile(name) {
  return (
    name === '.DS_Store' ||
    (name.startsWith('.env') && name !== '.env.example') ||
    name.endsWith('.pem') ||
    name.endsWith('.key')
  );
}

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (absolutePath === output || ignoredFile(entry.name)) continue;
    if (entry.isDirectory()) {
      walk(absolutePath);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = fs.readFileSync(absolutePath);
    files.push({
      path: path.relative(root, absolutePath).replaceAll(path.sep, '/'),
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
}

walk(root);
files.sort((left, right) => left.path.localeCompare(right.path));
let generatedAt = new Date().toISOString();
if (fs.existsSync(output)) {
  try {
    const previous = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (
      previous.schemaVersion === 1 &&
      previous.fileCount === files.length &&
      JSON.stringify(previous.files) === JSON.stringify(files) &&
      typeof previous.generatedAt === 'string'
    ) {
      generatedAt = previous.generatedAt;
    }
  } catch {
    // Replace a malformed or legacy manifest with the current reviewed tree.
  }
}
fs.writeFileSync(
  output,
  `${JSON.stringify({ schemaVersion: 1, generatedAt, fileCount: files.length, files }, null, 2)}\n`,
);
process.stdout.write(`Wrote MANIFEST.json with ${files.length} files.\n`);
