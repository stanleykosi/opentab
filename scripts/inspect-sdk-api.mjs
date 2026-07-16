import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packages = [
  '@particle-network/universal-account-sdk',
  'magic-sdk',
  '@magic-ext/evm',
  '@magic-ext/oauth2',
  '@magic-sdk/admin',
  '@aws-sdk/client-kms',
  '@vercel/oidc-aws-credentials-provider',
  'viem',
  'ethers',
];

function findPackageJson(packageName) {
  const escaped = packageName.split('/');
  const candidates = [
    path.join(root, 'node_modules', ...escaped, 'package.json'),
    path.join(root, 'packages/integrations/node_modules', ...escaped, 'package.json'),
    path.join(root, 'apps/web/node_modules', ...escaped, 'package.json'),
  ];
  return candidates.find(fs.existsSync);
}
function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function declarationFiles(dir) {
  const files = [];
  const walk = (p, depth = 0) => {
    if (depth > 5 || !fs.existsSync(p)) return;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory() && !['node_modules', 'src'].includes(entry.name))
        walk(child, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.d.ts')) files.push(child);
    }
  };
  walk(dir);
  return files.sort();
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  packages: [],
};
let missing = false;
for (const name of packages) {
  const packageJsonPath = findPackageJson(name);
  if (!packageJsonPath) {
    report.packages.push({ name, installed: false });
    missing = true;
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const dir = path.dirname(packageJsonPath);
  const declarations = declarationFiles(dir).map((file) => ({
    file: path.relative(dir, file),
    sha256: hashFile(file),
    bytes: fs.statSync(file).size,
  }));
  const changelog = ['CHANGELOG.md', 'CHANGELOG', 'changelog.md']
    .map((f) => path.join(dir, f))
    .find(fs.existsSync);
  report.packages.push({
    name,
    installed: true,
    version: pkg.version,
    type: pkg.type ?? null,
    exports: pkg.exports ?? null,
    types: pkg.types ?? pkg.typings ?? null,
    declarations,
    changelog: changelog ? { file: path.basename(changelog), sha256: hashFile(changelog) } : null,
  });
}

const output = path.join(root, 'evidence', 'vendor', 'sdk-surface.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
if (fs.existsSync(output)) {
  try {
    const previous = JSON.parse(fs.readFileSync(output, 'utf8'));
    const previousSurface = { ...previous, generatedAt: undefined };
    const currentSurface = { ...report, generatedAt: undefined };
    if (JSON.stringify(previousSurface) === JSON.stringify(currentSurface)) {
      report.generatedAt = previous.generatedAt;
    }
  } catch {
    // Replace a malformed or legacy ledger with the freshly inspected surface.
  }
}
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${path.relative(root, output)}`);
if (missing) {
  console.error('One or more SDK packages are not installed. Run pnpm install first.');
  process.exit(1);
}
